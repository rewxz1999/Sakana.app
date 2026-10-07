package app.sakana.receiver

import android.content.Context
import android.os.SystemClock
import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets

private const val TAG = "SakanaUdp"

/** 收到一次报文后 socket 就绪等待的超时。用来充当"每 5 秒宣告一次"的节拍器。 */
private const val RECEIVE_TICK_MS = 1000

/** 绑定 52888 失败后的重试间隔。 */
private const val BIND_RETRY_MS = 3000L

/**
 * 局域网发现服务（UDP 52888）。
 *
 * **为什么要用广播**：电脑和安卓设备在局域网里互相不认识 —— 电脑不知道设备 IP，
 * 设备也不知道电脑什么时候上线。广播是唯一"零配置"就能让双方互相找到的办法。
 * 这里同时做三件事，覆盖"谁先启动"以及"广播不通"的所有情况：
 *   ① 应答式：电脑广播 `{"sakana":"discover","v":1,"host":"<PC的IP>"}` →
 *      我们**单播**回自己的信息。电脑一打开投屏界面就能立刻拿到结果。
 *   ② 宣告式：我们每 5 秒广播一次自己的信息，让"接收端先开着、电脑后打开"也能被发现
 *      （电脑端的设备表 60 秒过期，5 秒一次足够稳）。
 *   ③ **主动连电脑**：如果用户在设置里填了电脑地址，就额外向那个地址**单播**同一份报文。
 *      这是 USB 网络共享 / 跨网段 / AP 隔离 Wi-Fi 下唯一还能工作的路径 ——
 *      那些场景里广播根本出不了本网段，但"我知道你在哪，直接发给你"总是可行的。
 *
 * ⚠️ 报文里的 `host` 字段是**必须的**：电脑端不看到来源地址，只读报文里的 `host`
 * 来决定连哪个地址，取不到就把这台设备丢掉。所以 `host` 填的是**本机在选定网卡上的地址**。
 *
 * 关于应答为什么必须单播：广播回复在各平台上都不可靠（客户端还得额外绑端口才能收到），
 * 而 UDP 报文的源地址里就带着电脑的地址和端口。
 */
