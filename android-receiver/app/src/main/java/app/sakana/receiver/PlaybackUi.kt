package app.sakana.receiver

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlin.math.abs

/** 手势提示气泡的显示时长。 */
private const val HINT_MS = 900L

/** 点一下音量键变化的档数。 */
private const val VOLUME_STEP = 5

/**
 * 播放层的全部界面逻辑：**官方 PlayerView 控制栏** + 手势 + 真正的横屏全屏。
 *
 * 为什么控制栏交给 Media3（`app:controller_layout_id` 指向我们自己的白蓝布局）而不是自己拼：
 * 拖动进度（含时间气泡、吸附）、播放/暂停、上一下一、±10 秒、倍速菜单、缓冲转圈、
 * 错误文案、字幕选择 —— 这些都是 Google 从 git 维护的那套播放器 UI 里打磨过的行为，
 * 自己用 ImageButton 拼一套既简陋又容易漏边界情况。我们只做**配色**和**多出来的按钮**。
 *
 * "完全全屏"靠三件事一起做（用户报的"不能完全全屏"多半就是这三处没做全）：
 *   ① setDecorFitsSystemWindows(false) + hide(systemBars())：内容真的铺到系统栏底下；
 *   ② 主题里的 windowLayoutInDisplayCutoutMode=shortEdges：画进刘海/挖孔；
 *   ③ 控制栏上的「铺满」开关把 resize_mode 从 fit 切成 fill：消除上下黑边。
 */
