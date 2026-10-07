package app.sakana.receiver

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * "真正的全屏"这件事的全部细节。
 *
 * 为什么单独成类（而不是留在 PlaybackUi）：用户报的"不能完全全屏"其实是三件独立的事没做全，
 * 集中在一处才好对照着看 ——
 *   ① **内容铺到系统栏底下**：只 hide(systemBars()) 是不够的，还要
 *      `setDecorFitsSystemWindows(false)`，否则窗口内容区域仍然被系统栏"顶开"，
 *      全屏时画面上下会留出系统栏高度的空白（看起来就像没全屏）；
 *   ② **画进刘海/挖孔**：主题里的 `windowLayoutInDisplayCutoutMode=shortEdges`
 *      （在 themes.xml，API 28 以下会被忽略），这里不重复设置；
 *   ③ **横屏 + 隐藏系统栏 + 从边缘能划出来**：`SENSOR_LANDSCAPE`（两边都能用）+
 *      `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`。
 * 退出时三件事都要还原（`UNSPECIFIED` + 显示系统栏 + 恢复 decorFits）。
 */
internal class FullscreenController(private val activity: Activity) {

    /** 是否处于"横屏全屏"。 */
    var immersive: Boolean = false
        private set

    /** 方向是否被用户锁定（锁定后不跟随重力感应）。 */
    var orientationLocked: Boolean = false
        private set

    fun enter() {
        // ① 内容不要被系统栏顶开 —— 这是"完全全屏"的前提
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        if (!immersive) {
            immersive = true
            activity.requestedOrientation = if (orientationLocked) {
                ActivityInfo.SCREEN_ORIENTATION_LOCKED
            } else {
                // 用 SENSOR_LANDSCAPE 而不是 LANDSCAPE：设备放在支架上、或 HDMI 方向不同时不用倒过来
                ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }
        }
        // ② 隐藏状态栏/导航栏；从边缘划一下能临时唤出（不然用户以为系统栏被吃掉了）
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        insets.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insets.hide(WindowInsetsCompat.Type.systemBars())
    }

    fun exit() {
        WindowCompat.setDecorFitsSystemWindows(activity.window, true)
        if (immersive) {
            immersive = false
            // UNSPECIFIED = 交回系统/用户设置决定（不是硬锁竖屏）
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        insets.show(WindowInsetsCompat.Type.systemBars())
    }

    /** 返回键：全屏时**先退全屏**（不退出播放、更不退出应用）。返回 true 表示已消费这次返回。 */
    fun exitIfNeeded(): Boolean {
        if (!immersive) return false
        exit()
        return true
    }

    /** 切换方向锁定。@return 切换后的状态（true = 已锁定）。 */
    fun toggleOrientationLock(): Boolean {
        orientationLocked = !orientationLocked
        activity.requestedOrientation = if (orientationLocked) {
            // LOCKED = 锁在当前方向；解锁后回到"横屏任意一边"
            ActivityInfo.SCREEN_ORIENTATION_LOCKED
        } else {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
        return orientationLocked
    }

    fun onDestroy() {
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        WindowCompat.setDecorFitsSystemWindows(activity.window, true)
    }
}
