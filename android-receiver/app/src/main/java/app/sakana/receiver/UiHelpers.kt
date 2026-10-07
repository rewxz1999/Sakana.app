package app.sakana.receiver

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * 界面小工具：选集弹窗、剪贴板、时间格式化、同步状态文案。
 *
 * 单独一个文件（而不是全塞在 Activity 里）的原因：这些是"和播放状态无关的纯 UI 动作"，
 * Activity 只该负责"接线 + 刷新"，这类函数抽出来两边都更好读，也不会让 Activity 越过 300 行。
 * 全部是顶层函数：它们不需要持有状态，用哪个 Activity 就传哪个进来。
 *
 * 顶部那两行状态文字后来挪去了 `StatusText.kt`（见那里的说明）。
 */

/**
 * 选集弹窗。
 *
 * 用最朴素的 ListView + ArrayAdapter，不引 RecyclerView，也不单独写 Adapter 类。
 * 每一行除了标题还会标出来：
 *  · 「当前播放」—— 遥控到哪了，最直观的反馈；
 *  · 「规则模式 · 请在电脑上切集」—— 电脑端在规则模式下只能给标题、给不了地址，
 *    这种项点了也播不了，必须说清楚，而不是让用户点了没反应。
 */
internal fun showPlaylistDialog(
    activity: Activity,
    titles: List<String>,
    currentIndex: Int,
    playable: List<Boolean>,
    onSelect: (Int) -> Unit,
) {
    if (titles.isEmpty()) return

    // 先把每行要显示的文字拼好，getView 里就只剩上色，逻辑简单不易错
    val rows = titles.mapIndexed { i, t ->
        val marks = ArrayList<String>(2)
        if (i == currentIndex) marks.add(activity.getString(R.string.playlist_current))
        if (i !in playable.indices || !playable[i]) marks.add(activity.getString(R.string.playlist_no_url))
        if (marks.isEmpty()) t else "$t  ·  ${marks.joinToString(" · ")}"
    }

    val adapter = object : ArrayAdapter<String>(
        activity,
        R.layout.item_episode,
        R.id.episode_title,
        rows,
    ) {
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = super.getView(position, convertView, parent)
            val label = view.findViewById<TextView>(R.id.episode_title)
            val usable = position !in playable.indices || playable[position]
            when {
                position == currentIndex -> {
                    label.setTextColor(activity.getColor(R.color.accent))
                    label.setTypeface(null, Typeface.BOLD)
                }
                !usable -> {
                    // 播不了的项用暗色，顺手表明"选它也没用"
                    label.setTextColor(activity.getColor(R.color.text_muted))
                    label.setTypeface(null, Typeface.NORMAL)
                }
                else -> {
                    label.setTextColor(activity.getColor(R.color.text_primary))
                    label.setTypeface(null, Typeface.NORMAL)
                }
            }
            return view
        }
    }

    AlertDialog.Builder(activity)
        .setTitle(activity.getString(R.string.playlist_title, titles.size))
        .setAdapter(adapter) { _, which -> onSelect(which) }
        .setNegativeButton(R.string.close, null)
        .show()
}

/** 复制文本到剪贴板；返回是否成功（拿不到剪贴板服务时返回 false）。 */
internal fun copyToClipboard(activity: Activity, label: String, text: String): Boolean {
    val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
    manager.setPrimaryClip(ClipData.newPlainText(label, text))
    return true
}

// ---------------- 同步相关 ----------------

/** 同步状态行的文字 + 是否算"需要注意"（用警告色显示）。 */
internal data class SyncStatus(val text: String, val error: Boolean)

/**
 * 首页/设置页共用的同步状态文案。
 *
 * 优先级：正在做的事（解析播放源 / 同步中）> 出错 > 已连接 > 未连接。
 * "还没连过电脑"时要说清**怎么才能连上**，而不是干瘪地说"未连接"。
 *
 * 这一轮补上的关键一条：**离线时也必须说清"现在看到的是什么时候的缓存"**。
 * 用户看到的收藏/历史其实来自本机缓存（见 SyncStore），不说的话他会以为
 * "数据是刚同步的"，或者反过来以为"同步失败 = 数据没了"。所以离线/失败两种情况下
 * 都带上"缓存于 …"和条数。
 */
internal fun syncStatusText(activity: Activity): SyncStatus {
    SyncManager.statusMessage?.let { message ->
        if (SyncManager.busyCommand) return SyncStatus(message, false)
    }
    if (SyncManager.syncing) return SyncStatus(activity.getString(R.string.sync_status_syncing), false)
    SyncManager.lastError?.let {
        // 失败时先给原因，再补一句"数据还在，是缓存于 X 的"
        return SyncStatus(it + cacheSuffix(activity), true)
    }

    val base = SyncStore.syncUrl
    if (base.isNullOrBlank()) {
        if (!SyncStore.hasCachedData) return SyncStatus(activity.getString(R.string.sync_status_offline), false)
        return SyncStatus(cachedLine(activity), false)
    }

    val pc = SyncStore.pcName?.takeIf { it.isNotBlank() } ?: activity.getString(R.string.sync_pc_unknown)
    val at = SyncStore.lastSyncAt
    val whenText = if (at <= 0) {
        activity.getString(R.string.sync_never)
    } else {
        formatTime(System.currentTimeMillis() - at, activity.getString(R.string.sync_never))
            .let { activity.getString(R.string.sync_ago, it) }
    }
    return SyncStatus(
        activity.getString(
            R.string.sync_status_connected,
            pc,
            whenText,
            SyncStore.favorites.size,
            SyncStore.history.size,
        ),
        false,
    )
}

