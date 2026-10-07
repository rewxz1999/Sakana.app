package app.sakana.receiver

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 设置页专用的几个小控件：首选网卡选择弹窗、最近地址列表、图片缓存区块。
 *
 * 为什么从 UiHelpers 拆出来：它们是**只有设置页用**的东西（网卡单选、最近地址行），
 * 而 UiHelpers 那边是首页/播放器/设置页共用的文案与格式化。
 * 混在一起的结果是两边都读不完 —— 拆开之后各自都能一口气看完。
 */

/**
 * "封面缓存：N 张 / X MB · 缓存于 …" + 「清理图片缓存」按钮。
 *
 * 为什么统计要放到后台线程：目录里可能攒了几千个文件，逐个 `stat` 要几十毫秒，
 * 而这是在 `onResume` 里调的 —— 放主线程上就是一次肉眼可见的掉帧。
 * 所以先显示"正在统计…"，算完再回到主线程填进去。
 *
 * 数字全部来自 [CoverLoader.stats]（真实扫目录得到），**没有任何写死的值**。
 */
internal class CoverCacheSection(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "sakana-cache-stats").apply { isDaemon = true }
    }

    private val line: TextView get() = activity.findViewById(R.id.tv_cover_cache)

    /** 接上"清理"按钮。放在设置页的 bindViews 里调一次即可。 */
    fun bind() {
        activity.findViewById<Button>(R.id.btn_clear_cover_cache).setOnClickListener { confirmClear() }
    }

    /** 每次回到设置页都重算一遍（同步可能刚缓存了一批新图）。 */
    fun refresh() {
        line.text = activity.getString(R.string.set_cover_cache_counting)
        io.execute {
            val stats = CoverLoader.stats()
            main.post { line.text = render(stats) }
        }
    }

    private fun render(stats: CoverCacheStats): String {
        if (stats.isEmpty) return activity.getString(R.string.set_cover_cache_empty)
        val whenText = if (stats.newestAtMs <= 0L) {
            activity.getString(R.string.sync_never)
        } else {
            relativeTime(activity, stats.newestAtMs)
        }
        return activity.getString(
            R.string.set_cover_cache_line,
            stats.fileCount,
            formatBytes(stats.bytes),
            whenText,
        )
    }

    /**
     * 清理**只删图片缓存**。确认框里再强调一遍"收藏和历史不受影响"，
     * 因为"清理缓存"这个词在很多 App 里意味着"清数据"，用户会怕。
     */
    private fun confirmClear() {
        AlertDialog.Builder(activity)
            .setTitle(R.string.btn_clear_cover_cache)
            .setMessage(R.string.set_cover_cache_hint)
            .setPositiveButton(R.string.btn_clear_cover_cache) { _, _ ->
                io.execute {
                    val deleted = CoverLoader.clearAll()
                    main.post {
                        val message = if (deleted == 0) {
                            activity.getString(R.string.toast_cover_cache_empty)
                        } else {
                            activity.getString(R.string.toast_cover_cleared, deleted)
                        }
                        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
                        refresh()
                    }
                }
            }
            .setNegativeButton(R.string.close, null)
            .show()
    }
}

/**
 * 字节 -> "12.3 MB" / "456 KB" / "789 B"。
 * 除数用 1024：和系统设置里显示的口径一致，用户对得上号。
 */
internal fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024L -> String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
    bytes >= 1024L -> String.format(Locale.US, "%.0f KB", bytes / 1024.0)
    else -> "$bytes B"
}

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
