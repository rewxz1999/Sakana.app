package app.sakana.receiver

import android.view.SurfaceView
import android.view.ViewGroup

/**
 * 「铺满 / 适应」的真正实现：把 GSY 的画面视图**按容器尺寸拉伸**，或者恢复原始比例。
 *
 * ## 为什么不能用 GSY 自己的 `GSYVideoType.setShowType()`
 *
 * 那是 GSY 提供的"画面比例"开关，但**在本工程的布局下是个空操作**（真机验证过：
 * 改了 show type、也 requestLayout 了，画面一点没变）。原因在 GSY 的
 * `MeasureHelper.doMeasure` 字节码里：当宽高两个 measureSpec 都是 `EXACTLY` 时
 * ——正是我们的情况，`surface_container` 是 match_parent、里面那层画面视图也是
 * match_parent——它走的是 `if (widthMode == EXACTLY && heightMode == EXACTLY)` 那段，
 * **只按视频自身的宽高比缩放**，压根不看 `getShowType()`；
 * SCREEN_TYPE_CUSTOM / SCREEN_MATCH_FULL 那几个分支只有在 AT_MOST 约束下才会被走到。
 * 也就是说：要让 GSY 的比例开关生效，就得先把布局改成 AT_MOST ——
 * 那会连带影响全屏铺满和刘海区域，代价远大于收益。
 *
 * ## 所以改成"视图变换"
 *
 * 给那层 SurfaceView 设 scale：
 *  · `setScaleX/Y` 改的是视图变换，**不参与测量**，不会被下一轮 measure 抹掉；
 *  · 画面视图本来就在容器里居中，以中心为轴缩放正好让内容铺满而不偏移；
 *  · 多出来的部分由父容器的 `clipChildren`（默认 true）裁掉。
 *
 * 这也正是旧实现（Media3 的 `RESIZE_MODE_FILL`）的语义：**拉伸**填满、不裁切内容，
 * 只是换了个层面去实现。
 *
 * ## 为什么必须每个心跳都校一次
 *
 * 起播那一瞬间画面视图还没有尺寸、横竖屏切换会重新测量、换一集可能换宽高比 ——
 * 这三件事都会让上一次算出来的比例过期，而它们都**没有"算完了"的回调可挂**。
 * 所以由 `PlayerActions.syncFill()` 在心跳里调这里；成本只有两次比较，
 * 值没变时一个字节都不写。
 *
 * @return false 表示"现在还算不出来"（还没布局、或者找不到画面视图），下次心跳会再试。
 */
internal fun SakanaGsyPlayer.applyFill(fill: Boolean): Boolean {
    val container = findViewById<ViewGroup>(R.id.surface_container) ?: return false
    var surface: SurfaceView? = null
    for (i in 0 until container.childCount) {
        val child = container.getChildAt(i)
        if (child is SurfaceView) {
            surface = child
            break
        }
    }
    val view = surface ?: return false
    val cw = container.width
    val ch = container.height
    val vw = view.width
    val vh = view.height
    if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return false
    val sx = if (fill) cw.toFloat() / vw else 1f
    val sy = if (fill) ch.toFloat() / vh else 1f
    // 只在真的变了的时候赋值：每秒钟都赋一遍会让 SurfaceView 白做一次合成
    if (view.scaleX != sx) view.scaleX = sx
    if (view.scaleY != sy) view.scaleY = sy
    return true
}
