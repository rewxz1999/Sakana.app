package app.sakana.receiver

import android.app.Activity

/**
 * 顶部状态区那两行字（大字状态 + 副状态）。
 *
 * 为什么从 UiHelpers 拆出来：UiHelpers 那边已经是"首页/播放器/设置页共用的小工具"，
 * 而这里只有一件事 —— 把各种状态翻译成**用户看得懂的两行中文**。
 * 单独一个文件之后两个文件都能一口气读完。
 */

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
