package app.sakana.receiver

import android.app.Activity
import android.view.View
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * 首页下半部分：收藏网格 + 观看历史 + 同步状态。
 *
 * 单独成类的原因：这一块有 3 个列表/文案视图、两个适配器、以及"数据没变就别重建"的
 * 判断（否则每秒钟 notifyDataSetChanged 会把用户的滚动位置一直弹回顶部）。
 * MainActivity 只需要在每秒的心跳里调一次 [refresh]。
 */
internal class HomeBinder(
    private val activity: Activity,
    root: View,
    private val onPlayFavorite: (Favorite) -> Unit,
    private val onFavoriteDetails: (Favorite) -> Unit,
    private val onHistoryClick: (HistoryItem) -> Unit,
) {

    private val rvFavorites: RecyclerView = root.findViewById(R.id.rv_favorites)
    private val rvHistory: RecyclerView = root.findViewById(R.id.rv_history)
    private val tvFavEmpty: TextView = root.findViewById(R.id.tv_fav_empty)
    private val tvHistEmpty: TextView = root.findViewById(R.id.tv_hist_empty)
    private val tvFavCount: TextView = root.findViewById(R.id.tv_fav_count)
    private val tvHistCount: TextView = root.findViewById(R.id.tv_hist_count)
    private val tvSyncStatus: TextView = root.findViewById(R.id.tv_sync_status)

    private val favAdapter = FavoriteAdapter(
        onClick = { onPlayFavorite(it) },
        onLongClick = { onFavoriteDetails(it) },
    )
    private val histAdapter = HistoryAdapter(onClick = { onHistoryClick(it) })

    /** 上次渲染过的数据：内容一样就不重建，保住滚动位置。 */
    private var lastFavorites: List<Favorite>? = null
    private var lastHistory: List<HistoryItem>? = null
    private var lastStatus: String? = null

    init {
        rvFavorites.layoutManager = GridLayoutManager(activity, 2)
        rvFavorites.adapter = favAdapter
        rvHistory.layoutManager = LinearLayoutManager(activity, RecyclerView.HORIZONTAL, false)
        rvHistory.adapter = histAdapter
        // 两个列表都嵌在 ScrollView 里（wrap_content + 关掉自身滚动），
        // 所以高度会随内容变化，不能让 RecyclerView 假设自己尺寸固定
        rvFavorites.setHasFixedSize(false)
        rvHistory.setHasFixedSize(false)
    }

    fun refresh() {
        val favorites = SyncStore.favorites
        if (favorites != lastFavorites) {
            lastFavorites = favorites
            favAdapter.submit(favorites)
            tvFavCount.text = if (favorites.isEmpty()) "" else favorites.size.toString()
            // 空态文案：不要留白屏（需求里点名要的）
            tvFavEmpty.visibility = if (favorites.isEmpty()) View.VISIBLE else View.GONE
            rvFavorites.visibility = if (favorites.isEmpty()) View.GONE else View.VISIBLE
        }

        val history = SyncStore.history
        if (history != lastHistory) {
            lastHistory = history
            histAdapter.submit(history)
            tvHistCount.text = if (history.isEmpty()) "" else history.size.toString()
            tvHistEmpty.visibility = if (history.isEmpty()) View.VISIBLE else View.GONE
            rvHistory.visibility = if (history.isEmpty()) View.GONE else View.VISIBLE
        }

        val status = syncStatusText(activity)
        if (status.text != lastStatus) {
            lastStatus = status.text
            tvSyncStatus.text = status.text
            tvSyncStatus.setTextColor(activity.getColor(if (status.error) R.color.warn else R.color.text_muted))
        }
    }
}
