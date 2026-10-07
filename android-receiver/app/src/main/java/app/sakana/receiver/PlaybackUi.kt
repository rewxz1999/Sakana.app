package app.sakana.receiver

import android.app.Activity
import android.content.pm.ActivityInfo
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageButton
import android.widget.SeekBar
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** 控制栏自动隐藏的等待时间。太短会让人觉得"按钮一闪就没了"，太长又挡画面。 */
private const val CONTROLS_HIDE_DELAY_MS = 4_000L

/** 进度条刻度：不用毫秒（太长），用千分比，刷新时做一次换算。 */
private const val SEEK_MAX = 1000

/** 点一下音量键变化的档数（协议里音量是 0-100）。 */
private const val VOLUME_STEP = 5

/**
 * 播放层的全部界面逻辑：铺满窗口的播放器、横屏全屏、浮在画面上的控制栏与进度条。
 *
 * 为什么把控制栏也放在这里（而不是留在 MainActivity）：控制栏是**播放层的一部分**，
 * 它和"是否全屏、要不要自动淡出、进度条在拖没在拖"是同一件事的状态；
 * 拆成两处会让 MainActivity 又长又难读，也让"这个按钮属于哪层"变得含糊。
 *
 * 关键约定：
 *  · 进播放 → `SENSOR_LANDSCAPE` + 隐藏系统栏（横屏哪一边都行，设备放支架上不用倒过来）；
 *  · 退出播放 → `UNSPECIFIED` + 恢复系统栏（回到正常的竖屏首页）；
 *  · 旋转/进入全屏**不会重建 Activity**：靠 AndroidManifest 里的 configChanges 兜住，
 *    否则一转屏播放器就被拆掉重来、画面直接断（这是"旋转后画面没了"的根因）。
 */
