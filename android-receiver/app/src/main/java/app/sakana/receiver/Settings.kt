package app.sakana.receiver

import android.content.Context
import android.content.SharedPreferences
import android.os.Build

/**
 * 用户设置：设备名、控制端口、首选网卡、主动连接的电脑地址、以及几个开关。
 *
 * 为什么用 SharedPreferences 而不是自己写文件：本工程刻意不引第三方依赖，
 * 而 SharedPreferences 是系统自带的、进程内共享、改完立刻生效，
 * 正好满足"设置页改完，接收端界面/服务马上跟上"的需求。
 *
 * [init] 在 Application 里调一次（见 ReceiverApp）；其余方法都是纯读写，谁都能用。
 */
object Settings {

    private const val PREFS = "sakana-receiver"

    private const val K_NAME = "device-name"
    private const val K_PORT = "control-port"
    private const val K_KEEP_ON = "keep-screen-on"
    private const val K_AUTOPLAY = "autoplay"
    private const val K_BOOT = "auto-open-on-boot"
    private const val K_FACE = "preferred-interface"
    private const val K_PEER = "manual-peer"
    private const val K_RECENT = "recent-peers"

    /** 最近地址最多留几条：留太多设置页会变成一屏历史，反而不好点。 */
    private const val RECENT_MAX = 8

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (!::prefs.isInitialized) {
            prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        }
    }

    // ---------------- 设备名 ----------------

    /** 电脑端发现列表里显示的名字。默认用设备型号。 */
    var deviceName: String
        get() = prefs.getString(K_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(value) {
            val v = value.trim()
            // 存空串等于"没设置过"，读取时会回落到型号，所以这里直接删掉这个键
            if (v.isEmpty()) prefs.edit().remove(K_NAME).apply() else prefs.edit().putString(K_NAME, v).apply()
        }

    private fun defaultName(): String =
        Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android 接收端"

    // ---------------- 控制端口 ----------------

    /**
     * 控制接口的**期望**端口（默认 52889）。
     * 实际监听的端口可能是它顺延后的值 —— 端口被别的程序占用时会自动 +1，
     * 真实端口由 Receiver.actualPort 暴露（界面上显示的就是真实端口）。
     */
    var controlPort: Int
        get() = prefs.getInt(K_PORT, Proto.DEFAULT_CONTROL_PORT)
        set(value) = prefs.edit().putInt(K_PORT, value.coerceIn(1024, 65535)).apply()

    // ---------------- 开关 ----------------

    /** 保持屏幕常亮（默认开：接收端黑屏会连带 Wi-Fi 省电，发现与控制都不稳）。 */
    var keepScreenOn: Boolean
        get() = prefs.getBoolean(K_KEEP_ON, true)
        set(value) = prefs.edit().putBoolean(K_KEEP_ON, value).apply()

    /** 收到 /play 是否立刻播放（默认开）。关掉时只加载并暂停，等电脑端发 resume。 */
    var autoPlay: Boolean
        get() = prefs.getBoolean(K_AUTOPLAY, true)
        set(value) = prefs.edit().putBoolean(K_AUTOPLAY, value).apply()

    /**
     * 开机后是否尝试自动打开接收端（默认关）。
     * ⚠️ Android 10 起系统禁止应用在后台启动界面，所以这个开关在现代系统上**不一定生效**，
     * 设置页里也如实写了这一点（见 strings.xml 的 set_boot_hint）。
     */
    var autoOpenOnBoot: Boolean
        get() = prefs.getBoolean(K_BOOT, false)
        set(value) = prefs.edit().putBoolean(K_BOOT, value).apply()

    // ---------------- 首选网络接口 ----------------

    /**
     * 首选网卡的名字（例如 `wlan0` / `rndis0` / `eth0`）；null 表示"自动挑一个"。
     *
     * 为什么要让用户选：设备同时有多块网卡时（Wi-Fi + USB 网络共享 + 蓝牙共享），
     * "该在哪个网段上广播、该把哪个地址报给电脑"是**没法自动判断**的 ——
     * 自动挑通常会挑到 Wi-Fi，而用户要的可能是 USB 直连那个 192.168.42.x。
     */
    var preferredInterface: String?
        get() = prefs.getString(K_FACE, null)?.takeIf { it.isNotBlank() }
        set(value) = prefs.edit().putString(K_FACE, value).apply()

    // ---------------- 主动连接电脑 ----------------

    /**
     * 用户手填的电脑地址（`192.168.1.20` 或 `192.168.1.20:52890`，端口其实是发现端口）。
     *
     * 用途：广播在 USB 网络共享 / 跨网段 / AP 隔离的 Wi-Fi 上常常不通，
     * 这时接收端会**向这个地址单播**自己的宣告报文（见 DiscoveryService），
     * 电脑收到就会把本机加进设备列表 —— 相当于"接收端主动连电脑"。
     */
    var manualPeer: String?
        get() = prefs.getString(K_PEER, null)?.takeIf { it.isNotBlank() }
        set(value) {
            val v = value?.trim()?.takeIf { it.isNotEmpty() }
            prefs.edit().putString(K_PEER, v).apply()
            if (v != null) rememberPeer(v)
        }

    /** 最近用过的电脑地址（最新的在最前）。 */
    val recentPeers: List<String>
        get() = prefs.getString(K_RECENT, null)
            ?.split('\n')
            ?.filter { it.isNotBlank() }
            ?: emptyList()

    private fun rememberPeer(addr: String) {
        val list = ArrayList(recentPeers)
        list.remove(addr)
        list.add(0, addr)
        while (list.size > RECENT_MAX) list.removeAt(list.size - 1)
        prefs.edit().putString(K_RECENT, list.joinToString("\n")).apply()
    }
}