/**
 * "离线 · 缓存于 3 小时前 · 收藏 86 / 历史 14"。
 * 没有缓存过（全新安装、从没连上过电脑）时不显示这一行，避免"缓存于 0 秒前"这种鬼话。
 */
private fun cachedLine(activity: Activity): String {
    val at = SyncStore.cachedAt
    val whenText = if (at <= 0L) {
        activity.getString(R.string.sync_never)
    } else {
        formatTime(System.currentTimeMillis() - at, activity.getString(R.string.sync_never))
    }
    return activity.getString(
        R.string.sync_status_offline_cached,
        whenText,
        SyncStore.favorites.size,
        SyncStore.history.size,
    )
}

/** 拼在失败原因后面的缓存说明；没有缓存时是空串（不硬凑一句话）。 */
private fun cacheSuffix(activity: Activity): String {
    if (!SyncStore.hasCachedData) return ""
    return activity.getString(R.string.sync_offline_suffix, cacheAge(activity))
}

/**
 * "缓存于 3 小时前"（设置页的收藏/历史计数行后面会接上它）。
 * 没缓存过时返回空串 —— 新装的 App 上显示"缓存于 0 秒前"是自欺欺人。
 */
internal fun cacheAgeText(activity: Activity): String {
    if (!SyncStore.hasCachedData) return ""
    return "\n" + activity.getString(R.string.cache_cached_at, cacheAge(activity))
}

/** 本地数据的缓存时间描述（相对时间）。 */
private fun cacheAge(activity: Activity): String {
    val at = SyncStore.cachedAt
    return if (at <= 0L) {
        activity.getString(R.string.sync_never)
    } else {
        formatTime(System.currentTimeMillis() - at, activity.getString(R.string.sync_never))
    }
}

/**
 * 收藏条目的详情弹窗（长按触发）。
 * 只显示电脑端给到的字段；**没有 subjectId 时明确说明"这部在电脑上点不了"**，
 * 而不是让用户点了播不出来还不知道为什么。
 */
internal fun showFavoriteDialog(activity: Activity, favorite: Favorite) {
    val lines = ArrayList<String>(6)
    if (favorite.name.isNotBlank()) lines.add(activity.getString(R.string.fav_detail_name, favorite.name))
    if (favorite.ratingText.isNotEmpty()) lines.add(activity.getString(R.string.fav_detail_rating, favorite.ratingText))
    if (favorite.eps > 0) lines.add(activity.getString(R.string.fav_detail_eps, favorite.eps))
    if (favorite.airDate.isNotBlank()) lines.add(activity.getString(R.string.fav_detail_air, favorite.airDate))
    if (favorite.genres.isNotEmpty()) lines.add(activity.getString(R.string.fav_detail_genres, favorite.genres.joinToString("、")))
    lines.add(
        if (favorite.subjectId > 0) {
            activity.getString(R.string.fav_detail_id, favorite.subjectId)
        } else {
            activity.getString(R.string.fav_detail_no_id)
        },
    )

    AlertDialog.Builder(activity)
        .setTitle(favorite.displayName)
        .setMessage(lines.joinToString("\n"))
        .setPositiveButton(R.string.close, null)
        .show()
}

/**
 * 观看历史的详情弹窗（长按触发）：显示完整信息，并提供「删除这条记录」。
 *
 * 删除只动**本机**历史（电脑端的那份不动）—— 接收端没有"删除电脑历史"的接口，
 * 而且用户在这里想清理的多半是设备上的这份记录。
 */
internal fun showHistoryDialog(activity: Activity, item: HistoryItem, onChanged: () -> Unit) {
    val unknown = activity.getString(R.string.time_unknown)
    val lines = ArrayList<String>(5)
    lines.add(
        activity.getString(
            R.string.hist_detail_title_line,
            item.title.ifBlank { activity.getString(R.string.player_unknown_title) },
        ),
    )
    if (item.episode > 0) lines.add(activity.getString(R.string.hist_detail_episode, item.episode))
    lines.add(
        activity.getString(
            R.string.hist_detail_position,
            formatTime(item.position, unknown),
            formatTime(item.duration, unknown),
        ),
    )
    lines.add(activity.getString(R.string.hist_detail_watched, relativeTime(activity, item.watchedAt)))
    lines.add(
        if (item.subjectId > 0) {
            activity.getString(R.string.hist_detail_id, item.subjectId)
        } else {
            activity.getString(R.string.hist_detail_no_id)
        },
    )

    AlertDialog.Builder(activity)
        .setTitle(R.string.hist_detail_title)
        .setMessage(lines.joinToString("\n"))
        .setPositiveButton(R.string.close, null)
        .setNeutralButton(R.string.hist_delete) { _, _ ->
            SyncStore.removeHistory(item)
            Toast.makeText(activity, R.string.toast_hist_deleted, Toast.LENGTH_SHORT).show()
            onChanged()
        }
        .show()
}
