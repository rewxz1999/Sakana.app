package app.sakana.receiver

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * 收藏 / 历史两个界面共用的适配器（每种行一个 ViewHolder）。
 *
 * 为什么一个类给两个列表用：两个界面要画的行**互不重叠** ——
 * 收藏界面只会出现 `FavoriteRow` / `Empty`，历史界面只会出现 `HistoryRow` / `Empty`。
 * 所以同一份代码实例化两次即可，不需要维护两个几乎一样的适配器
 * （那种"复制一份改两行"最终一定会走样）。
 *
 * span size 只对收藏界面有意义：`GridLayoutManager(2)` 下收藏格占 1 列、空态占满 2 列；
 * 历史界面用的是 LinearLayoutManager，这个 lookup 根本不参与。
 */
internal class HomeAdapter(
    private val onFavorite: (Favorite) -> Unit,
    private val onFavoriteLong: (Favorite) -> Unit,
    private val onHistory: (HistoryItem) -> Unit,
    private val onHistoryLong: (HistoryItem) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private var rows: List<HomeRow> = emptyList()

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
        is HomeRow.Empty -> TYPE_EMPTY
        is HomeRow.FavoriteRow -> TYPE_FAVORITE
        is HomeRow.HistoryRow -> TYPE_HISTORY
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_EMPTY -> EmptyHolder(inflater.inflate(R.layout.item_empty, parent, false))
            TYPE_FAVORITE -> FavoriteHolder(inflater.inflate(R.layout.item_favorite, parent, false))
            else -> HistoryHolder(inflater.inflate(R.layout.item_history, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = rows[position]) {
            is HomeRow.Empty -> (holder as EmptyHolder).bind(row)
            is HomeRow.FavoriteRow -> (holder as FavoriteHolder).bind(row.favorite)
            is HomeRow.HistoryRow -> (holder as HistoryHolder).bind(row)
        }
    }

    // ---------------- 各行的 ViewHolder ----------------

    private inner class EmptyHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val label: TextView = view.findViewById(R.id.empty_text)

        fun bind(row: HomeRow.Empty) {
            label.setText(textOf(itemView.context, row.kind))
            label.setOnClickListener(null)
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

    private companion object {
        const val TYPE_EMPTY = 0
        const val TYPE_FAVORITE = 1
        const val TYPE_HISTORY = 2

        /** 空态文案（纯逻辑层只给类型，映射到字符串在这里做）。 */
        fun textOf(context: Context, kind: HomeText): String = context.getString(
            when (kind) {
                HomeText.EMPTY_FAVORITES -> R.string.fav_empty
                HomeText.EMPTY_HISTORY -> R.string.hist_empty
            },
        )
    }
}
