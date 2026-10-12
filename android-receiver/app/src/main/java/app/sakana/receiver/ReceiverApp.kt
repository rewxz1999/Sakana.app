package app.sakana.receiver

import android.app.Application
import android.util.Log
import com.shuyu.gsyvideoplayer.GSYVideoManager
import com.shuyu.gsyvideoplayer.player.PlayerFactory
import com.shuyu.gsyvideoplayer.utils.GSYVideoType
import tv.danmaku.ijk.media.exo2.Exo2PlayerManager

private const val TAG = "SakanaApp"

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
        initGsy()
        Settings.init(this)
        // 同步与封面缓存也要在这里初始化：后台线程（SyncManager）可能在界面还没起来时
        // 就去读写它们，晚初始化会直接崩在 lateinit 上。
        // CoverLoader.init 里还会做两件事：建好磁盘封面目录 + 在后台**启动清理一次**
        // （按 LRU 清到上限以内），以及把预取器需要的 Context 准备好。
        SyncManager.init(this)
        CoverLoader.init(this)
    }

    /**
     * 选定 GSY 的内核与渲染方式。**必须在任何播放视图被创建之前做，所以放在 Application 里。**
     *
     * 两件事都不能省：
     *
     * ① `PlayerFactory.setPlayManager(Exo2PlayerManager::class.java)`
     *    GSY 默认用的是 **ijk** 内核（`PlayerFactory.getPlayManager()` 里写死的兜底值），
     *    而 ijk 的原生库（`gsyvideoplayer-arm64` 那一串）我们**故意没有引** ——
     *    不设这一行，第一次播放会以"找不到 ijk 原生库"失败。
     *    exo2 内核用的就是 Media3（和换 GSY 之前的引擎是同一套），所以行为最接近旧版。
     *
     * ② `GSYVideoManager.instance()` 立刻建出来
     *    它是个**进程内单例**，构造时才会去问 `PlayerFactory` 要内核。
     *    这里主动建一次，就等于把"先设内核、再建单例"这个顺序钉死 ——
     *    否则将来某处在 `initGsy()` 之前碰了 GSYVideoManager，就会悄悄退回 ijk。
     *
     * ③ `setRenderType(SURFACE)`：和旧版 `app:surface_type="surface_view"` 对齐。
     *    SurfaceView 不参与 View 的合成，视频功耗更低；控制栏是普通 View，
     *    默认层级在 Surface 之上，所以浮层照样画得出来。
     */
    private fun initGsy() {
        PlayerFactory.setPlayManager(Exo2PlayerManager::class.java)
        GSYVideoType.setRenderType(GSYVideoType.SURFACE)
        GSYVideoManager.instance()
        Log.i(TAG, "GSY 内核已选定：exo2（Media3）+ SurfaceView 渲染")
    }
}
