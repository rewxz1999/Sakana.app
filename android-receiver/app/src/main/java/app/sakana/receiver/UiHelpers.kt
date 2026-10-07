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
import java.text.DateFormat
import java.util.Date

/**
 * 界面小工具：状态文字、选集弹窗、网卡选择、最近地址、剪贴板、时间格式化。
 *
 * 单独一个文件（而不是全塞在 Activity 里）的原因：这些是"和播放状态无关的纯 UI 动作"，
 * Activity 只该负责"接线 + 刷新"，这类函数抽出来两边都更好读，也不会让 Activity 越过 300 行。
 * 全部是顶层函数：它们不需要持有状态，用哪个 Activity 就传哪个进来。
 */

/** 顶部状态区那两行字。 */
internal data class StatusLines(val state: String, val detail: String)

/**
 * 组装顶部的"大字状态 + 副状态"。
 *
 * 副状态的优先级是有讲究的，从"最该让用户看到"往下排：
 *   失败原因 > 人话提示 > 已被谁连接 > 电脑正在搜索 > USB 共享网络提示 > 请让电脑搜索
 * 例如播放失败时，用户最需要看到的是**为什么失败**，而不是"等待投屏…"。
 */
internal fun statusLines(
    activity: Activity,
    state: String,
    title: String?,
    error: String?,
    notice: String?,
    connectedIp: String?,
    searchingIp: String?,
    wiredFaceLabel: String?,
): StatusLines {
    val name = title?.takeIf { it.isNotBlank() }
    val stateText = when {
        error != null -> activity.getString(R.string.state_error)
        state == Proto.STATE_PLAYING -> if (name != null) {
            activity.getString(R.string.state_playing, name)
        } else {
            activity.getString(R.string.state_playing_no_title)
        }
        state == Proto.STATE_PAUSED && name != null -> activity.getString(R.string.state_paused, name)
        state == Proto.STATE_BUFFERING && name != null -> activity.getString(R.string.state_buffering, name)
        state == Proto.STATE_ENDED && name != null -> activity.getString(R.string.state_ended, name)
        else -> activity.getString(R.string.state_idle)
    }

    val detail = when {
        error != null -> activity.getString(R.string.detail_error, error)
        notice != null -> activity.getString(R.string.detail_notice, notice)
        connectedIp != null -> activity.getString(R.string.detail_connected, connectedIp)
        searchingIp != null -> activity.getString(R.string.detail_searching, searchingIp)
        wiredFaceLabel != null -> activity.getString(R.string.detail_usb, wiredFaceLabel)
        else -> activity.getString(R.string.detail_waiting)
    }
    return StatusLines(stateText, detail)
}

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

/**
 * 毫秒 -> `mm:ss` 或 `h:mm:ss`。
 * 时长未知（0 或负数）时返回 [unknown]，而不是显示 "00:00" ——
 * 后者看起来像"已经播完了"，容易误导。
 */
internal fun formatTime(ms: Long, unknown: String): String {
    if (ms <= 0) return unknown
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val sec = total % 60
    return if (h > 0) {
        String.format("%d:%02d:%02d", h, m, sec)
    } else {
        String.format("%02d:%02d", m, sec)
    }
}

// ---------------- 同步相关 ----------------

/** 同步状态行的文字 + 是否算"需要注意"（用警告色显示）。 */
internal data class SyncStatus(val text: String, val error: Boolean)

/**
 * 首页/设置页共用的同步状态文案。
 *
 * 优先级：正在做的事（解析播放源 / 同步中）> 出错 > 已连接 > 未连接。
 * "还没连过电脑"时要说清**怎么才能连上**，而不是干瘪地说"未连接"。
 */
internal fun syncStatusText(activity: Activity): SyncStatus {
    SyncManager.statusMessage?.let { message ->
        if (SyncManager.busyCommand) return SyncStatus(message, false)
    }
    if (SyncManager.syncing) return SyncStatus(activity.getString(R.string.sync_status_syncing), false)
    SyncManager.lastError?.let { return SyncStatus(it, true) }

    val base = SyncStore.syncUrl
    if (base.isNullOrBlank()) return SyncStatus(activity.getString(R.string.sync_status_offline), false)

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
 * 观看历史的"相对时间"：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 具体日期。
 *
 * 为什么不用 DateUtils.getRelativeTimeSpanString：它返回的是"3 小时前"这一类**本地化**文案，
 * 但不同 API 级别的措辞和粒度都不一样，还会带上"0 分钟前"这种别扭结果；
 * 这里自己算，规则单一、可预期，也好在断言里验证。
 */
internal fun relativeTime(context: Context, timestampMs: Long): String {
    if (timestampMs <= 0L) return ""
    val diff = System.currentTimeMillis() - timestampMs
    // 电脑与设备时钟不同步时 diff 可能是负数，别显示"-3 分钟前"
    if (diff < 60_000L) return context.getString(R.string.time_just_now)
    val minutes = diff / 60_000L
    return when {
        minutes < 60 -> context.getString(R.string.time_minutes_ago, minutes.toInt())
        minutes < 24 * 60 -> context.getString(R.string.time_hours_ago, (minutes / 60).toInt())
        // 24-48 小时按"昨天"处理：够用且不用处理时区/夏令时
        minutes < 48 * 60 -> context.getString(R.string.time_yesterday)
        minutes < 30L * 24 * 60 -> context.getString(R.string.time_days_ago, (minutes / (24 * 60)).toInt())
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(timestampMs))
    }
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
