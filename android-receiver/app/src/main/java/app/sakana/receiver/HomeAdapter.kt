package app.sakana.receiver

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * 首页的唯一适配器：把 [HomeRows] 摊平出来的行画出来。
 *
 * 用 `GridLayoutManager(2)` + span size：收藏一格占 1 列（两列网格），
 * 分区标题 / 空态 / 历史卡片 / 动作行占满 2 列。这样**一个 RecyclerView** 就能同时
 * 装下网格和列表，不需要"ScrollView 里再套 RecyclerView"（那正是滚动失效的根因）。
 */
internal class HomeAdapter(
    private val onFavorite: (Favorite) -> Unit,
    private val onFavoriteLong: (Favorite) -> Unit,
    private val onHistory: (HistoryItem) -> Unit,
    private val onHistoryLong: (HistoryItem) -> Unit,
    private val onAction: (HomeText) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private var rows: List<HomeRow> = emptyList()

    /** 收藏占 1 列，其余整行 —— 交给 GridLayoutManager 用。 */
    val spanSizeLookup: GridLayoutManager.SpanSizeLookup =
        object : GridLayoutManager.SpanSizeLookup() {
            override fun getSpanSize(position: Int): Int =
                if (rows.getOrNull(position) is HomeRow.FavoriteRow) 1 else 2
        }

    fun submit(newRows: List<HomeRow>) {
        rows = newRows
        // 数据量是几百条以内，整表刷新足够；不做 DiffUtil 是为了少一层复杂度
        notifyDataSetChanged()
    }

    override fun getItemCount(): Int = rows.size

    override fun getItemViewType(position: Int): Int = when (rows[position]) {
        is HomeRow.Section -> TYPE_SECTION
        is HomeRow.Empty -> TYPE_EMPTY
        is HomeRow.FavoriteRow -> TYPE_FAVORITE
        is HomeRow.HistoryRow -> TYPE_HISTORY
        is HomeRow.Action -> TYPE_ACTION
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_SECTION -> SectionHolder(inflater.inflate(R.layout.item_section, parent, false))
            TYPE_EMPTY -> EmptyHolder(inflater.inflate(R.layout.item_empty, parent, false))
            TYPE_FAVORITE -> FavoriteHolder(inflater.inflate(R.layout.item_favorite, parent, false))
            TYPE_HISTORY -> HistoryHolder(inflater.inflate(R.layout.item_history, parent, false))
            else -> ActionHolder(inflater.inflate(R.layout.item_action, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = rows[position]) {
            is HomeRow.Section -> (holder as SectionHolder).bind(row)
            is HomeRow.Empty -> (holder as EmptyHolder).bind(row)
            is HomeRow.FavoriteRow -> (holder as FavoriteHolder).bind(row.favorite)
            is HomeRow.HistoryRow -> (holder as HistoryHolder).bind(row)
            is HomeRow.Action -> (holder as ActionHolder).bind(row)
        }
    }

    // ---------------- 各行的 ViewHolder ----------------

    private inner class SectionHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.section_title)
        private val count: TextView = view.findViewById(R.id.section_count)

        fun bind(row: HomeRow.Section) {
            title.setText(textOf(itemView.context, row.kind))
            count.text = if (row.count > 0) row.count.toString() else ""
        }
    }

    private inner class EmptyHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val label: TextView = view.findViewById(R.id.empty_text)

        fun bind(row: HomeRow.Empty) {
            label.setText(textOf(itemView.context, row.kind))
            label.setOnClickListener(null)
        }
    }

    private inner class ActionHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val label: TextView = view.findViewById(R.id.action_text)

        fun bind(row: HomeRow.Action) {
            // 「查看全部 N 条」要把条数填进去；「收起」不用
            label.text = if (row.kind == HomeText.VIEW_ALL_HISTORY) {
                itemView.context.getString(R.string.hist_view_all, row.count)
            } else {
                textOf(itemView.context, row.kind)
            }
            label.setOnClickListener { onAction(row.kind) }
        }
    }

    private inner class FavoriteHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val cover: ImageView = view.findViewById(R.id.fav_cover)
        private val name: TextView = view.findViewById(R.id.fav_name)
        private val meta: TextView = view.findViewById(R.id.fav_meta)

        fun bind(item: Favorite) {
            name.text = item.displayName
            val bits = ArrayList<String>(3)
            if (item.ratingText.isNotEmpty()) bits.add("★ ${item.ratingText}")
            if (item.eps > 0) bits.add(itemView.context.getString(R.string.hist_episode_badge, item.eps))
            if (item.airDate.isNotBlank()) bits.add(item.airDate)
            meta.text = bits.joinToString(" · ")
            meta.visibility = if (bits.isEmpty()) View.GONE else View.VISIBLE

            // 没有 subjectId 的条目点不了播（电脑端认不出是哪一部），如实变暗而不是假装能点
            val playable = item.subjectId > 0
            itemView.alpha = if (playable) 1f else 0.55f
            itemView.setOnClickListener { if (playable) onFavorite(item) else onFavoriteLong(item) }
            itemView.setOnLongClickListener { onFavoriteLong(item); true }

            CoverLoader.load(item.cover, cover, R.drawable.ic_cover_placeholder)
        }
    }

    private inner class HistoryHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val cover: ImageView = view.findViewById(R.id.hist_cover)
        private val title: TextView = view.findViewById(R.id.hist_title)
        private val episode: TextView = view.findViewById(R.id.hist_episode)
        private val time: TextView = view.findViewById(R.id.hist_time)
        private val progress: ProgressBar = view.findViewById(R.id.hist_progress)
        private val meta: TextView = view.findViewById(R.id.hist_meta)

        fun bind(row: HomeRow.HistoryRow) {
            val item = row.item
            title.text = item.title.ifBlank { itemView.context.getString(R.string.player_unknown_title) }

            // 「第 N 集」徽标：没集号就不显示，不要留一个空的色块
            if (item.episode > 0) {
                episode.visibility = View.VISIBLE
                episode.text = itemView.context.getString(R.string.hist_episode_badge, item.episode)
            } else {
                episode.visibility = View.GONE
            }

            time.text = relativeTime(itemView.context, item.watchedAt)

            progress.max = 1000
            progress.progress =
                if (item.duration > 0) ((item.position * 1000 / item.duration).coerceIn(0, 1000)).toInt() else 0

            val unknown = itemView.context.getString(R.string.time_unknown)
            meta.text = if (item.duration > 0) {
                "${formatTime(item.position, unknown)} / ${formatTime(item.duration, unknown)}"
            } else {
                formatTime(item.position, unknown)
            }

            CoverLoader.load(row.cover, cover, R.drawable.ic_cover_placeholder)
            itemView.setOnClickListener { onHistory(item) }
            itemView.setOnLongClickListener { onHistoryLong(item); true }
        }
    }

    /** 文案映射集中在这里：纯逻辑层（HomeRows）只给枚举，不依赖 R。 */
    private fun textOf(context: Context, kind: HomeText): String = when (kind) {
        HomeText.SECTION_FAVORITES -> context.getString(R.string.section_favorites)
        HomeText.SECTION_HISTORY -> context.getString(R.string.section_history)
        HomeText.EMPTY_FAVORITES -> context.getString(R.string.fav_empty)
        HomeText.EMPTY_HISTORY -> context.getString(R.string.hist_empty)
        HomeText.COLLAPSE_HISTORY -> context.getString(R.string.hist_collapse)
        // 带条数的「查看全部 N 条」在 ActionHolder 里单独拼（那里才拿得到 count）
        HomeText.VIEW_ALL_HISTORY -> context.getString(R.string.hist_view_all_generic)
    }

    private companion object {
        const val TYPE_SECTION = 0
        const val TYPE_EMPTY = 1
        const val TYPE_FAVORITE = 2
        const val TYPE_HISTORY = 3
        const val TYPE_ACTION = 4
    }
}
