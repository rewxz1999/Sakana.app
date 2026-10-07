package app.sakana.receiver

import android.content.Context
import java.text.DateFormat
import java.util.Date

/**
 * 时间文案：`mm:ss` 与"相对时间"。
 *
 * 为什么单独一个文件：这两件事都是"把时间变成人话"，被播放层（进度/时长）、
 * 历史卡片（多久以前看的）、设置页（缓存于 …）三处共用；
 * 它们和弹窗、剪贴板那些 UI 动作不是一类东西，放一起会让两边都读不完。
 */

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

/**
 * "相对时间"：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 具体日期。
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
