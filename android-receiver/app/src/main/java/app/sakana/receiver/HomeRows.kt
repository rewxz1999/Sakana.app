package app.sakana.receiver

/**
 * 两个界面各自的"行模型"（纯逻辑，可在桌面上直接断言）。
 *
 * 上一版是"收藏 + 历史塞在同一个滚动区"，用分区标题 + 「查看全部」把历史折起来。
 * 现在分成两个独立界面之后，那些折叠/分区的东西全部不需要了：
 *   · 分区标题由**顶部 Tab** 承担（用户一眼就知道自己在哪个界面）；
 *   · 历史不再折 4 条 —— 它有自己的整屏，能一路滚到底；
 *   · 空态仍然是列表里的一行，这样"没有收藏"和"有收藏"走同一条渲染路径。
 *
 * 不变的一条硬规矩：**收藏一条都不许截断**（用户报过的"看不到其它收藏"就是数据侧被砍了）。
 */

/** 空态文案的类型；由适配器映射成 R.string.*（纯逻辑层不依赖 R）。 */
internal enum class HomeText { EMPTY_FAVORITES, EMPTY_HISTORY }

/** 两个界面共用的一行。 */
internal sealed class HomeRow {
    /** 空态（整行）。 */
    data class Empty(val kind: HomeText) : HomeRow()

    /** 收藏格子（收藏界面：两列网格里的一格）。 */
    data class FavoriteRow(val favorite: Favorite) : HomeRow()

    /** 历史卡片（历史界面：整行）；[cover] 是从收藏里按 subjectId 匹配到的封面。 */
    data class HistoryRow(val item: HistoryItem, val cover: String?) : HomeRow()
}

internal object HomeRows {

    /** 收藏界面：全部收藏，一条不少；空的时候给一行空态。 */
    fun favorites(favorites: List<Favorite>): List<HomeRow> {
        if (favorites.isEmpty()) return listOf(HomeRow.Empty(HomeText.EMPTY_FAVORITES))
        return favorites.map { HomeRow.FavoriteRow(it) }
    }

    /**
     * 历史界面：全部历史，同样不截断。
     * [covers] 是 `subjectId -> 封面地址`（来自 [coverIndex]）：
     * 历史本身不带封面，要靠收藏里那一份来补。
     */
    fun history(history: List<HistoryItem>, covers: Map<Int, String>): List<HomeRow> {
        if (history.isEmpty()) return listOf(HomeRow.Empty(HomeText.EMPTY_HISTORY))
        return history.map { HomeRow.HistoryRow(it, covers[it.subjectId]) }
    }

    /**
     * 从收藏里建一张 `subjectId -> 封面` 的表。
     * 没有 subjectId（电脑端没给）或没有封面的条目直接跳过 —— 历史卡片会退回占位图。
     */
    fun coverIndex(favorites: List<Favorite>): Map<Int, String> {
        val out = HashMap<Int, String>(favorites.size)
        favorites.forEach { if (it.subjectId > 0 && it.cover.isNotBlank()) out[it.subjectId] = it.cover }
        return out
    }
}
