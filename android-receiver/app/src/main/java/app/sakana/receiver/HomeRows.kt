package app.sakana.receiver

/**
 * 首页列表的"行模型"。
 *
 * 为什么要有这一层：首页现在是**一个 RecyclerView**（固定状态卡 + 单个滚动区），
 * 所有内容（分区标题、收藏格子、历史卡片、空态、动作行）都是这个列表里的一行。
 * 把"数据 → 行列表"这一步抽成**纯函数**（不碰任何 Android API）有两个好处：
 *   · 能直接在桌面上跑断言，验证"喂进去 10 条收藏，列表里就有 10 个收藏行"
 *     —— 这正好是用户报的"收藏翻不动、看不到其它收藏"那条 bug 的数据侧证据；
 *   · 适配器只剩"把行画出来"，没有再多的判断。
 */

/** 行里用到的文案类型；由适配器映射成 R.string.*（这样纯逻辑层不需要依赖 R）。 */
internal enum class HomeText {
    SECTION_FAVORITES,
    SECTION_HISTORY,
    EMPTY_FAVORITES,
    EMPTY_HISTORY,
    VIEW_ALL_HISTORY,
    COLLAPSE_HISTORY,
}

/** 首页列表里的一行。*/
internal sealed class HomeRow {
    /** 分区标题（整行）。 */
    data class Section(val kind: HomeText, val count: Int) : HomeRow()

    /** 空态文案（整行）。 */
    data class Empty(val kind: HomeText) : HomeRow()

    /** 收藏格子（半行，两列网格里的一格）。 */
    data class FavoriteRow(val favorite: Favorite) : HomeRow()

    /** 历史卡片（整行）；[cover] 是从收藏里按 subjectId 匹配到的封面，没有就是 null。 */
    data class HistoryRow(val item: HistoryItem, val cover: String?) : HomeRow()

    /** 动作行（整行）：「查看全部 N 条」/「收起」。 */
    data class Action(val kind: HomeText, val count: Int) : HomeRow()
}

internal object HomeRows {

    /**
     * 首页先显示几条历史，其余折叠到「查看全部」后面。
     *
     * 为什么不新开一个"全部历史"页面：历史条目通常几十条以内，展开即可；
     * 多一个 Activity 就多一份生命周期与状态同步（而且返回时要刷新首页），
     * 收益不抵复杂度。展开后依然在同一个 RecyclerView 里滚，不需要额外处理。
     */
    const val HISTORY_PREVIEW = 4

    /**
     * 把数据摊平成一行一行的列表。
     *
     * ⚠️ 这里**不做任何截断**：收藏全部进列表（用户报的 bug 就是"看不到其它收藏"）。
     * 只有历史会按 [HISTORY_PREVIEW] 折叠，且随时可以展开。
     */
    fun build(
        favorites: List<Favorite>,
        history: List<HistoryItem>,
        historyExpanded: Boolean,
    ): List<HomeRow> {
        val rows = ArrayList<HomeRow>(favorites.size + history.size + 6)

        // ---- 收藏 ----
        rows.add(HomeRow.Section(HomeText.SECTION_FAVORITES, favorites.size))
        if (favorites.isEmpty()) {
            rows.add(HomeRow.Empty(HomeText.EMPTY_FAVORITES))
        } else {
            // 一条都不少：全部交给 RecyclerView（它自己会回收）
            favorites.forEach { rows.add(HomeRow.FavoriteRow(it)) }
        }

        // ---- 观看历史 ----
        rows.add(HomeRow.Section(HomeText.SECTION_HISTORY, history.size))
        if (history.isEmpty()) {
            rows.add(HomeRow.Empty(HomeText.EMPTY_HISTORY))
            return rows
        }
        // 封面按 subjectId 到收藏里找；找不到（比如电脑端没给 id）就显示占位图
        val coverOf = HashMap<Int, String>()
        favorites.forEach { if (it.subjectId > 0 && it.cover.isNotBlank()) coverOf[it.subjectId] = it.cover }

        val shown = if (historyExpanded) history else history.take(HISTORY_PREVIEW)
        shown.forEach { rows.add(HomeRow.HistoryRow(it, coverOf[it.subjectId])) }

        if (history.size > HISTORY_PREVIEW) {
            rows.add(
                if (historyExpanded) {
                    HomeRow.Action(HomeText.COLLAPSE_HISTORY, history.size)
                } else {
                    HomeRow.Action(HomeText.VIEW_ALL_HISTORY, history.size)
                },
            )
        }
        return rows
    }
}
