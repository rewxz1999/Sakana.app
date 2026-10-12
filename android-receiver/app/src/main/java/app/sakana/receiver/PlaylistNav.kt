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
    fun nextPlayable(items: List<PlayerItem>, from: Int, delta: Int): Int {
        if (items.isEmpty() || delta == 0) return -1
        var i = from + delta
        while (i in items.indices) {
            if (items[i].url.isNotBlank()) return i
            i += delta
        }
        return -1
    }

    /** 指定方向上还有没有能切的集（界面据此禁用上一集/下一集按钮）。 */
    fun canStep(items: List<PlayerItem>, from: Int, delta: Int): Boolean =
        nextPlayable(items, from, delta) >= 0

    /** 每一集有没有可播放的地址（规则模式下全是 false）。选集弹窗据此标出"点了也没用"的那些。 */
    fun playableFlags(items: List<PlayerItem>): List<Boolean> =
        items.map { it.url.isNotBlank() }

    /**
     * 把一份 `/play` 载荷对齐到播放列表上，返回**该起播的下标**，并顺手修好列表。
     *
     * 电脑端给的数据不一定规整，三种情况都要接住：
     *  ① `index` 有效 → 就用它；
     *  ② `index` 无效但 `url` 能在列表里反查到 → 用反查到的下标（电脑端只发 url 不发 index 时走这条）；
     *  ③ 都认不出来 → 把这一集当成列表里新的一项追加进去（否则"单集直投"就没有列表可切）。
     *
     * 另外，**规则模式**下 playlist 里那一项只有标题、而主 `url` 才是当前这一集的真实地址，
     * 这时必须把地址补进列表那一项 —— 不补的话选集列表里当前这一集永远是"没有地址"，
     * 用户点上一集再点回来就播不了了。
     */
    fun resolvePlayIndex(items: MutableList<PlayerItem>, url: String, title: String, index: Int): Int {
        if (items.isEmpty()) {
            items.add(PlayerItem(url, title))
            return 0
        }
        var idx = index
        if (idx !in items.indices) idx = items.indexOfFirst { it.url == url }
        if (idx !in items.indices) {
            items.add(PlayerItem(url, title))
            return items.size - 1
        }
        if (items[idx].url.isBlank() && url.isNotBlank()) {
            items[idx] = items[idx].copy(url = url)
        }
        return idx
    }
}
