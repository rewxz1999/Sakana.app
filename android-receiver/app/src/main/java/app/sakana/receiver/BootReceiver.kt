package app.sakana.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

private const val TAG = "SakanaBoot"

/**
 * 开机自启（设置里的"开机后尝试自动打开接收端"，默认关）。
 *
 * ⚠️ **如实说明**：Android 10 起系统禁止应用在后台启动界面
 * （Background Activity Start 限制），所以这里 `startActivity` 在**大多数现代设备上会被静默拦下**，
 * 只有部分定制 ROM / 旧版本才会真的弹出界面。这一点在设置页里也写清楚了。
 *
 * 真正可靠的做法是把接收端做成**前台服务**（需要 FOREGROUND_SERVICE 权限 + 常驻通知），
 * 那是一次架构改动，本期没做 —— 见 README 的"已知限制"。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Settings.autoOpenOnBoot) return
        try {
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "开机自动打开被系统拦下了（Android 10+ 的正常行为）: ${t.message}")
        }
    }
}
