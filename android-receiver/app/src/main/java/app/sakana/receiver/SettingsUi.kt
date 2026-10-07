package app.sakana.receiver

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.view.LayoutInflater
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 设置页专用的两个小控件：首选网卡选择弹窗、最近地址列表。
 *
 * 为什么从 UiHelpers 拆出来：它们是**只有设置页用**的东西（网卡单选、最近地址行），
 * 而 UiHelpers 那边是首页/播放器/设置页共用的文案与格式化。
 * 混在一起的结果是两边都读不完 —— 拆开之后各自都能一口气看完。
 */

/**
 * 首选网卡选择弹窗（单选列表）。
 * 每一项都带着"接口名 · 地址（类型）"，用户才能认出哪一块是 USB 共享网络。
 */
internal fun showFacePickerDialog(
    activity: Activity,
    faces: List<NetFace>,
    currentName: String?,
    onPick: (String?) -> Unit,
) {
    if (faces.isEmpty()) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.set_face_label)
            .setMessage(R.string.set_face_none)
            .setPositiveButton(R.string.close, null)
            .show()
        return
    }

    val labels = ArrayList<String>(faces.size + 1)
    labels.add(activity.getString(R.string.set_face_auto))
    faces.forEach { labels.add(it.label) }

    // 第 0 项是"自动选择"，所以选中项要 +1
    val checked = faces.indexOfFirst { it.name == currentName }.let { if (it < 0) 0 else it + 1 }

    AlertDialog.Builder(activity)
        .setTitle(R.string.set_face_label)
        .setSingleChoiceItems(labels.toTypedArray(), checked) { dialog, which ->
            onPick(if (which == 0) null else faces[which - 1].name)
            dialog.dismiss()
        }
        .setNegativeButton(R.string.close, null)
        .show()
}

/** 把"最近用过的电脑地址"填进容器；点一行就等于把它填进输入框。 */
internal fun bindRecentHosts(container: LinearLayout, hosts: List<String>, onPick: (String) -> Unit) {
    container.removeAllViews()
    if (hosts.isEmpty()) {
        val empty = TextView(container.context)
        empty.setText(R.string.set_peer_empty)
        empty.setTextColor(container.context.getColor(R.color.text_muted))
        empty.textSize = 13f
        val pad = dp(container.context, 8)
        empty.setPadding(dp(container.context, 24), pad, 0, pad)
        container.addView(empty)
        return
    }
    val inflater = LayoutInflater.from(container.context)
    for (host in hosts) {
        val row = inflater.inflate(R.layout.item_recent_host, container, false) as TextView
        row.text = host
        row.setOnClickListener { onPick(host) }
        container.addView(row)
    }
}

private fun dp(context: Context, value: Int): Int =
    (value * context.resources.displayMetrics.density).toInt()
