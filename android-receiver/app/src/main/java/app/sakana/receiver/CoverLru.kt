package app.sakana.receiver

/**
 * 磁盘封面缓存的一个条目（纯数据，由 [CoverDisk] 从目录里读出来）。
 *
 * [lastAccessMs] 用的是文件的**最后修改时间**：每次命中缓存读图时我们都会把它推到当前
 * （见 `CoverDisk.read`）。这样不用额外维护一份索引文件 —— 索引本身也要落盘、也要防损坏，
 * 而文件系统已经免费提供了"最后访问时间"这个信息。
 */
internal data class CoverFileInfo(val name: String, val bytes: Long, val lastAccessMs: Long)

/**
 * 磁盘封面的**容量上限与 LRU 淘汰计划**（纯逻辑，可在桌面上直接断言）。
 *
 * 为什么必须有上限：封面缓存是"只增不减"的。用户看一个季度番剧能攒下几千张图，
 * 没有上限的话它会一直涨到把设备的存储吃光 —— 而且它在 `cacheDir` 里，
 * 系统只有在**整体空间告急**时才会替我们清，那时已经晚了。
 *
 * 为什么定 300MB：一张 400px 的 JPEG 大约 30–50KB，300MB 能放六千到一万张，
 * 远超普通用户会遇到的量；同时又不会在 32GB/64GB 的设备上占掉一大块。
 *
 * 为什么**不**在每次写盘时扫目录：目录里几千个文件，逐个 `stat` 要几十毫秒，
 * 放在写盘路径上会直接拖慢列表滚动。所以改成"启动时清一次"，
 * 再加上一个"超过上限 1.2 倍才值得再扫一次"的保护阈值（写盘路径上只做一次计数判断）。
 */
internal object CoverLru {

    /** 磁盘封面缓存上限：300MB。 */
    const val MAX_DISK_BYTES: Long = 300L * 1024 * 1024

    /**
     * 清理目标 = 上限的 80%。
     * 为什么留这个余量：如果每次都刚好清到 100%，下次启动只要再多几张就又要清一遍，
     * 变成每次冷启动都扫目录。清到 80% 可以撑很久。
     */
    const val TRIM_TO_RATIO = 0.8

    /** 写盘路径上的保护阈值：超过上限的 1.2 倍才值得再扫一次目录。 */
    const val SOFT_LIMIT_FACTOR = 1.2

    fun totalBytes(files: List<CoverFileInfo>): Long = files.sumOf { it.bytes }

    /** 清理目标字节数。 */
    fun trimToBytes(): Long = (MAX_DISK_BYTES * TRIM_TO_RATIO).toLong()

    /** 超过软上限（上限的 1.2 倍）时才需要再扫一次目录做清理。 */
    fun needsTrim(currentBytes: Long): Boolean = currentBytes > (MAX_DISK_BYTES * SOFT_LIMIT_FACTOR).toLong()

    /**
     * 返回**该删掉的文件名**：最久没被访问的优先，删到剩余总量 ≤ [trimTo] 为止。
     *
     * 总量本来就没超就返回空列表 —— 调用方据此可以完全不做删除动作（也就不会动文件系统）。
     * 排序里第二关键字是文件名：`lastAccessMs` 撞车时保证结果稳定、可断言
     * （否则同样输入两次跑出来的删除列表可能不一样，测试会变成"偶尔失败"）。
     */
    fun evictOrder(files: List<CoverFileInfo>, trimTo: Long = trimToBytes()): List<String> {
        if (files.isEmpty()) return emptyList()
        var total = totalBytes(files)
        if (total <= trimTo) return emptyList()
        val doomed = ArrayList<String>()
        for (file in files.sortedWith(compareBy({ it.lastAccessMs }, { it.name }))) {
            if (total <= trimTo) break
            doomed.add(file.name)
            total -= file.bytes
        }
        return doomed
    }
}
