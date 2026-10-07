package app.sakana.receiver

import android.content.Context
import android.os.SystemClock
import android.util.Log

private const val TAG = "SakanaReceiver"

/**
 * 接收端运行期外壳：把「HTTP 控制服务」和「UDP 发现服务」这两件与界面无关的东西收在一个单例里。
 *
 * 为什么要有它：设置页要能改控制端口 / 首选网卡，改完必须让服务**重启**；
 * 而界面（MainActivity）随时可能被销毁重建。如果服务由 Activity 直接持有，
 * "在设置页改端口"和"界面被回收"这两件事会互相打架。
 *
 * 播放器不在这里：它绑在 PlayerView 上，天然属于界面。界面活着时通过 [gateway]
 * 把自己注册进来，界面销毁就置空 —— 这时控制接口会明确回"接收端界面没有打开"，
 * 而不是崩在一个已经释放的 ExoPlayer 上。
 *
 * ⚠️ 仍然**没有前台 Service**：进程一被系统回收，这一切就都停了。
 * 这是本工程刻意的取舍（不申请 WAKE_LOCK / FOREGROUND_SERVICE），README 的"已知限制"里有说明。
 */
object Receiver {

    /** 界面活着时注册进来；没有界面时为 null。 */
    @Volatile
    var gateway: PlayerGateway? = null

    /** 真正在监听的端口（设置里的值被占用时会顺延）。没启动时是 -1。 */
    @Volatile
    var actualPort: Int = -1
        private set

    /** 设置里的端口没能绑上、顺延到了别的端口。界面据此提示用户以实际端口为准。 */
    @Volatile
    var portShifted: Boolean = false
        private set

    /** 启动失败原因（端口全被占用等），"关于"页会显示。 */
    @Volatile
    var lastError: String? = null
        private set

    // ---- 连接状态：谁在跟我说话 ----

    /** 最近一次收到 HTTP 请求的电脑地址（"已被 xxx 连接"就是它）。 */
    @Volatile
    var lastClientIp: String? = null
        private set

    @Volatile
    private var lastClientAt = 0L

    /** 收到过多少次 HTTP 请求（"关于"页显示的已连接次数）。 */
    @Volatile
    var requestCount: Int = 0
        private set

    /** 最近一次收到电脑"搜索"报文的地址（电脑已经在找我们、但还没连上时显示）。 */
    @Volatile
    var searchFromIp: String? = null
        private set

    @Volatile
    private var searchAt = 0L

    private var server: ControlServer? = null
    private var discovery: DiscoveryService? = null

    /** 启动时用的配置，用来判断"设置改过了没"。 */
    private var startedPort: Int = -1
    private var startedFace: String? = null

    /** 多久没收到请求就不再认为"正连着"。电脑端会在投屏面板打开时轮询 /info，60 秒足够宽松。 */
    private const val ACTIVE_WINDOW_MS = 60_000L

    /** 搜索提示的时效（电脑每 10 秒探测一次，取 15 秒免得闪来闪去）。 */
    private const val SEARCH_WINDOW_MS = 15_000L

    val running: Boolean get() = server != null

    // ---------------- 生命周期 ----------------

    fun start(context: Context) {
        if (server != null) return
        lastError = null

        val api = ControlApi(
            gateway = { gateway },
            deviceName = { Settings.deviceName },
            autoPlay = { Settings.autoPlay },
            onClient = { noteClient(it) },
        )

        val want = Settings.controlPort
        val srv = ControlServer(api)
        try {
            actualPort = srv.start(want)
        } catch (t: Throwable) {
            lastError = "控制服务启动失败：${t.message}"
            Log.e(TAG, lastError!!)
            return
        }
        portShifted = actualPort != want
        server = srv
        startedPort = want
        startedFace = Settings.preferredInterface
        if (portShifted) {
            Log.w(TAG, "端口 $want 被占用，已改用 $actualPort")
        }

        discovery = DiscoveryService(
            context = context,
            deviceName = { Settings.deviceName },
            // 发现报文里必须报**真实**端口，否则电脑端会往 52889 发请求而那里没人听
            controlPort = { actualPort },
            preferredFace = { Settings.preferredInterface },
            manualPeer = { Settings.manualPeer },
            onPeer = { noteSearch(it) },
        ).also { it.start() }

        Log.i(TAG, "接收端已启动: 控制端口 $actualPort，网卡 ${startedFace ?: "自动"}")
    }

    fun stop() {
        discovery?.stop()
        discovery = null
        server?.stop()
        server = null
        actualPort = -1
        startedPort = -1
        startedFace = null
    }

    /**
     * 设置改过之后调它：端口或首选网卡变了就重启服务，其它设置（设备名、自动播放…）
     * 是通过 lambda 实时读取的，不需要重启。
     */
    fun applyConfig(context: Context) {
        if (server == null) {
            start(context)
            return
        }
        val portChanged = startedPort != Settings.controlPort
        val faceChanged = startedFace != Settings.preferredInterface
        if (portChanged || faceChanged) {
            Log.i(TAG, "设置变化（端口=$portChanged 网卡=$faceChanged），重启接收服务")
            stop()
            start(context)
        }
    }

    /** 立刻向某个电脑地址单播一次宣告（设置页点"连接电脑"时用）。 */
    fun announceTo(addr: String) {
        discovery?.announceOnce(addr)
    }

    // ---------------- 连接状态 ----------------

    private fun noteClient(ip: String) {
        lastClientIp = ip
        lastClientAt = SystemClock.elapsedRealtime()
        requestCount++
    }

    private fun noteSearch(ip: String) {
        searchFromIp = ip
        searchAt = SystemClock.elapsedRealtime()
        // 看到电脑就顺手问一句"你的同步服务在不在" —— 这是"自动连接"最省事的一条路径：
        // 用户在电脑上打开投屏面板，接收端这边就自己把收藏拉过来了，不需要点任何按钮。
        SyncManager.onPcSeen(ip)
    }

    /** 是不是"电脑正连着"：最近 60 秒内收到过它的请求。 */
    fun isConnected(): Boolean =
        requestCount > 0 && SystemClock.elapsedRealtime() - lastClientAt < ACTIVE_WINDOW_MS

    /** 电脑正在搜索本设备（收到过搜索报文，但还没连上）。 */
    fun isSearching(): Boolean =
        !isConnected() && searchFromIp != null &&
            SystemClock.elapsedRealtime() - searchAt < SEARCH_WINDOW_MS

    /** 距离上次收到请求过了多久（毫秒）；从没收到过时返回 -1。 */
    fun idleSinceClientMs(): Long =
        if (requestCount == 0) -1L else SystemClock.elapsedRealtime() - lastClientAt
}
