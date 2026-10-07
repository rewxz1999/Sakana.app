package app.sakana.receiver

import android.app.Application

/**
 * 应用入口：把几个"运行期需要 Context"的单例准备好。
 *
 * 为什么要有个 Application 子类：设备名/端口/同步缓存会被 Application、Activity、
 * BroadcastReceiver（开机自启）三处用到，与其在每个入口都记得初始化，
 * 不如在进程启动时集中做一次。
 */
class ReceiverApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Settings.init(this)
        // 同步与封面缓存也要在这里初始化：后台线程（SyncManager）可能在界面还没起来时
        // 就去读写它们，晚初始化会直接崩在 lateinit 上
        SyncManager.init(this)
        CoverLoader.init(this)
    }
}
