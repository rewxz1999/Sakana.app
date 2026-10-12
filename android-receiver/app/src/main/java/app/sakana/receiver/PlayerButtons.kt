package app.sakana.receiver

import android.app.Activity
import android.app.AlertDialog
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import kotlin.math.abs

/** ±秒按钮的步长：和双击手势保持一致（10 秒），两边不一样会让用户以为是 bug。 */
private const val STEP_MS = 10_000L

/** 点一下音量键变化的档数。 */
private const val VOLUME_STEP = 5

/**
 * GSY 控制栏上那条**业务按钮条**的接线与刷新。
 *
 * 为什么需要这个类：GSY 原生的控制栏里只有播放/暂停、进度、时间、全屏、返回
 * （用户明确要求就用这套原生观感，见 README §5b），而接收端业务上还需要的
 * 选集 / 上一集 / 下一集 / ±10 秒 / 倍速 / 方向锁 / 画面比例 / 音量 / 设置
 * 它一个都没有。这些按钮在 `player_overlay.xml` 里，由 `SakanaGsyPlayer.installExtraBar()`
 * 叠在 GSY 底栏的正上方、跟着它一起显隐；这个类只负责把它们接上，以及每个心跳刷一次状态。
 *
 * 播放/暂停**不在这里**：那是 GSY 原生屏幕中央那个播放键的事（我们不再插一脚），
 * 否则一暂停就有两个播放键，用户会以为是 bug。
 */
