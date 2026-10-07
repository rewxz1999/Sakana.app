package app.sakana.receiver

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService

private const val TAG = "SakanaCoverPrefetch"

/**
 * 同步完成后的**后台预取**：把收藏里"还没有缓存"的封面按小并发抓一遍。
 *
 * 为什么要预取：不预取的话，用户滚到哪儿才下哪儿 —— 一屏一屏地等图出现，
 * 体感就是"每次打开都要重新加载"。预取让"滚到就有"。
 *
 * 三个硬性约束（缺一个都会把好事做成坏事）：
 *
 * ① **已有的一个都不许重复抓**：先查内存、再查磁盘（[CoverLoader.fetchIntoCache] 里做），
 *    命中就立刻跳过。所以第二次冷启动、以及同步后第二次触发，实际发出的请求数接近 0。
 *
 * ② **不阻塞界面、界面销毁能停**：跑在自己的 2 线程池里（不是主线程，也不占用
 *    可见加载的那 3 个线程），并且每张图之前都检查一次取消标记；
 *    `MainActivity.onDestroy` 会调 [cancel]，退到后台/关掉界面就不再继续抓。
 *
 * ③ **计费网络（移动数据）下不自动预取**：预取是"为了体验提前下流量"，
 *    在用户按流量付费的网络上一口气抓几十张封面是不能接受的 —— 这不是省我们自己的流量，
 *    是花用户的钱。所以这种情况下直接跳过，等有了 Wi-Fi 再说；
 *    用户真正滚到某张封面时照常按需加载（那是用户主动要看，不算浪费）。
 *
 * 并发定 2：够快，又不会把图床/带宽打满，更不会和可见加载抢线程抢到列表卡顿。
 */
internal object CoverPrefetch {

    private const val CONCURRENCY = 2

    /** 单轮上限：收藏可能上千条，一轮全抓完太激进，剩下的留到下次同步后的下一轮。 */
    private const val MAX_PER_RUN = 80

    /** 上一轮预取的结果，给设置页/日志看（可观测性：能知道到底抓了几张、其余为什么跳过）。 */
    internal data class Run(
        val candidates: Int,
        val fetched: Int,
        val cached: Int,
        val inFlight: Int,
        val cooling: Int,
        val failed: Int,
        val metered: Boolean,
        val cancelled: Boolean,
    )

    private var appContext: Context? = null

    @Volatile
    private var executor: ExecutorService? = null

    @Volatile
    private var cancelled = false

    @Volatile
    var lastRun: Run? = null
        private set

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * 开始一轮预取。[urls] 是"希望最终都有图"的地址（收藏的封面）。
     * 已经在跑一轮时直接返回 —— 不排队，避免同步频繁触发时越堆越多。
     */
    fun start(urls: List<String>) {
        val unique = urls.filter { it.isNotBlank() }.distinct()
        if (unique.isEmpty()) return
        synchronized(this) {
            if (executor != null) return
        }
        if (isMetered()) {
            lastRun = Run(unique.size, 0, 0, 0, 0, 0, metered = true, cancelled = false)
            Log.i(TAG, "当前是计费网络，跳过封面预取（${unique.size} 个候选）")
            return
        }

        val pool = Executors.newFixedThreadPool(CONCURRENCY) { runnable ->
            Thread(runnable, "sakana-cover-prefetch").apply { isDaemon = true }
        }
        cancelled = false
        synchronized(this) { executor = pool }

        pool.execute {
            var fetched = 0
            var cached = 0
            var inFlight = 0
            var cooling = 0
            var failed = 0
            val batch = unique.take(MAX_PER_RUN)
            try {
                for (url in batch) {
                    if (cancelled) break
                    // 按原因分类：只有 FETCHED 是真的发了请求，其余都是"故意没发"。
                    // 分清之后日志才有诊断价值 —— 否则只能写"跳过 80 张"，等于没说。
                    when (CoverLoader.warm(url)) {
                        CoverFetch.FETCHED -> fetched++
                        CoverFetch.CACHED -> cached++
                        CoverFetch.IN_FLIGHT -> inFlight++
                        CoverFetch.COOLING -> cooling++
                        CoverFetch.FAILED -> failed++
                    }
                }
            } catch (t: Throwable) {
                Log.d(TAG, "预取中断: ${t.message}")
            } finally {
                lastRun = Run(
                    candidates = batch.size,
                    fetched = fetched,
                    cached = cached,
                    inFlight = inFlight,
                    cooling = cooling,
                    failed = failed,
                    metered = false,
                    cancelled = cancelled,
                )
                Log.i(
                    TAG,
                    "封面预取结束：新抓 $fetched 张" +
                        "（已有 $cached / 正在取 $inFlight / 冷却中 $cooling / 失败 $failed）" +
                        "，共 ${batch.size} 个候选",
                )
                synchronized(this) {
                    executor = null
                    pool.shutdown()
                }
            }
        }
    }

    /**
     * 停止预取：置取消标记，正在飞的那一张会自然结束，后面的不再发起。
     * 不 `shutdownNow()` 硬杀的原因是硬杀会让正在写的文件半途而废；
     * 每张图之前检查标记已经足够快（预取本身不着急）。
     */
    fun cancel() {
        cancelled = true
    }

    val isRunning: Boolean get() = executor != null

    /**
     * 当前网络是不是**计费**网络（移动数据）。
     * 拿不到 ConnectivityManager 时返回 false（当成不计费）—— 宁可预取也不要不预取，
     * 因为拿不到这个服务本身就是异常情况，而 Wi-Fi 设备占绝大多数。
     */
    private fun isMetered(): Boolean {
        val context = appContext ?: return false
        return try {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            manager?.isActiveNetworkMetered ?: false
        } catch (t: Throwable) {
            Log.d(TAG, "判断计费网络失败: ${t.message}")
            false
        }
    }
}