internal class PlaybackUi(
    private val activity: Activity,
    private val playerView: PlayerView,
    private val controller: PlayerController,
    private val homeView: View,
    private val gestureLayer: View,
    private val onPlaylist: () -> Unit,
    private val onSettings: () -> Unit,
    private val onExitPlayback: () -> Unit,
) {

    private val titleView: TextView = playerView.findViewById(R.id.player_title)
    private val retryButton: View = playerView.findViewById(R.id.btn_retry)
    private val lockButton: ImageButton = playerView.findViewById(R.id.btn_lock_orientation)
    private val exitFullscreenEntry: View = playerView.findViewById(R.id.btn_exit_fs)

    /** 全屏/方向/系统栏的细节都在 FullscreenController.kt，这里只负责调用。 */
    private val fullscreen = FullscreenController(activity)

    /**
     * 控制栏显隐的**唯一**负责人（含那个 4 秒计时器）。
     * 之所以单独一个类：以前是"每个心跳兜底判断 + Media3 自带逻辑"两头管，
     * 结果两边互相顶，控制栏永不隐藏（真因写在 `PlaybackControls` 的类注释里）。
     */
    private val controls = PlaybackControls(playerView)

    /** 音量/亮度/提示气泡/铺满这些小动作（拆出去让这里只剩主干）。 */
    private val actions = PlayerActions(activity, playerView, controller)

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
             * 于是无限递归 → StackOverflowError。
             * 这个坑一直藏着没发作：手势层以前根本收不到触摸（被上层 clickable 的 PlayerView 吃掉），
             * 所以没人读过这个值；真机上一拖进度就崩了才暴露出来。
             */
            override val durationMs: Long get() = this@PlaybackUi.durationMs

            override fun onToggleControls() {
                /*
                 * 以 PlayerView 的**真实**可见性为准，而不是我们自己的标志位：
                 * 一旦两个状态不同步（比如别处调过 show/hide），"点一下"就会点不动 ——
                 * 去 hide 一个已经隐藏的、或者 show 一个本来就显示的，看起来就是"没反应"。
                 * 控件动画已经关掉，`isControllerFullyVisible()` 在这里是准的。
                 */
                if (playerView.isControllerFullyVisible()) hideController() else showController()
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

    /** 接线：必须在 setContentView 之后调一次（此时 PlayerView 的控制栏已经 inflate）。 */
    fun bind() {
        // 控制栏的自动行为全部交给 PlaybackControls（它会把 Media3 那套关掉）：
        // 官方默认"点画面切换"会和我们的手势打架（双击快进时会被顺带切两次）。
        controls.bind()
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
        // 用户操作之后重新计时：免得"正在调音量，控制栏却淡出了"
        actions.keepAliveHook = { keepControlsAlive() }

        gestureLayer.setOnTouchListener { _, event -> gestures.onTouchEvent(event) }
        /*
         * 手势还要挂到 **PlayerView 自己**身上，否则整套手势（单击切换、双击快进、
         * 左右滑动调亮度/音量、长按 2 倍速）在真机上一次都不会触发。
         *
         * 原因：`gesture_layer` 在布局里排在 `player_view` **前面**，而 FrameLayout 里
         * 后面的孩子在上层 —— PlayerView 又是 clickable 的（真机 uiautomator dump 里能看到
         * `clickable="true"`），于是它在 ACTION_DOWN 就把事件吃掉了，下层的 gesture_layer
         * 永远收不到。真机上"点一下画面没反应"就是这么来的。
         *
         * 挂到 PlayerView 上为什么不会影响控制栏的按钮：ViewGroup 派发触摸时**先给子 View**
         * （也就是那些按钮），只有没有子 View 消费时才轮到自己的 OnTouchListener。
         * 所以点按钮照旧、点空白处才轮到手势 —— 这正是我们想要的优先级。
         */
        playerView.setOnTouchListener { _, event -> gestures.onTouchEvent(event) }
        // 拖进度条时重新计时：不这么做的话，拖到一半控制栏就自己淡出了
        actions.bindScrubKeepAlive { keepControlsAlive() }

        playerView.findViewById<ImageButton>(R.id.btn_pick_episode).setOnClickListener { onPlaylist() }
        playerView.findViewById<ImageButton>(R.id.btn_settings_player)?.setOnClickListener { onSettings() }
        // 退出全屏：回到竖屏但**继续播放**（等于返回键的第一步）
        exitFullscreenEntry.setOnClickListener { exitFullscreenIfNeeded() }
        // 退出播放（✕）：和返回键第二步同一套动作，见 exitPlayback()
        playerView.findViewById<View>(R.id.btn_exit_play).setOnClickListener { exitPlayback() }
        playerView.findViewById<ImageButton>(R.id.btn_volume_down)
            .setOnClickListener { actions.volumeBy(-VOLUME_STEP) }
        playerView.findViewById<ImageButton>(R.id.btn_volume_up)
            .setOnClickListener { actions.volumeBy(VOLUME_STEP) }
        lockButton.setOnClickListener { toggleOrientationLock() }
        playerView.findViewById<ImageButton>(R.id.btn_resize).setOnClickListener { actions.toggleResize() }
        retryButton.setOnClickListener {
            controller.retry()
            showController()
        }
        actions.applyResizeMode()
        syncExitFullscreenEntry()
    }

    // ---------------- 播放层切换与全屏 ----------------

    fun setPlayerMode(active: Boolean) {
        if (active == inPlayerMode) return
        inPlayerMode = active
        homeView.visibility = if (active) View.GONE else View.VISIBLE
        (playerView.parent as? View)?.visibility = if (active) View.VISIBLE else View.GONE
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
        syncExitFullscreenEntry()
    }

    /** 进横屏全屏（细节见 FullscreenController）。 */
    fun enterFullscreen() {
        fullscreen.enter()
        syncExitFullscreenEntry()
    }

    /** 退出全屏：恢复竖屏（交回系统决定）并显示系统栏。 */
    fun exitFullscreen() {
        fullscreen.exit()
        syncExitFullscreenEntry()
    }

    /**
     * 「退出全屏」这个入口只在**真的全屏时**才显示 ——
     * 已经回到竖屏还摆一个"退出全屏"只会让人困惑（点了什么都不会发生）。
     */
    private fun syncExitFullscreenEntry() {
        exitFullscreenEntry.visibility = if (fullscreen.immersive) View.VISIBLE else View.GONE
    }

    /** 返回键：全屏时先退全屏（不退出播放、更不退出应用）。 */
    fun exitFullscreenIfNeeded(): Boolean {
        if (!fullscreen.exitIfNeeded()) return false
        syncExitFullscreenEntry()
        showController()
        return true
    }

    /**
     * 顶栏的「退出播放」（✕）：**和返回键的第二步是同一套动作** ——
     * 停止播放 → 退全屏 → 回首页层。
     *
     * 停止后的画面层/首页层切换由随后的 `setPlayerMode(false)` 完成
     * （`onExitPlayback` 里 MainActivity 会立刻刷一次界面，所以首页马上就有收藏和历史）。
     * 这里只负责把浮层先收干净，免得"已经回首页了控制栏还挂在半空"。
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

    // ---------------- 刷新（每个心跳一次） ----------------

    fun refresh(snapshot: PlayerController.Snapshot, error: String?, notice: String?) {
        durationMs = snapshot.durationMs
        // 标题：用户最想知道"在看什么"；出错/提示时优先说这件事
        titleView.text = when {
            error != null -> activity.getString(R.string.state_error)
            notice != null -> notice
            snapshot.title?.isNotBlank() == true -> snapshot.title
            else -> activity.getString(R.string.player_unknown_title)
        }
        titleView.setTextColor(activity.getColor(if (error != null) R.color.warn else R.color.player_text))

        // 出错：官方错误文案（PlayerView 自带的 exo_error_message）+ 我们的「重试」
        retryButton.visibility = if (error != null) View.VISIBLE else View.GONE
        /*
         * 控制栏显隐：**只在状态跃迁时**动手（缓冲→播放、播放→暂停、出错……）。
         *
         * 上一版这里有两句"每秒兜底"：
         *   if (state == BUFFERING) keepControlsAlive()          // 每秒取消一次隐藏
         *   if (!snapshot.playing && !controlsVisible) show()     // 缓冲时 isPlaying=false → 每秒重新显示
         * 它们就是"控制栏永远不隐藏"的直接原因，现在整段删掉，换成状态跃迁判断。
         */
        controls.applyState(hasError = error != null, state = snapshot.state)
    }

    // ---------------- 具体动作 ----------------
    // 音量/亮度/提示气泡/铺满都在 PlayerActions 里（那些是"拿一个值、改一个地方"的小动作）。

    private fun toggleOrientationLock() {
        val locked = fullscreen.toggleOrientationLock()
        lockButton.contentDescription = activity.getString(
            if (locked) R.string.cd_unlock_orientation else R.string.cd_lock_orientation,
        )
        actions.showHint(
            activity.getString(
                if (locked) R.string.toast_locked_orientation else R.string.toast_unlocked_orientation,
            ),
        )
    }

    /** resize_mode 由播放层底栏的「铺满」和设置页共用（设置页回来时 MainActivity 会调它）。 */
    fun applyResizeMode() = actions.applyResizeMode()

    fun onDestroy() {
        actions.onDestroy()
        controls.onDestroy()
        fullscreen.onDestroy()
    }
}
