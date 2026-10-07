package app.sakana.receiver

import android.app.Activity
import android.view.View
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * 首页滚动区：**一个** RecyclerView 装下收藏（两列网格）与观看历史（整行卡片）。
 *
 * 为什么这么改（用户报的 bug："同步过来的收藏翻不动，看不到其它收藏"）：
 * 原来首页是 `ScrollView > 收藏 RecyclerView(wrap_content) + 历史 RecyclerView(wrap_content)`。
 * 嵌在 ScrollView 里的 RecyclerView 拿到的是一张 **AT_MOST** 的高度约束，
 * LinearLayoutManager 只会布局"装得下"的那些项 —— 剩下的条目**根本没被创建**，
 * 所以不管怎么划都看不到；而两层都能滚又会抢手势，表现就是"翻不动"。
 * 换成单容器之后：只有一层滚动、所有条目都参与回收、手势自然归它管。
 *
 * 固定的状态卡与底栏留在 RecyclerView 之外（见 activity_main.xml），
 * 所以状态一直可见、底栏一直可点 —— 这是"单容器"方案额外换来的好处。
 */
internal class HomeBinder(
    activity: Activity,
    root: View,
    onPlayFavorite: (Favorite) -> Unit,
    onFavoriteDetails: (Favorite) -> Unit,
    onHistoryClick: (HistoryItem) -> Unit,
    onHistoryDetails: (HistoryItem) -> Unit,
) {

    private val recycler: RecyclerView = root.findViewById(R.id.rv_home)

    /** 历史是否已展开（默认只显示前几条 + 「查看全部」）。 */
    private var historyExpanded = false

    /** 上次渲染用的输入；一样就不重建，保住滚动位置（首页每秒都会调 refresh）。 */
    private var lastFavorites: List<Favorite>? = null
    private var lastHistory: List<HistoryItem>? = null
    private var lastExpanded = false

    private val adapter = HomeAdapter(
        onFavorite = onPlayFavorite,
        onFavoriteLong = onFavoriteDetails,
        onHistory = onHistoryClick,
        onHistoryLong = onHistoryDetails,
        onAction = { kind ->
            historyExpanded = kind == HomeText.VIEW_ALL_HISTORY
            refresh()
        },
    )

    init {
        val layoutManager = GridLayoutManager(activity, 2)
        layoutManager.spanSizeLookup = adapter.spanSizeLookup
        recycler.layoutManager = layoutManager
        recycler.adapter = adapter
        // 高度随内容变化（收藏网格 + 历史卡片），不能让 RecyclerView 假设自己尺寸固定
        recycler.setHasFixedSize(false)
        // 关掉条目动画：首页数据每秒都可能刷新，开动画会看到莫名其妙的闪烁
        recycler.itemAnimator = null
    }

    fun refresh() {
        val favorites = SyncStore.favorites
        val history = SyncStore.history
        if (favorites == lastFavorites && history == lastHistory && historyExpanded == lastExpanded) return
        lastFavorites = favorites
        lastHistory = history
        lastExpanded = historyExpanded
        adapter.submit(HomeRows.build(favorites, history, historyExpanded))
    }
}
