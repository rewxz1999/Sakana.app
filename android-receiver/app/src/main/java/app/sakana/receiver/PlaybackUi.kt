package app.sakana.receiver

import android.app.Activity
import android.view.View
import android.widget.TextView
import kotlin.math.abs

/**
 * 播放层的全部界面逻辑：**GSY 的播放视图与控制栏** + 手势 + 真正的横屏全屏。
 *
 * ## 换 GSY 之后这一层变成了什么
 *
 * 画面渲染、进度条与时间、缓冲转圈、中央播放键、控制栏隐藏后剩的那条细进度线，
 * 全都是 GSY 的（`StandardGSYVideoPlayer` + `player_gsy_view.xml`）。
 * 我们留在这类里的是**三件不可替代的事**，也只有这三件：
 *   ① 两个形态（首页 / 播放层）的切换；
 *   ② 横屏全屏（细节在 `FullscreenController`）；
 *   ③ 控制栏显隐的接线（唯一负责人在 `PlaybackControls`）。
 * 具体动作（音量/亮度/提示气泡/铺满）在 `PlayerActions`，按钮接线在 `PlayerButtons`。
 *
 * ## 为什么控制栏显隐要自己管
 *
 * GSY 自带一套（状态一变就显示，2.5 秒后隐藏）。和 v0.3.8 跟 Media3 打架时的情况一模一样：
 * 两个负责人 = 谁都不知道最后是谁说了算，真机上的表现就是"控制栏永远不隐藏"。
 * 所以 `SakanaGsyPlayer.startDismissControlViewTimer()` 被覆写成空方法，
 * 显示/隐藏只由 [controls] 的计时器 + `ControlsPolicy` 的状态跃迁决定。
 *
 * ## "完全全屏"仍然靠三件事一起做
 *   ① setDecorFitsSystemWindows(false) + hide(systemBars())：内容真的铺到系统栏底下；
 *   ② 主题里的 windowLayoutInDisplayCutoutMode=shortEdges：画进刘海/挖孔；
 *   ③ 控制栏上的「铺满」开关（GSY 的画面比例）：消除上下黑边。
 */
