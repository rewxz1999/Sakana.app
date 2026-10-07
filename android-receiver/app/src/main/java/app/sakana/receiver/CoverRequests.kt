package app.sakana.receiver

/**
 * 取一张封面时"到底该从哪儿拿"的决策结果。
 * 顺序是**死的**：内存 → 磁盘 → 网络。磁盘命中就绝不再发网络请求
 * （离线也要有图，而且图床挂了不该让已经缓存好的封面跟着消失）。
 */
internal enum class CoverSource { MEMORY, DISK, NETWORK, NONE }

/**
 * 取图来源的决策（纯逻辑，可在桌面上直接断言）。
 *
 * [hasMemory] 内存命中优先级最高：一次内存读取 + 一次 setImageBitmap 就完事，最快。
 * [hasDisk] 磁盘命中排第二，而且**压过网络** —— 这条是"离线/失败绝不显示空图"的实现，
 *   也是"不要每次打开都重新加载"的关键：只要以前下过，这次就一个请求都不发。
 * [networkAllowed] 只有前两者都落空、且没有处在失败冷却期里，才允许发请求。
 */
internal fun decideCoverSource(
    hasMemory: Boolean,
    hasDisk: Boolean,
    networkAllowed: Boolean,
): CoverSource = when {
    hasMemory -> CoverSource.MEMORY
    hasDisk -> CoverSource.DISK
    networkAllowed -> CoverSource.NETWORK
    else -> CoverSource.NONE
}

/**
 * 一次"取图"的结果。存在的意义是**可观测**：预取跑完后要能说清
 * "80 个候选里为什么一个新抓的都没有" —— 是都缓存过了（好事）、
 * 还是都正在被别人取（合流生效）、还是全在失败冷却里（网络有问题）。
 * 没有这个区分，日志只能写"跳过 80 张"，等于什么都没说。
 */
internal enum class CoverFetch { FETCHED, CACHED, IN_FLIGHT, COOLING, FAILED }

/**
 * "这一次到底要不要真的发请求"的决策（纯逻辑，可在桌面上直接断言）。
 *
 * 它管两件用户明确抱怨过的事：
 *
 * ① **并发合流**：同一张封面会同时被好几个 `ImageView` 请求 —— 同一部番在收藏网格里、
 *    在观看历史里、在弹窗里各出现一次；`RecyclerView` 复用条目时也会连着请求好几遍。
 *    每个调用者各发一次请求的话，图床会看到一串一模一样的并发请求（还很占带宽）。
 *    [begin] 只让**第一个**调用者拿到 true，其余调用方只需登记成"等待者"，
 *    结果由发起者广播给它们 —— 同一个 URL 全局只真发一次。
 *
 * ② **失败退避**：同一个 URL 失败后的一段时间里不再重试。没有这层的话，
 *    失效地址（或断网）会在每次滚动/每次列表刷新时被重试一遍，变成刷屏式请求 ——
 *    用户说的"重复加载"正是这种。连续失败会退避得更久（60 秒 → 5 分钟 → 30 分钟封顶），
 *    但**永远不会永久拉黑**：地址可能只是临时抽风，过一阵还是要给它机会。
 *
 * 内置锁：这些状态会被 3 个下载线程 + 主线程同时碰。
 */
internal class CoverRequests(
    private val firstBackoffMs: Long = 60_000L,
    private val maxBackoffMs: Long = 30L * 60_000L,
) {

    private val inFlight = HashSet<String>()
    private val failures = HashMap<String, Failure>()

    private class Failure(var count: Int, var atMs: Long)

    /** 认领一次取图任务：返回 true 表示"这次由你发请求"，false 表示"已经有人在取了"。 */
    @Synchronized
    fun begin(url: String): Boolean = inFlight.add(url)

    /** 取图结束（成功、失败、抛异常都要调，否则这个地址就永远卡在"有人正在取"上了）。 */
    @Synchronized
    fun end(url: String) {
        inFlight.remove(url)
    }

    @Synchronized
    fun isInFlight(url: String): Boolean = inFlight.contains(url)

    /** 现在允许对 [url] 发请求吗（不在失败冷却期里就算允许）。 */
    @Synchronized
    fun shouldFetch(url: String, nowMs: Long): Boolean {
        val failure = failures[url] ?: return true
        return nowMs - failure.atMs >= backoffFor(failure.count)
    }

    @Synchronized
    fun noteFailure(url: String, nowMs: Long) {
        val failure = failures[url]
        if (failure == null) {
            failures[url] = Failure(1, nowMs)
        } else {
            failure.count++
            failure.atMs = nowMs
        }
    }

    @Synchronized
    fun noteSuccess(url: String) {
        failures.remove(url)
    }

    /** 连续失败次数（0 = 没失败过）。退避长度由它决定，测试也用它。 */
    @Synchronized
    fun failureCount(url: String): Int = failures[url]?.count ?: 0

    /** 第 [count] 次连续失败后的冷却时长：每次 ×5，封顶 [maxBackoffMs]。 */
    fun backoffFor(count: Int): Long {
        var ms = firstBackoffMs
        var seen = 1
        while (seen < count && ms < maxBackoffMs) {
            ms *= 5
            seen++
        }
        return ms.coerceAtMost(maxBackoffMs)
    }
}
