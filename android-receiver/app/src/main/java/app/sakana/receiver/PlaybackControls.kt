package app.sakana.receiver

import android.os.Handler
import android.os.Looper
import android.util.Log

private const val TAG = "SakanaControls"

/** 播放中控制栏自动淡出的时间；暂停/出错/播完时不再自动隐藏（见 [pin]）。 */
internal const val HIDE_TIMEOUT_MS = 4_000L

/**
 * 控制栏显隐的**唯一**负责人。
 *
 * ## 这个类的来历（换播放器时踩过两次，别再踩第三次）
 *
 * v0.3.8 那会儿控制栏"永远不隐藏"，反编译 media3-ui 的字节码才定位到两条互相独立的坑
 * （每秒给 `controllerShowTimeoutMs` 赋值 = 每秒重置倒计时；淡入动画被打断后 `uxState` 卡在 1，
 * `hide()` 只隐藏进度条）。当时的结论是：**显隐只能有一个负责人**，
 * 于是把播放器自带那套整个关掉，只留这里的计时器 + [controlsAction] 的状态跃迁。
 *
 * 换成 GSY 之后同样的问题又摆了一遍，只是换了个名字：GSY 的
 * `GSYVideoControlView.startDismissControlViewTimer()` 会在状态变化、点击空白处等
 * 好几个地方排一个 2.5 秒的隐藏任务。所以我们做的是同一件事 ——
 * 在 `SakanaGsyPlayer` 里把那个计时器覆写成空方法，显隐完全归这里管。
 *
 * 规矩没变：
 *  · 显示/隐藏只由"跃迁"和用户操作触发；
 *  · "4 秒后隐藏"只有一个计时器（[hideAction]），谁要延后都走 [keepAlive]；
 *  · 暂停/出错/播完 → [pin]（常显，连计时器都不排）。
 */
internal class PlaybackControls(private val gsy: SakanaGsyPlayer) {

    private val handler = Handler(Looper.getMainLooper())
    private val hideAction = Runnable { hide() }

    /**
     * 控制栏现在是不是可见的。
     *
     * **故意做成"读 GSY 的真实状态"而不是自己记一个标志位**：GSY 的状态机也会动控制栏的
     * 可见性（`changeUiToXxxShow()`），自己记的那份一定会不同步 ——
     * 一旦不同步，[arm] 就会在"其实看得见"的时候跳过计时（控制栏再也不自动隐藏），
     * 或者反过来在隐藏状态下排一个空的隐藏任务。读真实值则永远自洽：
     * 显示着 → 排计时；已经隐藏 → 不排。
     */
    val visible: Boolean get() = gsy.widgetsVisible()

    /** 常显（暂停/出错/播完）。常显期间 [keepAlive] 不会排计时器。 */
    private var pinned = false

    /** 上一次的状态键，用来判断"这次是不是跃迁"。null = 刚进播放层。 */
    private var lastKey: String? = null

    /**
     * GSY 那边的自动行为已经在 `SakanaGsyPlayer` 的覆写里关掉了，
     * 这里只把超时时间也设成 0（双保险：任何漏网的 `startDismissControlViewTimer` 调用
     * 即使真的排了任务，也是"0 毫秒后隐藏"，不会在我们显示之后又把控制栏拉回去）。
     */
    fun bind() {
        gsy.setDismissControlTime(0)
    }

    /** 用户主动显示（点画面、点了按钮、刚进播放层）。会重新开始计时。 */
    fun show() {
        gsy.showWidgets()
        arm()
    }

    fun hide() {
        handler.removeCallbacks(hideAction)
        // 打一行日志：真机上"控制栏不隐藏"这类问题只能靠这一行分清是"我们没调"还是"调了没用"
        Log.i(TAG, "控制栏隐藏（调用前 GSY 侧 visible=${gsy.widgetsVisible()}）")
        gsy.hideWidgets()
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
     * 状态没变的那一秒什么都不做 —— 这正是当初修掉"永不隐藏"的关键。
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
        handler.removeCallbacks(hideAction)
        gsy.showWidgets()
    }

    /**
     * 排"4 秒后隐藏"。常显中、或者当前已经隐藏时什么都不做 ——
     * 后者是必要的：缓冲时若已经隐藏，延长计时也不该把回调排上去。
     */
    private fun arm() {
        handler.removeCallbacks(hideAction)
        if (pinned || !visible) return
        Log.i(TAG, "安排 ${HIDE_TIMEOUT_MS}ms 后隐藏控制栏")
        handler.postDelayed(hideAction, HIDE_TIMEOUT_MS)
    }
}
