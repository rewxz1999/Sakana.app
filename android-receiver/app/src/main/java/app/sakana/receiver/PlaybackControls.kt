package app.sakana.receiver

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.ui.PlayerView

private const val TAG = "SakanaControls"

/** 播放中控制栏自动淡出的时间；暂停/出错/播完时不再自动隐藏（见 [pin]）。 */
internal const val HIDE_TIMEOUT_MS = 4_000L

/**
 * 控制栏显隐的**唯一**负责人。
 *
 * ## 为什么必须独占
 *
 * Media3 的 `PlayerView` / `PlayerControlView` 自己也有一套自动显隐，两边一起管必然打架。
 * 实测（反编译 media3-ui 1.11.1 字节码）它们的联动是这样的：
 *
 * ```
 * PlayerView.setControllerShowTimeoutMs(t)
 *   → this.controllerShowTimeoutMs = t
 *   → if (controller.isFullyVisible()) showController()
 *        → PlayerControlView.setShowTimeoutMs(t)
 *             → if (isFullyVisible()) resetHideCallbacks()   // 取消并**重新开始**隐藏倒计时
 * ```
 *
 * 也就是说：**给 `controllerShowTimeoutMs` 赋一次值，就等于把"4 秒后隐藏"重新数一遍**。
 * 上一版在 `MainActivity` 每秒刷新时都写一次这个字段，于是倒计时永远到不了 4 秒 ——
 * 这正是"全屏播放时控制栏不隐藏"的真因（缓冲时更彻底：`playing == false` 会把超时设成 0，
 * 相当于"永不隐藏"，而且 `refresh()` 里还有一句每秒 `showController()`）。
 *
 * 所以现在把 Media3 那套**全部关掉**（`controllerAutoShow=false`、`controllerHideOnTouch=false`、
 * `controllerShowTimeoutMs=0` 且**只在 bind 时设一次**），显隐完全由这里的
 * [Handler] 计时器 + [controlsAction] 的状态跃迁决定：
 *  · 显示/隐藏只由"跃迁"和用户操作触发；
 *  · "4 秒后隐藏"只有一个计时器（[hideAction]），谁要延后都走 [keepAlive]；
 *  · 暂停/出错/播完 → [pin]（常显，连计时器都不排）。
 */
internal class PlaybackControls(private val playerView: PlayerView) {

    private val handler = Handler(Looper.getMainLooper())
    private val hideAction = Runnable { hide() }

    /** 我们自己记的可见性：`PlayerView` 只暴露 `isControllerFullyVisible()`（带动画语义），不适用。 */
    var visible = true
        private set

    /** 常显（暂停/出错/播完）。常显期间 [keepAlive] 不会排计时器。 */
    private var pinned = false

    /** 上一次的状态键，用来判断"这次是不是跃迁"。null = 刚进播放层。 */
    private var lastKey: String? = null

    /**
     * 把 Media3 自带的自动行为关掉，并且**只在这里**设一次超时。
     * 这三行是"两边不要打架"的全部开关，改动前请先读完类注释。
     */
    fun bind() {
        playerView.controllerAutoShow = false
        playerView.controllerHideOnTouch = false
        // 0 = 永不自动隐藏：Media3 那边彻底不管，隐藏时机由我们的计时器决定
        playerView.controllerShowTimeoutMs = 0
        /*
         * **关掉控制栏的淡入淡出动画**。这条不是审美问题，是真机上"控制栏不隐藏"的第二个原因：
         *
         * 反编译 PlayerControlViewLayoutManager 可以看到它有一套 uxState 状态机，
         * `isFullyVisible()` 只有在 uxState == 0（完全显示）时才为真；`show()` 会先把
         * uxState 置 1 并启动淡入动画，**等动画结束的回调**再置回 0。
         * 而真机上进播放层时会立刻切横屏（SENSOR_LANDSCAPE），窗口重建会把这段淡入动画打断，
         * "动画结束"的回调就不再执行 —— uxState 永远停在 1。
         * 于是 `hide()` 里这一段：
         *     if (uxState == 3 || uxState == 2) return;          // 不适用
         *     if (!animationEnabled) hideController();            // 立即隐藏
         *     else if (uxState == 1) hideProgressBar();           // ← 只隐藏进度条！
         *     else hideAllBars();
         * 走的就是 `hideProgressBar()`：**顶栏底栏还在原地**，看起来就是"控制栏永远不隐藏"。
         *
         * 关掉动画之后 show()/hide() 都是立即置可见性，没有动画回调可以被打断，也就没有这个死角。
         * 代价只是没有淡入淡出效果 —— 对这种"几秒不看就消失"的控制栏来说完全可以接受。
         */
        playerView.setControllerAnimationEnabled(false)
    }

    /** 用户主动显示（点画面、点了按钮、刚进播放层）。会重新开始计时。 */
    fun show() {
        visible = true
        playerView.showController()
        arm()
    }

    fun hide() {
        visible = false
        handler.removeCallbacks(hideAction)
        // 打一行日志：Media3 的 hide() 在"动画进行中/没完全可见"时是**空操作**，
        // 真机上"控制栏不隐藏"这类问题只能靠这一行分清是"我们没调"还是"调了没用"
        Log.i(TAG, "控制栏隐藏（hideController 前 isFullyVisible=${playerView.isControllerFullyVisible()}）")
        playerView.hideController()
    }

    /** 用户操作之后"重新计时"（拖进度、调音量、点按钮）。 */
    fun keepAlive() = arm()

    /** 退回首页时把状态清干净：下次进播放层要按"第一次看到"重新判断。 */
    fun reset() {
        lastKey = null
        pinned = false
        hide()
    }

    /**
     * 每个心跳调一次，但**只有状态跃迁时才会动手**（见 `ControlsPolicy.kt`）。
     * 状态没变的那一秒什么都不做 —— 这正是修掉"永不隐藏"的关键。
     */
    fun applyState(hasError: Boolean, state: String) {
        val key = controlsStateKey(hasError, state)
        val action = controlsAction(lastKey, key)
        lastKey = key
        if (action != ControlsAction.NONE) Log.i(TAG, "状态跃迁 $key -> $action")
        when (action) {
            ControlsAction.PIN -> pin()
            ControlsAction.AUTO_HIDE -> {
                pinned = false
                show()
            }
            // 缓冲：只把这一次的计时往后延一点，不是每秒延
            ControlsAction.EXTEND -> arm()
            ControlsAction.NONE -> Unit
        }
    }

    fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
    }

    /** 显示并常显：暂停 / 出错 / 播完 —— 用户这时候正在找按钮，不能藏。 */
    private fun pin() {
        pinned = true
        visible = true
        handler.removeCallbacks(hideAction)
        playerView.showController()
    }

    /**
     * 排"4 秒后隐藏"。常显中、或者当前已经隐藏时什么都不做 ——
     * 后者是必要的：缓冲时若已经隐藏，延长计时也不该把回调排上去（虽然排了也没视觉效果）。
     */
    private fun arm() {
        handler.removeCallbacks(hideAction)
        if (pinned || !visible) return
        Log.i(TAG, "安排 ${HIDE_TIMEOUT_MS}ms 后隐藏控制栏")
        handler.postDelayed(hideAction, HIDE_TIMEOUT_MS)
    }
}