internal class PlaybackUi(
    private val activity: Activity,
    private val gsy: SakanaGsyPlayer,
    private val controller: PlayerController,
    private val homeView: View,
    private val gestureLayer: View,
    private val onPlaylist: () -> Unit,
    private val onSettings: () -> Unit,
    private val onExitPlayback: () -> Unit,
) {

    /*
     * ⚠️ 业务按钮条必须**在下面那两个类被构造之前**装好，而且是硬性顺序。
     *
     * `PlayerActions` / `PlayerButtons` 都是在**构造/字段初始化**的时候就用
     * `findViewById` 去播放器里找自己的控件的（提示气泡、铺满按钮、各按钮），
     * 而那些控件全在 `player_overlay.xml` 里 —— 晚一步它们拿到的就是 null，
     * 真机上的表现是**一打开播放层就崩**（`NullPointerException: findViewById(...) must not be null`，
     * v1.2 换原生控制栏时踩过一次）。所以这里用一个 init 块把它提到最前面：
     * Kotlin 的 init 块与属性初始化严格按**书写顺序**执行，写在 `actions` 之前就一定先跑。
     */
    init {
        gsy.installExtraBar()
    }

    /** 标题用 GSY 自己顶栏上那个 TextView，它在控制栏容器里，跟着一起显隐。 */
    private val titleView: TextView = gsy.titleTextView

    /** 全屏/方向/系统栏的细节都在 FullscreenController.kt，这里只负责调用。 */
    private val fullscreen = FullscreenController(activity)

    /** 控制栏显隐的**唯一**负责人（含那个 4 秒计时器）。 */
    private val controls = PlaybackControls(gsy)

    /** 音量/亮度/提示气泡/铺满这些小动作（拆出去让这里只剩主干）。 */
    private val actions = PlayerActions(activity, gsy, controller)

    private var inPlayerMode = false
    private var durationMs = 0L

    // ---------------- 手势 ----------------

    private val gestures = PlayerGestures(
        view = gestureLayer,
        listener = object : PlayerGestures.Listener {
            override val volumePercent: Int get() = controller.snapshot().volume
            override val brightnessPercent: Int get() = actions.brightness()
            /*
             * ⚠️ 必须写 `this@PlaybackUi.durationMs`。
             * 只写 `durationMs` 会解析成**这个匿名对象自己的** durationMs（也就是这一行本身），
             * 于是无限递归 → StackOverflowError。这个坑在 v0.3.8 真机上一拖进度就崩过。
             */
            override val durationMs: Long get() = this@PlaybackUi.durationMs

            override fun onToggleControls() {
                /*
                 * 以 GSY 的**真实**可见性为准，而不是我们自己的标志位：
                 * 一旦两个状态不同步（GSY 的状态机在缓冲/暂停时会自己把控制栏显示出来），
                 * "点一下"就会点不动 —— 去 hide 一个已经隐藏的、或者 show 一个本来就显示的，
                 * 看起来就是"点画面没反应"。
                 */
                if (gsy.widgetsVisible()) hideController() else showController()
            }

            override fun onSeekBy(deltaMs: Long) {
                actions.showHint(
                    activity.getString(
                        if (deltaMs >= 0) R.string.hint_seek_forward else R.string.hint_seek_backward,
                        (abs(deltaMs) / 1000).toInt(),
                    ),
                )
                actions.seekBy(deltaMs, durationMs)
            }

            override fun onSpeed(active: Boolean) {
                controller.setPlaybackSpeed(if (active) 2f else 1f)
                if (active) {
                    actions.showHint(activity.getString(R.string.hint_speed_2x))
                } else {
                    actions.hideHint()
                }
            }

            override fun onVolume(percent: Int) = actions.setVolume(percent)

            override fun onBrightness(percent: Int) = actions.setBrightness(percent)

            override fun onSeekPreview(deltaMs: Long) =
                actions.showSeekPreview(controller.snapshot().positionMs, deltaMs, durationMs)

            override fun onSeekCommit(deltaMs: Long) {
                actions.seekBy(deltaMs, durationMs)
                actions.hideHint()
            }
        },
    )

    /** 控制栏上的按钮（选集/设置/退出/切集/±秒/音量/锁方向/铺满/重试）。 */
    private var buttons: PlayerButtons? = null

    /** 接线：必须在 setContentView 之后调一次（此时 GSY 的控制栏已经 inflate）。 */
    fun bind() {
        // GSY 那边的自动显隐已经在 SakanaGsyPlayer 里关了，这里把超时也设成 0（双保险）
        controls.bind()
        // 用户操作之后重新计时：免得"正在调音量，控制栏却淡出了"
        actions.keepAliveHook = { keepControlsAlive() }
        // 拖动 GSY 的进度条时也重新计时（覆写的是它自己的 SeekBar 回调，没有动它的接线）
        gsy.onScrub = { keepControlsAlive() }
        // 尺寸变了要重算"铺满"的比例；post 一下，避免在 layout 过程中再 requestLayout
        gsy.onSizeChangedHook = { gsy.post { actions.onPlayerSizeChanged() } }

        /*
         * GSY 原生那两个按钮按下去做什么（图标/位置完全不动，只换落点）：
         *  · 返回键 → 退出播放。这正是用户要的"和原来一致"—— 旧的顶栏 ✕ 与返回键第二步
         *    走的就是 [exitPlayback] 这同一个方法；
         *  · 全屏键 → 我们自己的全屏开关（横屏 + 隐藏系统栏）。GSY 原来的全屏实现需要外面
         *    有一套容器配合，在本工程的布局里按了不会有任何反应，那才是真的"按钮不可用"。
         */
        gsy.onBackPressed = { exitPlayback() }
        gsy.onFullscreenToggle = { toggleFullscreen() }

        buttons = PlayerButtons(
            activity = activity,
            gsy = gsy,
            controller = controller,
            actions = actions,
            onPlaylist = onPlaylist,
            onSettings = onSettings,
            onRetry = { controller.retry(); showController() },
            onLockOrientation = { toggleOrientationLock() },
            keepAlive = { keepControlsAlive() },
        ).also { it.bind() }

        /*
         * 手势要挂两层，原因不同：
         *  · `gesture_layer` 是布局里**故意放在播放器之前**（z 序更低）的透明层，
         *    它是"画面空白处"的触摸目标，这个结构从 v0.3.8 起就是有意的，保留；
         *  · 真正会收到触摸的是播放器内部那一层 `surface_container` ——
         *    GSY 把 OnTouchListener 挂在那里，而它是覆盖整块画面的子视图，
         *    所以只挂在播放器自己身上一次都不会触发（v0.3.8 就是这么踩的）。
         *    `installGestureTarget` 会替换掉 GSY 挂在上面的那一个，
         *    控件（控制栏按钮）是它的兄弟视图、z 序更高，ViewGroup 先给子 View 派发，
         *    所以"按钮优先拿到点击、空白处才走手势"这个关系不变。
         */
        gestureLayer.setOnTouchListener { _, event -> gestures.onTouchEvent(event) }
        gsy.installGestureTarget { _, event -> gestures.onTouchEvent(event) }

        actions.applyResizeMode()
    }

    // ---------------- 播放层切换与全屏 ----------------

    fun setPlayerMode(active: Boolean) {
        if (active == inPlayerMode) return
        inPlayerMode = active
        homeView.visibility = if (active) View.GONE else View.VISIBLE
        (gsy.parent as? View)?.visibility = if (active) View.VISIBLE else View.GONE
        if (active) {
            // 刚进播放层：按"第一次看到这个状态"重新判断显隐（缓冲/播放/暂停各有规矩）
            controls.reset()
            enterFullscreen()
            showController()
        } else {
            exitFullscreen()
            actions.hideHint()
            controls.reset()
        }
    }

    /** 进横屏全屏（细节见 FullscreenController）。 */
    fun enterFullscreen() {
        fullscreen.enter()
        // 横屏之后播放器会被重新测量，尺寸一变就会走 onSizeChangedHook 重算铺满比例
    }

    /**
     * GSY 原生全屏键的落点（见 SakanaGsyPlayer.onClick）。
     * 我们的"全屏"是横屏 + 隐藏系统栏 + 刘海可用（FullscreenController），
     * 所以这个键就是一个来回开关：全屏中按它退出全屏，退出后按它再进去 ——
     * 按钮**永远可见可用**，而不是像上一版那样"不全屏时把它藏起来"。
     */
    fun toggleFullscreen() {
        if (fullscreen.immersive) exitFullscreenIfNeeded() else { enterFullscreen(); showController() }
    }

    /** 退出全屏：恢复竖屏（交回系统决定）并显示系统栏。 */
    fun exitFullscreen() {
        fullscreen.exit()
    }

    /** 返回键：全屏时先退全屏（不退出播放、更不退出应用）。 */
    fun exitFullscreenIfNeeded(): Boolean {
        if (!fullscreen.exitIfNeeded()) return false
        showController()
        return true
    }

    /**
     * 顶栏的「退出播放」（✕）：**和返回键的第二步是同一套动作** ——
     * 停止播放 → 退全屏 → 回首页层。这里只负责把浮层先收干净，
     * 免得"已经回首页了控制栏还挂在半空"。
     */
    fun exitPlayback() {
        hideController()
        actions.hideHint()
        controls.reset()
        onExitPlayback()
    }

    fun isInPlayerMode(): Boolean = inPlayerMode

    // ---------------- 控制栏显隐 ----------------
    // 真正的逻辑在 PlaybackControls（唯一计时器）+ ControlsPolicy（纯逻辑的状态跃迁）。

    fun showController() = controls.show()

    fun hideController() = controls.hide()

    /** 用户操作之后重新计时（拖进度、调音量、点按钮都调它）。 */
    fun keepControlsAlive() = controls.keepAlive()

    /** 界面自己产生的一句提示（"已在手机上切到第 3 集"之类）：走和手势提示同一个气泡。 */
    fun showNotice(text: String) = actions.showHint(text)

    // ---------------- 刷新（每个心跳一次） ----------------

    fun refresh(snapshot: PlayerSnapshot, error: String?, notice: String?) {
        durationMs = snapshot.durationMs
        // 标题：用户最想知道"在看什么"；出错/提示时优先说这件事
        titleView.text = when {
            error != null -> activity.getString(R.string.state_error)
            notice != null -> notice
            snapshot.title?.isNotBlank() == true -> snapshot.title
            else -> activity.getString(R.string.player_unknown_title)
        }
        titleView.setTextColor(activity.getColor(if (error != null) R.color.warn else R.color.player_text))

        buttons?.refresh(snapshot, error, fullscreen.orientationLocked)
        // 画面比例每个心跳校一次：尺寸/宽高比变化都没有回调可挂，见 PlayerActions.syncFill
        actions.syncFill()

        /*
         * 控制栏显隐：**只在状态跃迁时**动手（缓冲→播放、播放→暂停、出错……）。
         * 上一版这里有两句"每秒兜底"，它们就是"控制栏永远不隐藏"的直接原因，
         * 现在整段不存在了 —— 规矩写在 ControlsPolicy 里。
         */
        controls.applyState(hasError = error != null, state = snapshot.state)
    }

    /** resize_mode 由播放层底栏的「铺满」和设置页共用（设置页回来时 MainActivity 会调它）。 */
    fun applyResizeMode() = actions.applyResizeMode()

    private fun toggleOrientationLock() {
        val locked = fullscreen.toggleOrientationLock()
        actions.showHint(
            activity.getString(
                if (locked) R.string.toast_locked_orientation else R.string.toast_unlocked_orientation,
            ),
        )
    }

    fun onDestroy() {
        actions.onDestroy()
        controls.onDestroy()
        fullscreen.onDestroy()
    }
}