internal class PlaybackUi(
    private val activity: Activity,
    private val homeView: View,
    private val layer: View,
    /** 控制动作回调：参数是 (action, value)，与协议的 /control 同义 */
    private val onControl: (String, Long) -> Unit,
    private val onPlaylist: () -> Unit,
    private val onSettings: () -> Unit,
) {

    private val overlayTop: View = layer.findViewById(R.id.overlay_top)
    private val overlayBottom: View = layer.findViewById(R.id.overlay_bottom)
    private val tapLayer: View = layer.findViewById(R.id.tap_layer)
    private val ovTitle: TextView = layer.findViewById(R.id.ov_title)
    private val ovDetail: TextView = layer.findViewById(R.id.ov_detail)
    private val tvPos: TextView = layer.findViewById(R.id.tv_pos)
    private val tvDur: TextView = layer.findViewById(R.id.tv_dur)
    private val seek: SeekBar = layer.findViewById(R.id.seek)
    private val btnPrev: ImageButton = layer.findViewById(R.id.btn_prev)
    private val btnPlay: ImageButton = layer.findViewById(R.id.btn_play)
    private val btnNext: ImageButton = layer.findViewById(R.id.btn_next)

    private val handler = Handler(Looper.getMainLooper())

    /** 是否处于"横屏全屏"状态。 */
    var immersive: Boolean = false
        private set

    private var controlsVisible = true
    private var inPlayerMode = false
    private var playingNow = false
    private var dragging = false
    private var durationMs = 0L

    private val hideControls = Runnable { setControlsVisible(false) }

    /** 接线：必须在 setContentView 之后调一次。 */
    fun bind() {
        // 点画面切换控制栏显隐（点按钮时事件被按钮吃掉，不会走到这里）
        tapLayer.setOnClickListener { if (controlsVisible) setControlsVisible(false) else showControls(true) }

        btnPrev.setOnClickListener { control("prev") }
        btnNext.setOnClickListener { control("next") }
        btnPlay.setOnClickListener { control("toggle") }
        layer.findViewById<ImageButton>(R.id.btn_vol_down).setOnClickListener {
            control("volume", (currentVolume - VOLUME_STEP).coerceAtLeast(0).toLong())
        }
        layer.findViewById<ImageButton>(R.id.btn_vol_up).setOnClickListener {
            control("volume", (currentVolume + VOLUME_STEP).coerceAtMost(100).toLong())
        }
        layer.findViewById<ImageButton>(R.id.btn_playlist).setOnClickListener { onPlaylist() }
        layer.findViewById<ImageButton>(R.id.btn_settings).setOnClickListener { onSettings() }
        layer.findViewById<ImageButton>(R.id.btn_exit_fs).setOnClickListener { exitFullscreenIfNeeded() }

        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                // 拖动时只更新左边的数字；松手才真的 seek，免得一路拖一路发 seekTo
                if (durationMs > 0) {
                    tvPos.text = formatTime(durationMs * progress / SEEK_MAX, unknownTime())
                }
            }

            override fun onStartTrackingTouch(bar: SeekBar) {
                dragging = true
                keepControlsAlive()
            }

            override fun onStopTrackingTouch(bar: SeekBar) {
                dragging = false
                if (durationMs > 0) onControl("seek", durationMs * bar.progress / SEEK_MAX)
            }
        })
    }

    /** 最近一次拿到的音量（音量键基于它加减）。 */
    private var currentVolume = 100

    private fun control(action: String, value: Long = 0L) {
        onControl(action, value)
        keepControlsAlive()
    }

    /**
     * 切换"首页 / 播放层"。**只有状态真的变了才动窗口**，
     * 因为这个方法在每秒的心跳里都会被调用。
     */
    fun setPlayerMode(active: Boolean, playing: Boolean) {
        playingNow = playing
        if (active == inPlayerMode) {
            // 同一模式内，暂停时把控制栏钉住（暂停还在自动隐藏的话用户找不到按钮）
            if (active && !playing) showControls(false)
            return
        }
        inPlayerMode = active
        homeView.visibility = if (active) View.GONE else View.VISIBLE
        layer.visibility = if (active) View.VISIBLE else View.GONE
        if (active) {
            enterFullscreen()
            showControls(playing)
        } else {
            exitFullscreen()
        }
    }

    /** 进横屏全屏：切横屏方向 + 隐藏状态栏/导航栏（从边缘划一下能临时唤出）。 */
    fun enterFullscreen() {
        if (immersive) return
        immersive = true
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /** 退出全屏：恢复竖屏（UNSPECIFIED = 交回系统/用户设置决定）并显示系统栏。 */
    fun exitFullscreen() {
        if (!immersive) return
        immersive = false
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.show(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * 返回键：全屏时**先退出全屏**，而不是直接退出应用。
     * @return true 表示这次返回被消费掉了（调用方不要再走默认逻辑）
     */
    fun exitFullscreenIfNeeded(): Boolean {
        if (!immersive) return false
        exitFullscreen()
        showControls(true)
        return true
    }

    fun showControls(autoHide: Boolean) = setControlsVisible(true, autoHide)

    private fun setControlsVisible(visible: Boolean, autoHide: Boolean = false) {
        controlsVisible = visible
        overlayTop.visibility = if (visible) View.VISIBLE else View.GONE
        overlayBottom.visibility = if (visible) View.VISIBLE else View.GONE
        handler.removeCallbacks(hideControls)
        // 只有"正在播"才自动淡出：暂停时把控制栏留在画面上，用户才知道怎么继续
        if (visible && autoHide && playingNow) {
            handler.postDelayed(hideControls, CONTROLS_HIDE_DELAY_MS)
        }
    }

    /** 播放过程中用户按了按钮/拖了进度：刷新计时，别让控制栏在操作时消失。 */
    fun keepControlsAlive() {
        if (controlsVisible) showControls(true)
    }

    /** 刷新浮层文字、按钮状态与进度条（每个心跳调一次）。 */
    fun refresh(
        snapshot: PlayerController.Snapshot,
        error: String?,
        notice: String?,
        connectedIp: String?,
        searchingIp: String?,
    ) {
        currentVolume = snapshot.volume
        durationMs = snapshot.durationMs

        val lines = statusLines(
            activity = activity,
            state = snapshot.state,
            title = snapshot.title,
            error = error,
            notice = notice,
            connectedIp = connectedIp,
            searchingIp = searchingIp,
            wiredFaceLabel = null,
        )
        ovTitle.text = lines.state
        ovDetail.text = lines.detail
        ovDetail.setTextColor(activity.getColor(if (error != null) R.color.warn else R.color.text_secondary))

        btnPlay.setImageResource(if (snapshot.playing) R.drawable.ic_pause else R.drawable.ic_play)
        btnPlay.contentDescription =
            activity.getString(if (snapshot.playing) R.string.cd_pause else R.string.cd_play)
        // 规则模式下 playlist 只有标题、没有地址：切集按钮直接禁用，比点了弹提示更清楚
        btnPrev.isEnabled = snapshot.canStepPrev
        btnNext.isEnabled = snapshot.canStepNext
        btnPlay.isEnabled = snapshot.titles.isNotEmpty()
        layer.findViewById<ImageButton>(R.id.btn_playlist).isEnabled = snapshot.titles.isNotEmpty()

        refreshProgress(snapshot)
    }

    private fun refreshProgress(snapshot: PlayerController.Snapshot) {
        tvDur.text = if (durationMs > 0) formatTime(durationMs, unknownTime()) else unknownTime()
        if (dragging) return
        seek.progress = progressOf(snapshot.positionMs, snapshot.durationMs)
        tvPos.text =
            if (snapshot.positionMs > 0) formatTime(snapshot.positionMs, unknownTime()) else unknownTime()
    }

    private fun progressOf(positionMs: Long, totalMs: Long): Int =
        if (totalMs > 0) (positionMs * SEEK_MAX / totalMs).coerceIn(0L, SEEK_MAX.toLong()).toInt() else 0

    private fun unknownTime(): String = activity.getString(R.string.time_unknown)

    fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        // 离开界面时把方向还回去，免得下次进来还是横的
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
}
