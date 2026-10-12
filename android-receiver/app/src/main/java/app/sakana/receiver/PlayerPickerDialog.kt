package app.sakana.receiver

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** dp -> px（本文件自己一份；SettingsUi 里那个是 private，跨文件拿不到）。 */
private fun dp(context: Context, value: Int): Int =
    (value * context.resources.displayMetrics.density).toInt()

/**
 * 播放层的「剧集 / 数据源」选择弹窗。
 *
 * 为什么不用 ListView + ArrayAdapter（旧版那套）：现在要在一个弹窗里分**两组**
 * （数据源 + 集数），组标题不是可选项 —— 用 ListView 得给"标题行"做不可点的特判，
 * 反而更绕；直接拼一个 LinearLayout 放进 ScrollView 里最直白，也方便给当前项上色。
 *
 * 为什么两件事放一个弹窗：用户的心智是"这一部怎么看" —— 换线路和换集数是同一个决定的两半，
 * 分成两个入口反而要来回点两次（而且切完线路往往马上就要切集）。
 *
 * 线路部分**只在电脑端给了线路时才出现**：拿不到就是拿不到，
 * 宁可整块不显示，也不要摆一个永远是空的"数据源"入口。
 */
internal fun showPlayPickerDialog(
    activity: Activity,
    titles: List<String>,
    currentIndex: Int,
    playable: List<Boolean>,
    sources: List<PlaySource>,
    currentSourceId: String?,
    onEpisode: (Int) -> Unit,
    onSource: (PlaySource) -> Unit,
) {
    // 点完就关：这是一次选择，不是多选面板。用 lateinit 让行回调能捕获到 dialog 本身。
    lateinit var dialog: AlertDialog
    val dismissAnd = { action: () -> Unit ->
        {
            action()
            dialog.dismiss()
        }
    }

    val column = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(activity, 4), 0, dp(activity, 4))
    }

    // ---- 数据源（线路）----
    if (sources.isNotEmpty()) {
        column.addView(groupTitle(activity, activity.getString(R.string.picker_sources)))
        sources.forEach { source ->
            val current = source.id == currentSourceId
            column.addView(
                row(
                    activity = activity,
                    text = if (current) {
                        activity.getString(R.string.picker_source_current, source.name)
                    } else {
                        source.name
                    },
                    highlight = current,
                    muted = false,
                    onClick = dismissAnd { onSource(source) },
                ),
            )
        }
    }

    // ---- 集数 ----
    if (titles.isEmpty()) {
        column.addView(groupTitle(activity, activity.getString(R.string.picker_no_episodes)))
    } else {
        column.addView(groupTitle(activity, activity.getString(R.string.picker_episodes, titles.size)))
        titles.forEachIndexed { index, title ->
            val hasUrl = index !in playable.indices || playable[index]
            val marks = ArrayList<String>(2)
            if (index == currentIndex) marks.add(activity.getString(R.string.playlist_current))
            // 规则模式下电脑端只能给标题、给不了地址：这种项点了也播不了，必须当场说清
            if (!hasUrl) marks.add(activity.getString(R.string.playlist_no_url))
            column.addView(
                row(
                    activity = activity,
                    text = if (marks.isEmpty()) title else "$title  ·  ${marks.joinToString(" · ")}",
                    highlight = index == currentIndex,
                    muted = !hasUrl,
                    onClick = dismissAnd { onEpisode(index) },
                ),
            )
        }
    }

    dialog = AlertDialog.Builder(activity)
        .setTitle(R.string.picker_title)
        .setView(ScrollView(activity).apply { addView(column) })
        .setNegativeButton(R.string.close, null)
        .create()
    dialog.show()
}

/** 组标题（"数据源" / "选集（共 12 集）"）。不可点。 */
private fun groupTitle(activity: Activity, text: String): TextView = TextView(activity).apply {
    this.text = text
    setTextColor(activity.getColor(R.color.text_secondary))
    textSize = 13f
    setTypeface(null, Typeface.BOLD)
    val pad = dp(activity, 8)
    setPadding(dp(activity, 24), pad * 2, dp(activity, 24), pad)
}

/** 可点的一行。[highlight] = 当前项（主色加粗），[muted] = 点了也播不了（暗色）。 */
private fun row(
    activity: Activity,
    text: String,
    highlight: Boolean,
    muted: Boolean,
    onClick: () -> Unit,
): TextView = TextView(activity).apply {
    this.text = text
    textSize = 15f
    gravity = Gravity.CENTER_VERTICAL
    setTextColor(
        activity.getColor(
            when {
                highlight -> R.color.accent
                muted -> R.color.text_muted
                else -> R.color.text_primary
            },
        ),
    )
    if (highlight) setTypeface(null, Typeface.BOLD)
    val pad = dp(activity, 12)
    setPadding(dp(activity, 24), pad, dp(activity, 24), pad)
    isClickable = true
    setOnClickListener { onClick() }
}
