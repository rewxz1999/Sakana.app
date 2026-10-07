package app.sakana.receiver

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import android.widget.ImageView
import java.util.concurrent.Executors

private const val TAG = "SakanaCover"

/**
 * 内存缓存的上限：**按字节**算，不是按张数。
 * 张数限不住内存 —— 一张 400px 的 JPEG 解出来约 0.6MB（ARGB_8888），
 * 而一张原图缩下来的可能是 4MB，同样"100 张"能差出好几倍。
 */
private const val MAX_MEMORY_BYTES = 32 * 1024 * 1024

/** 同时不超过可用堆的 1/8：低内存设备上不该把整个 App 的堆都拿来放封面。 */
private const val MEMORY_HEAP_FRACTION = 8

/**
 * 极小的异步封面加载器：内存 LRU → 磁盘 → 网络，三级。
 *
 * 为什么自己写而不引 Glide/Coil：本工程不引任何第三方依赖，
 * 而封面只需要"下载一次、缩一下、存下来、显示出来"；引图片库会带进注解处理器、
 * 一堆透明 API 和几百 KB 体积，对我们这点需求是纯负担。
 *
 * 三级的分工：
 *  · **内存**（[LruCache] 按字节）—— 滚动时反复出现的封面命中这里，一次读取就画出来；
 *  · **磁盘**（[CoverDisk]）—— 冷启动/离线时的主力。命中就**绝不再发网络请求**，
 *    这是"不要每次打开都重新加载"和"离线也不显示空图"的实现；
 *  · **网络**（[CoverDownload]）—— 只有前两级都落空、且不在失败冷却期里才走。
 *
 * 另外做了三件容易被忽略但用户能直接感觉到的事：
 *  · 同一 URL 的并发请求**合流**成一次真请求（见 [CoverRequests]）；
 *  · `view.tag` 校验迟到结果，避免列表复用时"图串了"；
 *  · 失败退避，避免失效地址被刷屏式重试。
 */
internal object CoverLoader {

    /** "要不要发请求"的决策：并发合流 + 失败退避。 */
    private val requests = CoverRequests()

    /**
     * 内存缓存上限：取 "32MB" 和 "堆的 1/8" 的小者，且至少 2MB。
     * 用 `by lazy`：需要先把 [Runtime] 问一遍，不该在类初始化时就做（会影响启动速度）。
     */
    private val memoryCapBytes: Int by lazy {
        val heap = Runtime.getRuntime().maxMemory()
        minOf(MAX_MEMORY_BYTES.toLong(), heap / MEMORY_HEAP_FRACTION)
            .toInt()
            .coerceAtLeast(2 * 1024 * 1024)
    }

