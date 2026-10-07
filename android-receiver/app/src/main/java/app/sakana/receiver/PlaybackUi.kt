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

/** 播放中控制栏自动淡出的时间；暂停时改成 0（不淡出）。 */
private const val HIDE_TIMEOUT_MS = 4_000

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
) {

    private val titleView: TextView = playerView.findViewById(R.id.player_title)
    private val hintView: TextView = playerView.findViewById(R.id.player_hint)
    private val retryButton: View = playerView.findViewById(R.id.btn_retry)
    private val resizeButton: ImageButton = playerView.findViewById(R.id.btn_resize)
    private val lockButton: ImageButton = playerView.findViewById(R.id.btn_lock_orientation)

    private val handler = Handler(Looper.getMainLooper())

    /** 全屏/方向/系统栏的细节都在 FullscreenController.kt，这里只负责调用。 */
    private val fullscreen = FullscreenController(activity)

    private var inPlayerMode = false
    private var durationMs = 0L

    /**
     * 控制栏当前是否可见。
     * 自己记一份而不是问 PlayerView：它只暴露 `isControllerFullyVisible()`（带"完全"的语义，
     * 动画过程中会是 false），而我们要的是"我上一次是显示还是隐藏"，自己的状态最准。
     */
    private var controlsVisible = true

    private val hideControls = Runnable { hideController() }
    private val dismissHint = Runnable { hintView.visibility = View.GONE }

    // ---------------- 手势 ----------------

    private val gestures = PlayerGestures(
        view = gestureLayer,
        listener = object : PlayerGestures.Listener {
            override val volumePercent: Int get() = controller.snapshot().volume
            override val brightnessPercent: Int get() = currentBrightness()
            override val durationMs: Long get() = durationMs

            override fun onToggleControls() {
                if (controlsVisible) hideController() else showController()
            }

            override fun onSeekBy(deltaMs: Long) {
                showHint(
                    activity.getString(
                        if (deltaMs >= 0) R.string.hint_seek_forward else R.string.hint_seek_backward,
                        (abs(deltaMs) / 1000).toInt(),
                    ),
                )
                seekBy(deltaMs)
            }

            override fun onSpeed(active: Boolean) {
                controller.setPlaybackSpeed(if (active) 2f else 1f)
                if (active) showHint(activity.getString(R.string.hint_speed_2x)) else hintView.visibility = View.GONE
            }

            override fun onVolume(percent: Int) {
                // 走同一条 /control 路径，这样电脑端读 /info 拿到的音量也一致
                controller.control("volume", percent.toLong())
                showHint(activity.getString(R.string.hint_volume, percent))
            }

            override fun onBrightness(percent: Int) {
                applyBrightness(percent)
                showHint(activity.getString(R.string.hint_brightness, percent))
            }

            override fun onSeekPreview(deltaMs: Long) {
                val unknown = activity.getString(R.string.time_unknown)
                val target = (controller.snapshot().positionMs + deltaMs).coerceAtLeast(0L)
                showHint("${formatTime(target, unknown)} / ${formatTime(durationMs, unknown)}")
            }

            override fun onSeekCommit(deltaMs: Long) {
                seekBy(deltaMs)
                hintView.visibility = View.GONE
            }
        },
    )

    /** 接线：必须在 setContentView 之后调一次（此时 PlayerView 的控制栏已经 inflate）。 */
    fun bind() {
        // 控制栏显隐由我们自己管：官方默认"点画面切换"会和我们的手势打架
        // （双击快进时会被顺带切两次）。关掉它之后点击统一走手势，行为才可控。
        playerView.controllerAutoShow = false
        playerView.controllerHideOnTouch = false
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)

        gestureLayer.setOnTouchListener { _, event -> gestures.onTouchEvent(event) }

        playerView.findViewById<ImageButton>(R.id.btn_pick_episode).setOnClickListener { onPlaylist() }
        playerView.findViewById<ImageButton>(R.id.btn_exit_fs).setOnClickListener { exitFullscreenIfNeeded() }
        playerView.findViewById<ImageButton>(R.id.btn_volume_down).setOnClickListener { volumeBy(-VOLUME_STEP) }
        playerView.findViewById<ImageButton>(R.id.btn_volume_up).setOnClickListener { volumeBy(VOLUME_STEP) }
        playerView.findViewById<ImageButton>(R.id.btn_settings_player)?.setOnClickListener { onSettings() }
        lockButton.setOnClickListener { toggleOrientationLock() }
        resizeButton.setOnClickListener { toggleResize() }
        retryButton.setOnClickListener {
            controller.retry()
            showController()
        }
        applyResizeMode()
    }

    // ---------------- 播放层切换与全屏 ----------------

    fun setPlayerMode(active: Boolean, playing: Boolean) {
        // 播放中 4 秒淡出；暂停时不淡出（否则用户找不到继续的按钮）
        playerView.controllerShowTimeoutMs = if (playing) HIDE_TIMEOUT_MS else 0
        if (active == inPlayerMode) return
        inPlayerMode = active
        homeView.visibility = if (active) View.GONE else View.VISIBLE
        (playerView.parent as? View)?.visibility = if (active) View.VISIBLE else View.GONE
        if (active) {
            enterFullscreen()
            showController()
        } else {
            exitFullscreen()
            hintView.visibility = View.GONE
        }
    }

    /** 进横屏全屏（细节见 FullscreenController）。 */
    fun enterFullscreen() = fullscreen.enter()

    /** 退出全屏：恢复竖屏（交回系统决定）并显示系统栏。 */
    fun exitFullscreen() = fullscreen.exit()

    /** 返回键：全屏时先退全屏（不退出播放、更不退出应用）。 */
    fun exitFullscreenIfNeeded(): Boolean {
        if (!fullscreen.exitIfNeeded()) return false
        showController()
        return true
    }

    fun isInPlayerMode(): Boolean = inPlayerMode

    // ---------------- 控制栏显隐 ----------------

    fun showController() {
        controlsVisible = true
        playerView.showController()
        scheduleHide()
    }

    fun hideController() {
        controlsVisible = false
        handler.removeCallbacks(hideControls)
        playerView.hideController()
    }

    fun keepControlsAlive() = scheduleHide()

    private fun scheduleHide() {
        handler.removeCallbacks(hideControls)
        val timeout = playerView.controllerShowTimeoutMs
        if (timeout > 0) handler.postDelayed(hideControls, timeout.toLong())
    }

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
        // 缓冲中让控制栏别淡出；暂停/出错时常显，用户才找得到按钮
        if (snapshot.state == Proto.STATE_BUFFERING) keepControlsAlive()
        if (!snapshot.playing && !controlsVisible) showController()
    }

    // ---------------- 具体动作 ----------------

    private fun seekBy(deltaMs: Long) {
        val position = controller.snapshot().positionMs
        var target = (position + deltaMs).coerceAtLeast(0L)
        if (durationMs > 0) target = target.coerceAtMost(durationMs)
        controller.control("seek", target)
    }

    private fun volumeBy(delta: Int) {
        val target = (controller.snapshot().volume + delta).coerceIn(0, 100)
        controller.control("volume", target.toLong())
        showHint(activity.getString(R.string.hint_volume, target))
        keepControlsAlive()
    }

    private fun toggleOrientationLock() {
        val locked = fullscreen.toggleOrientationLock()
        lockButton.contentDescription = activity.getString(
            if (locked) R.string.cd_unlock_orientation else R.string.cd_lock_orientation,
        )
        showHint(
            activity.getString(
                if (locked) R.string.toast_locked_orientation else R.string.toast_unlocked_orientation,
            ),
        )
    }

    private fun toggleResize() {
        Settings.resizeFill = !Settings.resizeFill
        applyResizeMode()
        showHint(
            activity.getString(if (Settings.resizeFill) R.string.toast_resize_fill else R.string.toast_resize_fit),
        )
    }

    /** resize_mode：fit = 按比例（可能留黑边），fill = 铺满（拉伸，消除黑边）。 */
    fun applyResizeMode() {
        val fill = Settings.resizeFill
        playerView.resizeMode =
            if (fill) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
        resizeButton.setImageResource(if (fill) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen)
        resizeButton.contentDescription = activity.getString(
            if (fill) R.string.cd_resize_fit else R.string.cd_resize_fill,
        )
    }

    /** 亮度：写 window 的 screenBrightness（0-1，-1 表示跟随系统）。留 5% 下限，别让屏幕全黑。 */
    private fun applyBrightness(percent: Int) {
        val attrs = activity.window.attributes
        attrs.screenBrightness = percent.coerceIn(5, 100) / 100f
        activity.window.attributes = attrs
    }

    private fun currentBrightness(): Int {
        val value = activity.window.attributes.screenBrightness
        return if (value < 0f) 100 else (value * 100).toInt().coerceIn(5, 100)
    }

    // ---------------- 提示气泡 ----------------

    private fun showHint(text: String) {
        hintView.text = text
        hintView.visibility = View.VISIBLE
        handler.removeCallbacks(dismissHint)
        handler.postDelayed(dismissHint, HINT_MS)
    }

    fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        fullscreen.onDestroy()
    }
}
