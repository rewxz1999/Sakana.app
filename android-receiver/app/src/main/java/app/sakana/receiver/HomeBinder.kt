package app.sakana.receiver

import android.app.Activity
import android.graphics.Typeface
import android.view.View
import android.widget.Button
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * 首页：**顶部 Tab 切换的两个界面**（收藏 / 历史）。
 *
 * 为什么是两个 RecyclerView 而不是一个列表换数据：
 *  · **滚动位置各自独立** —— 每个 View 有自己的 LayoutManager 状态，切回来还停在原处，
 *    不需要自己记 offset、也不用 restoreState；
 *  · 两个界面要的布局本来就不同（收藏是两列网格，历史是整行卡片），
 *    硬塞进一个列表反而要为每行算 span size。
 *
 * 之前那次"收藏翻不动"的教训在这里继续生效：两个列表都是 `0dp + weight=1`，
 * 父容器给**精确高度**，所以能一路滚到底；**不要再改成 wrap_content**。
 */
internal class HomeBinder(
    private val activity: Activity,
    root: View,
    onPlayFavorite: (Favorite) -> Unit,
    onFavoriteDetails: (Favorite) -> Unit,
    onHistoryClick: (HistoryItem) -> Unit,
    onHistoryDetails: (HistoryItem) -> Unit,
) {

    /** 两个界面。用枚举而不是布尔，以后加第三个界面时不用改一堆 `if`。 */
    enum class Tab { FAVORITES, HISTORY }

    private val tabFavorites: Button = root.findViewById(R.id.tab_favorites)
    private val tabHistory: Button = root.findViewById(R.id.tab_history)
    private val favoritesList: RecyclerView = root.findViewById(R.id.rv_favorites)
    private val historyList: RecyclerView = root.findViewById(R.id.rv_history)

    private val favoritesAdapter = HomeAdapter(onPlayFavorite, onFavoriteDetails, onHistoryClick, onHistoryDetails)
    private val historyAdapter = HomeAdapter(onPlayFavorite, onFavoriteDetails, onHistoryClick, onHistoryDetails)

    private var tab = Tab.FAVORITES

    /** 上次渲染用的输入；一样就不重建，保住滚动位置（界面每秒都会调 refresh）。 */
    private var lastFavorites: List<Favorite>? = null
    private var lastHistory: List<HistoryItem>? = null

    init {
        // 收藏：两列网格；空态那一行占满两列（否则会缩成半格，看着像排版坏了）
        val grid = GridLayoutManager(activity, 2)
        grid.spanSizeLookup = favoritesAdapter.spanSizeLookup
        favoritesList.layoutManager = grid
        favoritesList.adapter = favoritesAdapter

        historyList.layoutManager = LinearLayoutManager(activity)
        historyList.adapter = historyAdapter

        // 关掉条目动画：数据每秒都可能刷新，开动画会看到莫名其妙的闪烁
        favoritesList.itemAnimator = null
        historyList.itemAnimator = null

        tabFavorites.setOnClickListener { showTab(Tab.FAVORITES) }
        tabHistory.setOnClickListener { showTab(Tab.HISTORY) }
        renderTabs()
        applyVisibility()
    }

    fun showTab(next: Tab) {
        if (next == tab) return
        tab = next
        renderTabs()
        applyVisibility()
    }

    fun currentTab(): Tab = tab

    fun refresh() {
        val favorites = SyncStore.favorites
        val history = SyncStore.history
        if (favorites == lastFavorites && history == lastHistory) return
        lastFavorites = favorites
        lastHistory = history

        favoritesAdapter.submit(HomeRows.favorites(favorites))
        // 历史本身不带封面：从收藏里按 subjectId 建一张表补上
        historyAdapter.submit(HomeRows.history(history, HomeRows.coverIndex(favorites)))
        renderTabs()
    }

    /** Tab 上带条数：不用切过去就知道那边有多少东西。 */
    private fun renderTabs() {
        tabFavorites.text = activity.getString(R.string.tab_favorites_count, SyncStore.favorites.size)
        tabHistory.text = activity.getString(R.string.tab_history_count, SyncStore.history.size)
        styleTab(tabFavorites, tab == Tab.FAVORITES)
        styleTab(tabHistory, tab == Tab.HISTORY)
    }

    private fun styleTab(button: Button, selected: Boolean) {
        // 选中：主色实心；未选中：描边。直接换背景 drawable，复用现成资源，不新增一套 style
        button.setBackgroundResource(
            if (selected) R.drawable.bg_button_primary else R.drawable.bg_button_outline,
        )
        button.setTextColor(activity.getColor(if (selected) R.color.surface else R.color.accent))
        button.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
    }

    private fun applyVisibility() {
        favoritesList.visibility = if (tab == Tab.FAVORITES) View.VISIBLE else View.GONE
        historyList.visibility = if (tab == Tab.HISTORY) View.VISIBLE else View.GONE
    }
}
