package app.sakana.receiver

/**
 * 控制栏"该不该动"的决策（**纯逻辑**，可在桌面上直接断言，不需要模拟器）。
 *
 * ## 为什么要单独抽出来
 *
 * 上一版是"每个心跳（1 秒）都兜底判断一次"：
 * ```kotlin
 * if (snapshot.state == Proto.STATE_BUFFERING) keepControlsAlive()
 * if (!snapshot.playing && !controlsVisible) showController()
 * ```
 * 结果控制栏**永远不隐藏**。原因有两层，都要靠"只在状态跃迁时才动"来根治：
 *
 * ① `Snapshot.playing` 取的是 `player.isPlaying`，而**缓冲中 `isPlaying` 就是 false**。
 *    于是缓冲期间每秒都在执行 `showController()`，用户刚看到它淡出又被拉回来。
 * ② 更要命的是 `showController()` 会重新计时，而缓存/暂停时超时被设成 0
 *    （见 `PlaybackControls` 里的说明），等于每秒把"该隐藏了"这件事取消一次。
 *
 * 所以这里的规矩是：**同一种状态重复出现，一律 NONE（什么都不做）**。
 * 这个函数天然幂等 —— 哪怕调用方忘了比较上一次的状态，也不可能"每秒续命"，
 * 因为 `previous == next` 直接返回 NONE。
 */
internal enum class ControlsAction {
    /** 什么都不做（状态没变，或者这个状态我们不关心）。 */
    NONE,

    /** 显示并**常显**：暂停 / 出错 / 播完 —— 用户这时候在找按钮，不能藏起来。 */
    PIN,

    /** 显示，并在 [PlaybackUi][HIDE_TIMEOUT_MS] 之后自动隐藏：进入播放中。 */
    AUTO_HIDE,

    /** 只把当前这一次计时延长一会儿（缓冲时用），**不要**每秒都延长。 */
    EXTEND,
}

internal const val CONTROLS_KEY_ERROR = "error"
internal const val CONTROLS_KEY_PLAYING = "playing"
internal const val CONTROLS_KEY_PAUSED = "paused"
internal const val CONTROLS_KEY_BUFFERING = "buffering"
internal const val CONTROLS_KEY_ENDED = "ended"
internal const val CONTROLS_KEY_IDLE = "idle"

/**
 * 把"错误 + 协议状态"压成一个可直接比较的键。
 * 出错时单独一个键：错误文案要一直看得见，而且它和暂停在界面上是两回事。
 */
internal fun controlsStateKey(hasError: Boolean, state: String): String = when {
    hasError -> CONTROLS_KEY_ERROR
    state == Proto.STATE_PLAYING -> CONTROLS_KEY_PLAYING
    state == Proto.STATE_PAUSED -> CONTROLS_KEY_PAUSED
    state == Proto.STATE_BUFFERING -> CONTROLS_KEY_BUFFERING
    state == Proto.STATE_ENDED -> CONTROLS_KEY_ENDED
    else -> CONTROLS_KEY_IDLE
}

/**
 * 从一个状态"跃迁"到另一个状态时该做什么。
 *
 * [previous] 为 null 表示"第一次看到"（刚进播放层），此时不额外动手 ——
 * 进播放层本来就已经显示过控制栏了。
 *
 * 缓冲的规矩：只有**从播放中掉进缓冲**时才延长一次计时。
 * 从暂停进缓冲（比如暂停时拖了一下进度）什么都不做 —— 那时本来就该常显。
 */
internal fun controlsAction(previous: String?, next: String): ControlsAction {
    // 状态没变 → 一律不碰可见性。这一条是"永不隐藏"那个 bug 的直接解药。
    if (previous == next) return ControlsAction.NONE
    return when (next) {
        CONTROLS_KEY_ERROR, CONTROLS_KEY_PAUSED, CONTROLS_KEY_ENDED -> ControlsAction.PIN
        CONTROLS_KEY_PLAYING -> ControlsAction.AUTO_HIDE
        CONTROLS_KEY_BUFFERING -> if (previous == CONTROLS_KEY_PLAYING) ControlsAction.EXTEND else ControlsAction.NONE
        else -> ControlsAction.NONE
    }
}
