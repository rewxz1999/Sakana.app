package app.sakana.receiver

import com.shuyu.gsyvideoplayer.video.base.GSYVideoView

/**
 * 把 GSY（内核是 Media3 的 exo2）的播放状态映射成协议里的 state 枚举。
 *
 * 单独一个文件的原因：这个映射是**协议的一部分**（取值只能是
 * idle / playing / paused / buffering / ended，不能自造），而且它同时被
 * 界面和 `/info` 用到 —— 放在 PlayerController 里既让它变长，也让"协议映射"这件事不够显眼。
 *
 * ⚠️ 这条映射换过一次实现（Media3 的 `Player.STATE_*` → GSY 的 `CURRENT_STATE_*`），
 * 有几处**不能照字面翻译**，注释里逐条写了原因。
 *
 * @param gsyState    `player.getCurrentState()`
 * @param hasMedia    当前是不是"有一集在播/准备播"（`stop` 之后是 false）
 * @param hasError    是否处于"最近一次播放出错"的状态
 */
internal fun playbackStateName(gsyState: Int, hasMedia: Boolean, hasError: Boolean): String {
    // 出错后如实报 idle：GSY 出错时停在 CURRENT_STATE_ERROR，
    // 如果我们接着报 buffering，电脑端的"缓冲中"会永远转下去（旧实现也有这条规矩）。
    if (hasError) return Proto.STATE_IDLE
    if (!hasMedia) return Proto.STATE_IDLE
    return when (gsyState) {
        // GSY 的 "NORMAL" = 还没有任何媒体/已经 reset。我们已经确认有媒体，
        // 所以这一瞬间只能是在准备中：报 buffering 比报 idle 更贴近用户感受
        // （报 idle 会让界面直接退回首页，用户看到的是"投屏成功了但画面闪一下没了"）。
        GSYVideoView.CURRENT_STATE_NORMAL,
        GSYVideoView.CURRENT_STATE_PREPAREING,
        GSYVideoView.CURRENT_STATE_PLAYING_BUFFERING_START,
        -> Proto.STATE_BUFFERING

        GSYVideoView.CURRENT_STATE_PLAYING -> Proto.STATE_PLAYING
        GSYVideoView.CURRENT_STATE_PAUSE -> Proto.STATE_PAUSED
        GSYVideoView.CURRENT_STATE_AUTO_COMPLETE -> Proto.STATE_ENDED
        // ERROR 走不到这里（上面 hasError 已经返回），留着是为了"万一 onError 没回调"
        // 也不会掉进 else 去报一个不存在的状态
        GSYVideoView.CURRENT_STATE_ERROR -> Proto.STATE_IDLE
        else -> Proto.STATE_IDLE
    }
}
