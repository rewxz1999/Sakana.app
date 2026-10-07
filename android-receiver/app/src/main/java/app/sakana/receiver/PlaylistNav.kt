package app.sakana.receiver

/**
 * 播放列表的"切换目标"计算：纯逻辑，不碰播放器。
 *
 * 单独成文件的原因有两条：
 *  1. 规则模式下 playlist 里可能只有标题、没有地址，于是"下一集"必须**跳过**这些项，
 *     而不是撞上去再报错 —— 这是容易写错、也容易被忽略的一处；
 *  2. 它是纯函数，能在桌面上跑断言（见自测里的 PlaylistNav 部分），不需要模拟器。
 */
internal object PlaylistNav {

    /**
     * 从 [from] 往 [delta] 方向找**第一个有地址的**集，返回它的下标；找不到返回 -1。
     *
     * 到头就停住，**不循环**：循环会让"下一集"在最后一集之后莫名跳回第一集，
     * 用户看到的是一集没播完就开始重播，比"按了没反应"更让人困惑。
     */
    fun nextPlayable(items: List<PlayerController.Item>, from: Int, delta: Int): Int {
        if (items.isEmpty() || delta == 0) return -1
        var i = from + delta
        while (i in items.indices) {
            if (items[i].url.isNotBlank()) return i
            i += delta
        }
        return -1
    }

    /** 指定方向上还有没有能切的集（界面据此禁用上一集/下一集按钮）。 */
    fun canStep(items: List<PlayerController.Item>, from: Int, delta: Int): Boolean =
        nextPlayable(items, from, delta) >= 0

    /** 每一集有没有可播放的地址（规则模式下全是 false）。选集弹窗据此标出"点了也没用"的那些。 */
    fun playableFlags(items: List<PlayerController.Item>): List<Boolean> =
        items.map { it.url.isNotBlank() }
}