    private val memory = object : LruCache<String, Bitmap>(memoryCapBytes) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    private val executor = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "sakana-cover").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())

    /** 同一个地址正在等结果的所有 ImageView：发起者拿到图后广播给它们。 */
    private val waiters = HashMap<String, ArrayList<ImageView>>()

    /**
     * 初始化：磁盘目录 + **启动清理一次**。
     * 清理放在后台线程：目录里可能几千个文件，`stat` 一遍要几十毫秒，不该占着启动路径。
     */
    fun init(context: Context) {
        CoverDisk.init(context)
        CoverPrefetch.init(context)
        executor.execute { CoverDisk.trim() }
    }

    /**
     * 把 [url] 加载到 [view]。同一个 view 被复用到别的条目时会自动丢弃迟到的结果
     * （用 `view.tag` 记下"这个 view 现在要的是哪个地址"）。
     */
    fun load(url: String?, view: ImageView, placeholder: Int) {
        if (url.isNullOrBlank()) {
            // 没有地址就没得缓存 —— 这里必须早退，否则会把占位图当成一次真的取图任务
            view.tag = null
            view.setImageResource(placeholder)
            return
        }
        view.tag = url

        val hit = memory.get(url)
        if (hit != null) {
            view.setImageBitmap(hit)
            return
        }
        // 先摆占位图：宁可先给一张灰底，也不要让格子空着（"绝不显示空图"）
        view.setImageResource(placeholder)

        val owner = requests.begin(url)
        synchronized(waiters) {
            // 不管是不是发起者都要登记：结果要广播给**所有**等这个地址的 view
            waiters.getOrPut(url) { ArrayList(2) }.add(view)
        }
        if (!owner) return // 已经有人在取这个地址了，等他的结果就行

        executor.execute { fetch(url) }
    }

    /**
     * 取一次图并交给所有等待者。
     * 不管成功失败，`finally` 里都要把 [CoverRequests.end] 和等待者名单清掉 ——
     * 漏掉任何一个，这个地址就会永远卡在"有人正在取"上，之后再也加载不出来。
     */
    private fun fetch(url: String) {
        var bitmap: Bitmap? = null
        try {
            bitmap = resolve(url)
            if (bitmap != null) memory.put(url, bitmap)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) {
                // OOM 兜底：把内存缓存整个丢掉再放弃这一次。
                // 不这样做的话，一次大图解码失败会让后续每次加载都继续失败。
                memory.evictAll()
                Log.w(TAG, "封面解码内存不足，已清空内存缓存")
            } else {
                Log.d(TAG, "封面加载失败 $url: ${t.message}")
            }
        } finally {
            requests.end(url)
            broadcast(url, bitmap)
            // 磁盘可能已经超上限（这一张刚好是压垮它的那张），顺手判断一次
            if (bitmap != null) executor.execute { CoverDisk.trim() }
        }
    }

    /**
     * 把结果广播给所有等这个地址的 `ImageView`。
     *
     * 预取也要调它：如果预取先抢到了发起权，而用户正好同时滚到了同一张封面，
     * 那个 view 会登记成"等待者" —— 预取不广播的话它就会一直停在占位图上，
     * 直到下次绑定才恢复。这类"偶发空白"最难查，所以在源头堵掉。
     */
    private fun broadcast(url: String, bitmap: Bitmap?) {
        val targets = synchronized(waiters) { waiters.remove(url) } ?: return
        if (bitmap == null || targets.isEmpty()) return
        // 回到主线程再碰 View；此时 view.tag 可能已经被改成别的地址（列表复用），
        // 所以还要再校验一次，否则就会"图串了"
        main.post { targets.forEach { if (it.tag == url) it.setImageBitmap(bitmap) } }
    }

    /** 三级取图的真正实现。返回 null 表示这次没拿到（调用方保持占位图）。 */
    private fun resolve(url: String): Bitmap? {
        val fromMemory = memory.get(url)
        // 只在内存未命中时才读磁盘，省掉一次没必要的 I/O
        val fromDisk = if (fromMemory == null) CoverDisk.read(url) else null
        val source = decideCoverSource(
            hasMemory = fromMemory != null,
            hasDisk = fromDisk != null,
            networkAllowed = requests.shouldFetch(url, System.currentTimeMillis()),
        )
        /*
         * 命中磁盘时打一行 INFO。为什么用 INFO 而不是 DEBUG：真机（vivo）会把 DEBUG 日志丢掉，
         * 而"到底有没有走缓存"恰恰是真机上最需要能看见的一件事 ——
         * 冷启动只有屏幕上那几张会打，量很小，不会刷屏。
         */
        if (source == CoverSource.DISK) Log.i(TAG, "封面命中磁盘缓存：${CoverKeys.keyFor(url)}")
        return when (source) {
            CoverSource.MEMORY -> fromMemory

            CoverSource.DISK -> {
                val decoded = CoverDownload.decode(fromDisk!!)
                if (decoded == null) {
                    // 磁盘上是坏的（写到一半被杀、系统清过一半）：删掉，并且记一次失败
                    // 免得立刻又去下同一个地址、把坏循环套起来
                    CoverDisk.delete(url)
                    requests.noteFailure(url, System.currentTimeMillis())
                }
                decoded
            }

            CoverSource.NETWORK -> {
                val fetched = CoverDownload.fetch(url)
                if (fetched == null) {
                    requests.noteFailure(url, System.currentTimeMillis())
                } else {
                    requests.noteSuccess(url)
                    CoverDisk.write(url, fetched)
                }
                fetched
            }

            // 内存/磁盘都没有、又处在失败冷却期里：这次就别发请求了
            CoverSource.NONE -> {
                Log.i(TAG, "封面既无缓存也不允许请求（离线或失败冷却）：$url")
                null
            }
        }
    }

    /**
     * 把一张图抓进缓存（不绑任何 View）—— 预取专用。
     *
     * 内存或磁盘**已经有**的直接返回 [CoverFetch.CACHED]，所以"已有的一个都不许重复抓"
     * 是在这里保证的：预取方不需要自己判断，也不存在"判断完到开抓之间"的窗口。
     */
    fun warm(url: String): CoverFetch {
        if (url.isBlank()) return CoverFetch.FAILED
        if (memory.get(url) != null || CoverDisk.has(url)) return CoverFetch.CACHED
        if (!requests.begin(url)) return CoverFetch.IN_FLIGHT
        return try {
            if (!requests.shouldFetch(url, System.currentTimeMillis())) {
                CoverFetch.COOLING
            } else {
                val fetched = CoverDownload.fetch(url)
                if (fetched == null) {
                    requests.noteFailure(url, System.currentTimeMillis())
                    CoverFetch.FAILED
                } else {
                    requests.noteSuccess(url)
                    CoverDisk.write(url, fetched)
                    memory.put(url, fetched)
                    // 万一有 view 正等着这张（用户在预取的同时滚到了它），顺手交付，
                    // 别让它一直停在占位图上
                    broadcast(url, fetched)
                    CoverFetch.FETCHED
                }
            }
        } catch (t: Throwable) {
            Log.d(TAG, "预取失败 $url: ${t.message}")
            CoverFetch.FAILED
        } finally {
            requests.end(url)
        }
    }

    /**
     * 系统/应用内存紧张时把内存缓存整个丢掉。
     * 丢掉是安全的：磁盘还在，下次显示会从磁盘读回来（几十毫秒），用户几乎看不出来；
     * 而硬撑着不丢，下一次大图解码就可能是 OOM。
     */
    fun onLowMemory() {
        Log.i(TAG, "内存紧张，清空封面内存缓存（磁盘缓存保留）")
        memory.evictAll()
    }

    /** 磁盘缓存的真实占用，给设置页显示。 */
    fun stats(): CoverCacheStats = CoverDisk.stats()

    /**
     * 清理**图片**缓存（内存 + 磁盘），返回删掉的张数。
     * 只碰 `covers/`：收藏数据在 `SyncStore`（SharedPreferences）里，不受影响。
     */
    fun clearAll(): Int {
        memory.evictAll()
        return CoverDisk.clear()
    }

    /** 后台预取：把缺图的封面抓一遍。计费网络下会被 [CoverPrefetch] 跳过。 */
    fun prefetchMissing(urls: List<String>) {
        CoverPrefetch.start(urls)
    }

    fun cancelPrefetch() {
        CoverPrefetch.cancel()
    }
}
