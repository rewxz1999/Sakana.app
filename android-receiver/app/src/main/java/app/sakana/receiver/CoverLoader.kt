package app.sakana.receiver

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import android.widget.ImageView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

private const val TAG = "SakanaCover"

/** 内存缓存上限：封面缩略图都不大，8MB 能放住一两百张。 */
private const val MAX_MEMORY_BYTES = 8 * 1024 * 1024

/** 单张图的体积上限，防止有人塞一个几十兆的图把内存顶爆。 */
private const val MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 解码目标宽度：网格里一格就一两百 dp，没必要按原图解。 */
private const val TARGET_WIDTH = 480

/**
 * 极小的异步封面加载器（内存 + 磁盘两级缓存）。
 *
 * 为什么不引 Glide/Coil：本工程不引任何第三方依赖，而封面只需要"下载一次、缩放、显示"，
 * 这段代码一百多行就够了；引图片库反而会带进一堆透明、注解处理器和体积。
 *
 * 磁盘缓存放在 `cacheDir/covers/`：系统空间紧张时会自动清掉，不需要我们管理。
 */
internal object CoverLoader {

    private var appContext: Context? = null

    private val memory = object : LruCache<String, Bitmap>(MAX_MEMORY_BYTES) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    private val executor = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "sakana-cover").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())

    /** 正在下载的地址，避免同一张图被排队下好几遍。 */
    private val inFlight = HashSet<String>()

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * 把 [url] 加载到 [view]。同一个 view 被复用到别的条目时会自动丢弃迟到的结果
     * （用 view.tag 记下"这个 view 现在要的是哪个地址"）。
     */
    fun load(url: String?, view: ImageView, placeholder: Int) {
        if (url.isNullOrBlank()) {
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
        view.setImageResource(placeholder)

        val started = synchronized(inFlight) {
            if (inFlight.contains(url)) false else inFlight.add(url)
        }
        if (!started) return

        executor.execute {
            try {
                val bitmap = fromDisk(url) ?: fromNetwork(url)?.also { saveToDisk(url, it) }
                if (bitmap != null) {
                    memory.put(url, bitmap)
                    main.post { applyIfStillWanted(url, view, bitmap) }
                }
            } catch (t: Throwable) {
                Log.d(TAG, "封面加载失败 $url: ${t.message}")
            } finally {
                synchronized(inFlight) { inFlight.remove(url) }
            }
        }
    }

    private fun applyIfStillWanted(url: String, view: ImageView, bitmap: Bitmap) {
        // 复用时 view.tag 早被改成别的地址了，这时把迟到的结果扔掉
        if (view.tag == url) view.setImageBitmap(bitmap)
    }

    private fun fileFor(url: String): File? {
        val dir = appContext?.let { File(it.cacheDir, "covers") } ?: return null
        if (!dir.exists() && !dir.mkdirs()) return null
        return File(dir, sha1(url) + ".img")
    }

    private fun fromDisk(url: String): Bitmap? {
        val file = fileFor(url) ?: return null
        if (!file.isFile || file.length() == 0L) return null
        return decode(file.readBytes())
    }

    private fun saveToDisk(url: String, bitmap: Bitmap) {
        val file = fileFor(url) ?: return
        try {
            // 存**缩放后**的 JPEG 而不是原始字节：省磁盘也省下次解码的时间
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        } catch (t: Throwable) {
            Log.d(TAG, "封面写盘失败: ${t.message}")
        }
    }

    private fun fromNetwork(url: String): Bitmap? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 6000
                readTimeout = 6000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "SakanaReceiver/1.0")
            }
            if (conn.responseCode !in 200..299) return null
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.size > MAX_IMAGE_BYTES) return null
            decode(bytes)
        } catch (t: Throwable) {
            Log.d(TAG, "封面下载失败 $url: ${t.message}")
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
                // 忽略
            }
        }
    }

    /** 两遍解码：先量尺寸算采样率，再真正解码，避免大图直接 OOM。 */
    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth)
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    private fun sampleSizeFor(width: Int): Int {
        var sample = 1
        var current = width
        while (current / 2 >= TARGET_WIDTH) {
            current /= 2
            sample *= 2
        }
        return sample
    }

    private fun sha1(text: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest(text.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