class DiscoveryService(
    context: Context,
    private val deviceName: () -> String,
    private val controlPort: () -> Int,
    private val preferredFace: () -> String?,
    private val manualPeer: () -> String?,
    /** 收到电脑的搜索报文时回调，参数是电脑的地址（用于界面显示"电脑正在搜索"）。 */
    private val onPeer: (String) -> Unit,
) {

    @Volatile
    private var running = false

    /** 最近一次失败原因（端口被占用等），界面的"关于"页会显示出来。 */
    @Volatile
    var lastError: String? = null
        private set

    private var thread: Thread? = null

    /** Wi-Fi 省电会过滤广播帧，用 MulticastLock 顶住（细节见 WifiMulticastLock.kt）。 */
    private val wifiLock = WifiMulticastLock(context)

    fun start() {
        if (running) return
        running = true
        wifiLock.acquire()
        thread = Thread({ loop() }, "sakana-udp").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "发现服务已启动: UDP ${Proto.DISCOVER_PORT}")
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
        wifiLock.release()
    }

    /**
     * 立刻向某个电脑地址单播一次宣告（设置页里点"连接"时调用）。
     * 用一次性 socket，不影响主循环。
     */
    fun announceOnce(target: String) {
        val ip = target.substringBefore(':').trim()
        if (ip.isEmpty()) return
        Thread({
            val sock = openSendSocket(Lan.effectiveFace(preferredFace()))
            try {
                sendTo(sock, receiverJson(), ip, Proto.DISCOVER_PORT)
            } finally {
                try {
                    sock?.close()
                } catch (_: Throwable) {
                    // 忽略
                }
            }
        }, "sakana-udp-once").apply { isDaemon = true }.start()
    }

    private fun loop() {
        var recv: DatagramSocket? = null
        var send: DatagramSocket? = null
        var sendFaceName: String? = null
        var lastAnnounce = 0L
        var lastPeer: String? = null
        val buf = ByteArray(2048)

        while (running) {
            val r = recv ?: tryBind()?.also { recv = it }
            if (r == null) {
                // 52888 被别的程序（或本应用的另一个实例）占着：过一会儿再试。
                // 这期间 HTTP 控制接口照常工作，用户还可以手填地址，功能不受影响。
                sleepQuietly(BIND_RETRY_MS)
                continue
            }

            // 发送用的 socket 要**绑定到选定网卡**，广播才会从那块网卡出去。
            // 网卡被换掉（插拔 USB）时重建一次。
            val face = Lan.effectiveFace(preferredFace())
            if (send == null || sendFaceName != face?.name) {
                try {
                    send?.close()
                } catch (_: Throwable) {
                    // 忽略
                }
                send = openSendSocket(face)
                sendFaceName = face?.name
            }

            try {
                val packet = DatagramPacket(buf, buf.size)
                // 阻塞最多 RECEIVE_TICK_MS：收到就立刻处理，超时就去检查"该不该宣告了"。
                // 用一个超时省掉一个额外的定时线程。
                r.receive(packet)
                onPacket(send ?: r, packet)
            } catch (_: SocketTimeoutException) {
                // 正常：这一秒没有报文
            } catch (e: Exception) {
                if (!running) break
                Log.w(TAG, "UDP 接收失败: ${e.message}")
            }

            val peer = manualPeer()
            val peerChanged = peer != lastPeer
            lastPeer = peer

            val now = SystemClock.elapsedRealtime() // 单调时钟：不受用户改系统时间影响
            if (peerChanged || now - lastAnnounce >= Proto.ANNOUNCE_INTERVAL_MS) {
                lastAnnounce = now
                val sender = send ?: r
                announce(sender, face)
                // 主动连电脑：不管广播通不通，都再往手填的地址单播一份
                if (!peer.isNullOrBlank()) {
                    sendTo(sender, receiverJson(), peer.substringBefore(':').trim(), Proto.DISCOVER_PORT)
                }
            }
        }

        for (s in listOf(recv, send)) {
            try {
                s?.close()
            } catch (_: Exception) {
                // 忽略
            }
        }
    }

    private fun tryBind(): DatagramSocket? = try {
        lastError = null
        DatagramSocket(null).apply {
            // 允许和同端口的其它 socket 共存（电脑端在本机联调时也绑 52888），
            // 也方便本应用自己快速重启。
            reuseAddress = true
            broadcast = true
            soTimeout = RECEIVE_TICK_MS
            // 接收必须绑 0.0.0.0：广播会从任意一块网卡进来，只绑一块会漏掉另一块网段上的电脑
            bind(InetSocketAddress(Proto.DISCOVER_PORT))
        }
    } catch (e: Exception) {
        lastError = "UDP ${Proto.DISCOVER_PORT} 绑定失败：${e.message}"
        Log.w(TAG, lastError!!)
        null
    }

    /** 发送用的 socket：绑定到选定网卡，这样广播/单播才会从这块网卡出去。 */
    private fun openSendSocket(face: NetFace?): DatagramSocket? {
        try {
            return DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                bind(InetSocketAddress(face?.ip ?: "0.0.0.0", 0))
            }
        } catch (t: Throwable) {
            // 绑定到那块网卡失败（刚被拔掉/地址变了）：退化成不绑定具体地址，靠系统路由
            Log.w(TAG, "绑定网卡 ${face?.ip} 失败，改用默认路由: ${t.message}")
            return try {
                DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress("0.0.0.0", 0))
                }
            } catch (t2: Throwable) {
                Log.w(TAG, "创建发送 socket 失败: ${t2.message}")
                null
            }
        }
    }

    /** 处理一个收到的 UDP 报文。 */
    private fun onPacket(sender: DatagramSocket, packet: DatagramPacket) {
        val text = String(packet.data, packet.offset, packet.length, StandardCharsets.UTF_8).trim()
        if (text.isEmpty()) return

        val obj = Json.obj(Json.parse(text))
        if (obj == null) return
        // 只认 {"sakana":"discover"} 这一种报文。
        // 局域网上什么广播都有（别的软件的发现协议、SSDP 等），所以必须先看标识字段再回应，
        // 绝不能"收到 UDP 就回"，否则会把自己变成一个到处乱应答的噪音源。
        if (Json.str(obj, Proto.KEY_SAKANA) != Proto.VAL_DISCOVER) return

        // 优先用报文来源地址（这是电脑真实的地址）；报文里的 host 只是电脑自报的，
        // 万一它有多块网卡，自报的那个未必是能收到我们回包的这块。
        val from = packet.address?.hostAddress
            ?: Json.str(obj, Proto.KEY_HOST)
            ?: return
        onPeer(from)

        // 单播回给发包方：packet.address / packet.port 就是电脑的地址与它发信用的端口
        sendTo(sender, receiverJson(), from, packet.port)
    }

    /** 向所有广播地址重复发一次自己的信息。 */
    private fun announce(socket: DatagramSocket, face: NetFace?) {
        val bytes = receiverJson().toByteArray(StandardCharsets.UTF_8)
        for (target in Lan.broadcastTargets(face)) {
            try {
                socket.send(DatagramPacket(bytes, bytes.size, target, Proto.DISCOVER_PORT))
            } catch (e: Exception) {
                // 某个接口发不出去很正常（例如蜂窝网不允许广播），换下一个就行
                Log.d(TAG, "往 $target 广播失败: ${e.message}")
            }
        }
    }

    private fun sendTo(socket: DatagramSocket?, json: String, host: String, port: Int) {
        if (socket == null || host.isBlank()) return
        try {
            val bytes = json.toByteArray(StandardCharsets.UTF_8)
            socket.send(DatagramPacket(bytes, bytes.size, java.net.InetAddress.getByName(host), port))
            Log.i(TAG, "已向 $host:$port 发送宣告")
        } catch (e: Exception) {
            Log.w(TAG, "向 $host:$port 发送失败: ${e.message}")
        }
    }

    /** 发现报文的内容。字段名是协议的一部分，不能改。 */
    private fun receiverJson(): String {
        // host 必须是**真实且可达**的地址：电脑会直接拿它去连 HTTP 控制接口。
        // 所以这里取"当前选定网卡"的地址，而不是随便挑一个。
        val host = Lan.localIpv4(preferredFace())
        return Json.stringify(
            linkedMapOf(
                Proto.KEY_SAKANA to Proto.VAL_RECEIVER,
                Proto.KEY_VERSION to Proto.VERSION,
                Proto.KEY_HOST to host,
                Proto.KEY_NAME to deviceName(),
                // 真实端口：52889 被占用时会顺延（见 ControlServer.start）
                Proto.KEY_PORT to controlPort(),
                Proto.KEY_CAPS to Proto.CAPS,
            ),
        )
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            // 保留中断标记，让外层循环尽快退出
            Thread.currentThread().interrupt()
        }
    }
}
