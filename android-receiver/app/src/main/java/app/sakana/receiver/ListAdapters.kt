package app.sakana.receiver

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

/**
 * 收藏网格与观看历史列表的适配器。
 *
 * 为什么两个放一个文件：它们都是"数据 -> 几行文字 + 一张图"的简单列表，
 * 各自的 ViewHolder 只有几行；分两个文件反而更难对照着看。
 * 列表项复用 [CoverLoader]，滚动时不会因为"迟到的图片"串图（靠 view.tag 校验）。
 */

/** 收藏：两列网格，一格 = 封面 + 名字 + 评分/集数。 */
internal class FavoriteAdapter(
    private val onClick: (Favorite) -> Unit,
    private val onLongClick: (Favorite) -> Unit,
) : RecyclerView.Adapter<FavoriteAdapter.Holder>() {

    private var items: List<Favorite> = emptyList()

    fun submit(list: List<Favorite>) {
        items = list
        // 数据量是几百条以内，整表刷新足够；不做 DiffUtil 是为了少一层复杂度
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_favorite, parent, false)
        return Holder(view)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = items[position]
        holder.name.text = item.displayName
        val meta = ArrayList<String>(2)
        if (item.ratingText.isNotEmpty()) meta.add("★ ${item.ratingText}")
        if (item.eps > 0) meta.add("${item.eps} 集")
        if (item.airDate.isNotBlank()) meta.add(item.airDate)
        holder.meta.text = meta.joinToString(" · ")
        holder.meta.visibility = if (meta.isEmpty()) View.GONE else View.VISIBLE

        // 没有 subjectId 的条目点不了播（电脑端认不出是哪一部），如实标出来而不是假装能点
        val playable = item.subjectId > 0
        holder.itemView.alpha = if (playable) 1f else 0.55f
        holder.itemView.setOnClickListener { if (playable) onClick(item) else onLongClick(item) }
        holder.itemView.setOnLongClickListener { onLongClick(item); true }

        CoverLoader.load(item.cover, holder.cover, R.drawable.ic_cover_placeholder)
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val cover: ImageView = view.findViewById(R.id.fav_cover)
        val name: TextView = view.findViewById(R.id.fav_name)
        val meta: TextView = view.findViewById(R.id.fav_meta)
    }
}

/** 观看历史：横向排列的小卡片，带一条进度条。 */
internal class HistoryAdapter(
    private val onClick: (HistoryItem) -> Unit,
) : RecyclerView.Adapter<HistoryAdapter.Holder>() {

    private var items: List<HistoryItem> = emptyList()

    fun submit(list: List<HistoryItem>) {
        items = list
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_history, parent, false)
        return Holder(view)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = items[position]
        holder.title.text = item.title.ifBlank { "（无标题）" }
        val bits = ArrayList<String>(2)
        if (item.episode > 0) bits.add("第 ${item.episode} 集")
        if (item.duration > 0) {
            bits.add("${formatTime(item.position, "--:--")} / ${formatTime(item.duration, "--:--")}")
        } else if (item.position > 0) {
            bits.add(formatTime(item.position, "--:--"))
        }
        holder.meta.text = bits.joinToString(" · ")
        holder.progress.max = 1000
        holder.progress.progress =
            if (item.duration > 0) ((item.position * 1000 / item.duration).coerceIn(0, 1000)).toInt() else 0
        holder.itemView.setOnClickListener { onClick(item) }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val title: TextView = view.findViewById(R.id.hist_title)
        val meta: TextView = view.findViewById(R.id.hist_meta)
        val progress: ProgressBar = view.findViewById(R.id.hist_progress)
    }
}
