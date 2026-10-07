package app.sakana.receiver

import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.abs
import kotlin.math.max

/**
 * 播放器手势。用户说"播放器太简陋"的关键就在这一块 ——
 * Media3 的官方控制栏负责按钮与进度拖动，但**手势要自己写**，这里把常见播放器的那套补齐：
 *
 *   · 单击画面            → 显示/隐藏控制栏
 *   · 双击左/右半屏       → 快退/快进 10 秒（连续双击累加，最多 60 秒）
 *   · 右侧上下滑          → 调音量
 *   · 左侧上下滑          → 调亮度
 *   · 横向滑动            → 拖动进度（松手才真的 seek）
 *   · 长按                → 2 倍速播放（松手恢复）
 *
 * 为什么用"按下时的值 + 位移比例"而不是"每帧增量"来算音量/亮度：
 * 增量方式会把每帧的取整误差累积起来，手指划回原位时数值回不到原值，手感会飘。
 *
 * 本类**只产生语义事件**，不碰播放器也不碰界面（提示气泡由 PlaybackUi 显示），
 * 这样手势逻辑能独立读，也方便以后换 UI。
 *
 * @param view 手势作用的视图，用它自己的宽高做换算（竖屏/横屏都对）。
 */
internal class PlayerGestures(
    private val view: View,
    private val listener: Listener,
) {

    interface Listener {
        /** 当前音量（0-100），手势以此为基准。 */
        val volumePercent: Int

        /** 当前亮度（0-100）。 */
        val brightnessPercent: Int

        /** 总时长（毫秒）；横向滑动按"整屏宽度 = 整部时长"换算。 */
        val durationMs: Long

        fun onToggleControls()

        /** 双击快进/快退（已累加的总毫秒数，带符号）。 */
        fun onSeekBy(deltaMs: Long)

        /** 长按 2 倍速：true 开始，false 结束。 */
        fun onSpeed(active: Boolean)

        fun onVolume(percent: Int)

        fun onBrightness(percent: Int)

        /** 横向拖动中的预览。 */
        fun onSeekPreview(deltaMs: Long)

        /** 横向拖动松手：真正 seek。 */
        fun onSeekCommit(deltaMs: Long)
    }

    private enum class Mode { NONE, SEEK, VOLUME, BRIGHTNESS }

    private val touchSlop = ViewConfiguration.get(view.context).scaledTouchSlop

    private var mode = Mode.NONE
    private var downX = 0f
    private var downY = 0f
    private var baseVolume = 100
    private var baseBrightness = 100
    private var speedActive = false

    /** 双击累加：短时间内继续双击就在已有的基础上再加 10 秒。 */
    private var accumulatedMs = 0L
    private var lastDoubleTapAt = 0L
    private var lastTapSide = 0

    private val detector = GestureDetector(
        view.context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                listener.onToggleControls()
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                val now = System.currentTimeMillis()
                val side = if (e.x < viewWidth() / 2f) -1 else 1
                // 1.2 秒内、同一侧继续双击才算连击，否则从头开始算
                if (now - lastDoubleTapAt > DOUBLE_TAP_GROUP_MS || side != lastTapSide) accumulatedMs = 0L
                lastDoubleTapAt = now
                lastTapSide = side
                accumulatedMs = (accumulatedMs + side * STEP_MS)
                    .coerceIn(-MAX_ACCUMULATED_MS, MAX_ACCUMULATED_MS)
                listener.onSeekBy(accumulatedMs)
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                // 已经在滑动（seek/音量/亮度）时长按不算倍速，避免两种手势叠在一起
                if (mode != Mode.NONE) return
                speedActive = true
                listener.onSpeed(true)
            }
        },
    )

    fun onTouchEvent(event: MotionEvent): Boolean {
        detector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                mode = Mode.NONE
                downX = event.x
                downY = event.y
                baseVolume = listener.volumePercent
                baseBrightness = listener.brightnessPercent
            }

            MotionEvent.ACTION_MOVE -> {
                val dx = event.x - downX
                val dy = event.y - downY

                // 还没定方向：超过 slop 后按"位移更大的那根轴"决定这一手势是什么
                if (mode == Mode.NONE) {
                    if (abs(dx) < touchSlop && abs(dy) < touchSlop) return true
                    if (speedActive) {
                        speedActive = false
                        listener.onSpeed(false)
                    }
                    mode = if (abs(dx) >= abs(dy)) {
                        Mode.SEEK
                    } else if (downX < viewWidth() / 2f) {
                        Mode.BRIGHTNESS // 左半屏
                    } else {
                        Mode.VOLUME // 右半屏
                    }
                }

                when (mode) {
                    Mode.SEEK -> listener.onSeekPreview(dxToMs(dx))
                    // 垂直：向上滑是加，所以取 -dy；整屏高度映射 100 个单位
                    Mode.VOLUME -> listener.onVolume(
                        (baseVolume - dy / viewHeight() * 100f).toInt().coerceIn(0, 100),
                    )
                    Mode.BRIGHTNESS -> listener.onBrightness(
                        (baseBrightness - dy / viewHeight() * 100f).toInt().coerceIn(0, 100),
                    )
                    Mode.NONE -> Unit
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (mode == Mode.SEEK) listener.onSeekCommit(dxToMs(event.x - downX))
                if (speedActive) {
                    speedActive = false
                    listener.onSpeed(false)
                }
                mode = Mode.NONE
            }
        }
        return true
    }

    /** 横向位移 → 时间位移：整屏宽度 ≈ 整部时长；时长未知（直播）时按一小段估算。 */
    private fun dxToMs(dx: Float): Long {
        val total = if (listener.durationMs > 0) listener.durationMs else FALLBACK_SPAN_MS
        return (dx / viewWidth() * total).toLong()
    }

    private fun viewWidth(): Float = max(1f, view.width.toFloat())

    private fun viewHeight(): Float = max(1f, view.height.toFloat())

    private companion object {
        /** 双击一次的步长：10 秒（与 Media3 控制栏上的 ±10 秒按钮保持一致）。 */
        const val STEP_MS = 10_000L

        /** 连击累加的上限。 */
        const val MAX_ACCUMULATED_MS = 60_000L

        /** 两次双击之间超过这个间隔就不算连击了。 */
        const val DOUBLE_TAP_GROUP_MS = 1_200L

        /** 时长未知（直播）时，一整屏横向滑动约等于 90 秒。 */
        const val FALLBACK_SPAN_MS = 90_000L
    }
}
