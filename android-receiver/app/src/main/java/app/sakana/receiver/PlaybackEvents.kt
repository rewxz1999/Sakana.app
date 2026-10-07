package app.sakana.receiver

import android.util.Log
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player

private const val TAG = "SakanaPlayer"

/**
 * 播放器事件到"我们自己的状态"的桥。
 *
 * 单独成文件的原因：这段是**播放器与界面之间唯一的回调边界**，
 * 值得一眼看清它到底反应了哪些事件、以及为什么只有它是错误处理入口。
 *
 * @param onChanged 任何需要刷新界面的状态变化（播放/暂停/缓冲/结束）
 * @param onError   播放失败的人话文案；由 PlayerController 记下来给界面和 /info 用
 */
internal class PlaybackEvents(
    private val onChanged: () -> Unit,
    private val onError: (String) -> Unit,
) : Player.Listener {

    override fun onPlaybackStateChanged(playbackState: Int) {
        onChanged()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        onChanged()
    }

    override fun onPlayerError(error: PlaybackException) {
        // ExoPlayer 出错后自己会停在 IDLE，不会自动恢复。
        // 要不要重试由**电脑端**决定（再发一次 /play）或用户在控制栏上点「重试」；
        // 接收端擅自重连会把"地址已过期"变成无限重连，反而更难排查。
        Log.w(TAG, "播放失败", error)
        onError("${error.errorCodeName}：${error.message ?: "未知错误"}")
    }
}
