package app.sakana.receiver

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageButton
import android.widget.TextView

/** 手势提示气泡的显示时长。 */
private const val HINT_MS = 900L

/**
 * 播放层里那些"具体动作"：提示气泡、亮度、音量、画面比例。
 *
 * 为什么从 `PlaybackUi` 拆出来（而不是继续堆在一个类里）：
 * `PlaybackUi` 真正不可替代的职责只有三件 —— 两个形态的切换、横屏全屏、以及
 * **控制栏显隐的接线**。剩下的音量/亮度/提示气泡/铺满这些都是"拿一个值、改一个地方"
 * 的小动作，混在一起会把那个文件顶过 300 行，也让人看不清主干。
 *
 * 提示气泡放在这里而不是单独一个类：它只有 [show]/[hide] 两个动作，
 * 而且每一个动作（调音量、调亮度、锁方向、切铺满）都要弹一句，分开反而要来回跳两个文件。
 */
internal class PlayerActions(
    private val activity: Activity,
    private val gsy: SakanaGsyPlayer,
    private val controller: PlayerController,
) {

    private val handler = Handler(Looper.getMainLooper())
    private val hintView: TextView = gsy.findViewById(R.id.player_hint)
    private val resizeButton: ImageButton = gsy.findViewById(R.id.btn_resize)
    private val dismissHint = Runnable { hintView.visibility = View.GONE }

    /**
     * 由 `PlaybackUi` 注入：任何一次操作之后都要"重新计时"（免得用户正在动的时候控制栏淡出）。
     * 用可变字段而不是构造参数，是为了避免构造顺序上的循环依赖。
     */
    var keepAliveHook: () -> Unit = {}

    fun showHint(text: String) {
        hintView.text = text
        hintView.visibility = View.VISIBLE
        handler.removeCallbacks(dismissHint)
        handler.postDelayed(dismissHint, HINT_MS)
    }

    fun hideHint() {
        handler.removeCallbacks(dismissHint)
        hintView.visibility = View.GONE
    }

    fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
    }

    /** 手势拖动时的实时提示（时间位置的预览）。 */
    fun showSeekPreview(positionMs: Long, deltaMs: Long, durationMs: Long) {
        val unknown = activity.getString(R.string.time_unknown)
        val target = (positionMs + deltaMs).coerceAtLeast(0L)
        showHint("${formatTime(target, unknown)} / ${formatTime(durationMs, unknown)}")
    }

    /** 双击快进/快退：提示 + 真正 seek（一次性，不是边拖边跳）。 */
    fun seekBy(deltaMs: Long, durationMs: Long) {
        val position = controller.snapshot().positionMs
        var target = (position + deltaMs).coerceAtLeast(0L)
        if (durationMs > 0) target = target.coerceAtMost(durationMs)
        controller.control("seek", target)
    }

    /** 音量：走同一条 /control 路径，这样电脑端读 /info 拿到的音量也一致。 */
    fun volumeBy(delta: Int) {
        val target = (controller.snapshot().volume + delta).coerceIn(0, 100)
        controller.control("volume", target.toLong())
        showHint(activity.getString(R.string.hint_volume, target))
        keepAliveHook()
    }

    fun setVolume(percent: Int) {
        controller.control("volume", percent.coerceIn(0, 100).toLong())
        showHint(activity.getString(R.string.hint_volume, percent))
        keepAliveHook()
    }

    fun setBrightness(percent: Int) {
        val attrs = activity.window.attributes
        attrs.screenBrightness = percent.coerceIn(5, 100) / 100f
        activity.window.attributes = attrs
        showHint(activity.getString(R.string.hint_brightness, percent))
    }

    fun brightness(): Int {
        val value = activity.window.attributes.screenBrightness
        return if (value < 0f) 100 else (value * 100).toInt().coerceIn(5, 100)
    }

    // ---------------- 画面比例（适应 / 铺满） ----------------

    /** 铺满：fit = 按比例（可能留黑边），fill = 撑满屏幕（消除黑边）。 */
    fun toggleResize() {
        Settings.resizeFill = !Settings.resizeFill
        applyResizeMode()
        showHint(
            activity.getString(if (Settings.resizeFill) R.string.toast_resize_fill else R.string.toast_resize_fit),
        )
        keepAliveHook()
    }

    fun applyResizeMode() {
        val fill = Settings.resizeFill
        syncFill()
        resizeButton.setImageResource(if (fill) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen)
        resizeButton.contentDescription = activity.getString(
            if (fill) R.string.cd_resize_fit else R.string.cd_resize_fill,
        )
    }

    /**
     * 把当前比例套到画面上。**每个心跳都会调一次**（成本只有两次比较）：
     * 起播那一瞬间画面视图还没有尺寸、横竖屏切换会重新测量、换一集可能换宽高比 ——
     * 这三件事都会让上一次算出来的比例过期，而它们都没有"算完了"的回调可挂。
     * 具体怎么拉伸（以及为什么不用 GSY 自己的 show type）见 `SakanaGsyPlayer.applyFill`。
     */
    fun syncFill() {
        gsy.applyFill(Settings.resizeFill)
    }

    /** 视图尺寸变了（横竖屏切换、进出播放层）时会被调用一次。 */
    fun onPlayerSizeChanged() {
        syncFill()
    }
}