internal class PlayerButtons(
    private val activity: Activity,
    private val gsy: SakanaGsyPlayer,
    private val controller: PlayerController,
    private val actions: PlayerActions,
    private val onPlaylist: () -> Unit,
    private val onSettings: () -> Unit,
    private val onRetry: () -> Unit,
    private val onLockOrientation: () -> Unit,
    private val keepAlive: () -> Unit,
) {

    private val prev: ImageButton = gsy.findViewById(R.id.btn_prev)
    private val next: ImageButton = gsy.findViewById(R.id.btn_next)
    private val lockButton: ImageButton = gsy.findViewById(R.id.btn_lock_orientation)
    private val resizeButton: ImageButton = gsy.findViewById(R.id.btn_resize)
    private val speedButton: TextView = gsy.findViewById(R.id.btn_speed)
    private val retryButton: View = gsy.findViewById(R.id.btn_retry)

    /** 倍速菜单的可选项（`speed_options`：0.5x … 2.0x，纯数字标签，不是中文文案）。 */
    private val speedLabels: Array<String> by lazy {
        activity.resources.getStringArray(R.array.speed_options)
    }

    fun bind() {
        gsy.findViewById<ImageButton>(R.id.btn_pick_episode).setOnClickListener {
            keepAlive(); onPlaylist()
        }
        gsy.findViewById<ImageButton>(R.id.btn_settings_player).setOnClickListener {
            keepAlive(); onSettings()
        }
        lockButton.setOnClickListener { keepAlive(); onLockOrientation() }
        resizeButton.setOnClickListener { actions.toggleResize() }

        /*
         * 上一集 / 下一集 / ±10 秒：GSY 一个都没有，是"顺便增加"里必须自己接的。
         * 这也比旧版更准 —— 旧实现里 PlayerController 一次只放**一集**
         * （mediaItemCount == 1），Media3 控制栏上的上一集/下一集其实是灰的、点了没反应。
         */
        prev.setOnClickListener { step(-1) }
        next.setOnClickListener { step(1) }
        gsy.findViewById<TextView>(R.id.btn_rew10).setOnClickListener { seek(-STEP_MS) }
        gsy.findViewById<TextView>(R.id.btn_ffwd10).setOnClickListener { seek(STEP_MS) }

        gsy.findViewById<ImageButton>(R.id.btn_volume_down)
            .setOnClickListener { actions.volumeBy(-VOLUME_STEP) }
        gsy.findViewById<ImageButton>(R.id.btn_volume_up)
            .setOnClickListener { actions.volumeBy(VOLUME_STEP) }

        speedButton.setOnClickListener { keepAlive(); showSpeedMenu() }
        retryButton.setOnClickListener {
            onRetry()
            keepAlive()
        }
    }

    /**
     * 倍速菜单。
     * GSY 的 exo2 内核支持倍速（`setSpeed`），但它的控制栏里**没有倍速入口**
     * （那个"GSY 有倍速按钮"的说法在 14.0.0 上不成立，`video_layout_normal.xml` 里没有），
     * 所以这里自己弹一个：选完走 `PlayerController.setPlaybackSpeed`，
     * 那个值会被写进 GSY 的 options，换集之后仍然保持。
     */
    private fun showSpeedMenu() {
        val current = controller.playbackSpeed
        val index = speedLabels.indexOfFirst { parseSpeed(it) == current }.coerceAtLeast(0)
        AlertDialog.Builder(activity)
            .setTitle(R.string.cd_playback_speed)
            .setSingleChoiceItems(speedLabels, index) { dialog, which ->
                val label = speedLabels[which]
                controller.setPlaybackSpeed(parseSpeed(label))
                // 气泡里就写倍速值本身（"1.25x"）—— 不新造中文文案，也一眼看得懂
                actions.showHint(label)
                refreshSpeedLabel()
                dialog.dismiss()
            }
            .show()
    }

    /** "1.25x" -> 1.25f；解析不了就当 1.0（宁可退化成正常速度，也不要因为一个坏标签崩掉）。 */
    private fun parseSpeed(label: String): Float = label.removeSuffix("x").toFloatOrNull() ?: 1f

    /** 切集：动作本身在 PlayerController（本地有地址就本地切，没有就给人话提示）。 */
    private fun step(delta: Int) {
        if (!controller.control(if (delta > 0) "next" else "prev", 0L)) {
            // control 返回 false 时会留下一条人话提示（"没有下一集可以播了"），
            // 正好借手势气泡显示出来，而不是让它静默失败
            controller.notice()?.let { actions.showHint(it) }
        }
        keepAlive()
    }

    private fun seek(deltaMs: Long) {
        actions.showHint(
            activity.getString(
                if (deltaMs >= 0) R.string.hint_seek_forward else R.string.hint_seek_backward,
                (abs(deltaMs) / 1000).toInt(),
            ),
        )
        actions.seekBy(deltaMs, controller.snapshot().durationMs)
        keepAlive()
    }

    /**
     * 每个心跳刷一次：上一集/下一集的可用性、出错时的「重试」、画面比例图标、方向锁图标、当前倍速。
     * 这些都是"看一眼状态就知道该怎么显示"的东西，不需要额外的事件。
     */
    fun refresh(snapshot: PlayerSnapshot, error: String?, orientationLocked: Boolean) {
        // 规则模式下 playlist 里没有地址：上一集/下一集点了也切不动，索性禁用掉
        setEnabled(prev, snapshot.canStepPrev)
        setEnabled(next, snapshot.canStepNext)
        // 出错时画面是黑的，必须有一个明确的东西告诉用户"出错了、可以重试"
        retryButton.visibility = if (error != null) View.VISIBLE else View.GONE
        resizeButton.setImageResource(
            if (Settings.resizeFill) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen,
        )
        resizeButton.contentDescription = activity.getString(
            if (Settings.resizeFill) R.string.cd_resize_fit else R.string.cd_resize_fill,
        )
        lockButton.contentDescription = activity.getString(
            if (orientationLocked) R.string.cd_unlock_orientation else R.string.cd_lock_orientation,
        )
        refreshSpeedLabel()
    }

    private fun refreshSpeedLabel() {
        // 倍速按钮上直接显示当前倍速，省得用户点开菜单才知道现在是多少
        speedButton.text = speedLabels.firstOrNull { parseSpeed(it) == controller.playbackSpeed }
            ?: activity.getString(R.string.player_speed_1x)
    }

    private fun setEnabled(view: View, enabled: Boolean) {
        view.isEnabled = enabled
        view.alpha = if (enabled) 1f else 0.35f
    }
}
