package app.sakana.receiver

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log

private const val TAG = "SakanaWifiLock"

/**
 * MulticastLock 的薄封装。
 *
 * 为什么需要这把锁：Android 的 Wi-Fi 省电逻辑会过滤掉"目的地址不是本机单播地址"的帧。
 * 屏幕亮着时一般没问题，但设备一旦进入省电策略就可能收不到电脑发的**广播**，
 * 表现就是"偶尔能发现、偶尔发现不了"。MulticastLock 是官方提供的解法
 * （需要 CHANGE_WIFI_MULTICAST_STATE 权限，清单里已声明）。
 *
 * 单独成类的原因：这是一个"有明确生命周期、失败也不致命"的系统资源，
 * 抽出来之后发现服务那边只剩下 start/stop 两行，不会被一堆 try/catch 淹掉主逻辑。
 */
internal class WifiMulticastLock(context: Context) {

    // 只持有 applicationContext：Activity 被重建时持有 Activity 引用会泄漏
    private val appContext = context.applicationContext
    private var lock: WifiManager.MulticastLock? = null

    fun acquire() {
        if (lock != null) return
        try {
            val wm = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
            val created = wm.createMulticastLock("sakana-receiver")
            // 不做引用计数：我们只申请一次、释放一次，引用计数反而容易出现"没人释放"
            created.setReferenceCounted(false)
            created.acquire()
            lock = created
        } catch (t: Throwable) {
            // 拿不到锁不影响主流程：多数设备上广播照样能收，只是省电时可能漏收
            Log.w(TAG, "获取 MulticastLock 失败: ${t.message}")
        }
    }

    fun release() {
        try {
            lock?.takeIf { it.isHeld }?.release()
        } catch (_: Throwable) {
            // 忽略
        }
        lock = null
    }
}
