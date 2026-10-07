package app.sakana.receiver

import androidx.media3.common.Player

/**
 * 把 ExoPlayer 的播放状态映射成协议里的 state 枚举。
 *
 * 单独一个文件的原因：这个映射是**协议的一部分**（取值只能是
 * idle / playing / paused / buffering / ended，不能自造），而且它同时被
 * 界面和 /info 用到 —— 放在 PlayerController 里既让它变长，也让"协议映射"这件事不够显眼。
 *
 * @param playbackState   `player.playbackState`
 * @param isPlaying       `player.isPlaying`
 * @param mediaItemCount  `player.mediaItemCount`
 * @param hasError        是否处于"最近一次播放出错"的状态
 */
internal fun playbackStateName(
    playbackState: Int,
    isPlaying: Boolean,
    mediaItemCount: Int,
    hasError: Boolean,
): String {
    // 出错后 ExoPlayer 会停在 IDLE。如实报 idle，
    // 而不是一直报 buffering —— 否则电脑端的"缓冲中"提示会永远转下去。
    if (hasError) return Proto.STATE_IDLE
    return when (playbackState) {
        // 已经 setMediaSource 但还没进 BUFFERING 的瞬间：报 buffering 更贴近用户感受
        Player.STATE_IDLE -> if (mediaItemCount == 0) Proto.STATE_IDLE else Proto.STATE_BUFFERING
        Player.STATE_BUFFERING -> Proto.STATE_BUFFERING
        Player.STATE_READY -> if (isPlaying) Proto.STATE_PLAYING else Proto.STATE_PAUSED
        Player.STATE_ENDED -> Proto.STATE_ENDED
        else -> Proto.STATE_IDLE
    }
}
