package app.sakana.receiver

import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface

/**
 * 网卡类型。设置页里会标注出来，也用来决定要不要提示
 * "USB 共享网络下广播常常不通，请用主动连接或让电脑手填地址"。
 */
enum class FaceKind(val label: String) {
    WIFI("Wi-Fi"),
    USB("USB 共享网络"),
    ETHERNET("以太网"),
    BLUETOOTH("蓝牙共享"),
    CELLULAR("移动网络"),
    OTHER("其它"),
}

/** 一块网卡上的一个 IPv4 地址。 */
data class NetFace(
    val name: String,
    val ip: String,
    /** 定向广播地址（192.168.42.255 这种）。算不出来时为 null。 */
    val broadcast: String?,
    val kind: FaceKind,
) {
    /** 设置页里显示的一行文字，例如 `rndis0 · 192.168.42.129（USB 共享网络）`。 */
    val label: String get() = "$name · $ip（${kind.label}）"
}

/**
 * 局域网地址相关的小工具：列出可用网卡、挑一块、算出该往哪广播。
 *
 * 为什么要"列出来让用户选"而不是自动挑一块：
 * 设备上常常同时有多块网卡 —— Wi-Fi（192.168.1.x）、USB 网络共享（192.168.42.x，
 * 网卡名通常是 rndis0/usb0）、蓝牙共享（bt-pan）、甚至 USB 以太网（eth0）。
 * 这些网段里**只有一块是电脑能到达的**，而这件事代码判断不出来（取决于用户在电脑上插了哪根线）。
 * 选错了的表现是"界面显示 192.168.1.23，电脑却怎么都连不上" ——
 * 所以把选择权交给用户，同时把每块网卡的类型标出来。
 */
object Lan {

    /** 列出所有"可用"的 IPv4（排除回环、链路本地 169.254、以及未启用的网卡）。 */
    fun faces(): List<NetFace> {
        val out = ArrayList<NetFace>()
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (ia in nif.interfaceAddresses) {
                    val addr = ia.address as? Inet4Address ?: continue
                    if (addr.isLoopbackAddress || addr.isLinkLocalAddress) continue
                    val ip = addr.hostAddress ?: continue
                    // 优先用系统给的广播地址；某些驱动不给，就按掩码自己算
                    val bcast = ia.broadcast?.hostAddress
                        ?: deriveBroadcast(ip, ia.networkPrefixLength.toInt())
                    out.add(NetFace(nif.name, ip, bcast, kindOf(nif.name, ip)))
                }
            }
        } catch (t: Throwable) {
            // 拿不到网卡列表不是致命问题：调用方会退化成"没得选"，界面照常能跑
        }
        // 排序只为让设置页列表稳定好读：Wi-Fi、USB、以太网、蓝牙、移动网络、其它
        return out.sortedWith(compareBy({ it.kind.ordinal }, { it.name }))
    }

    /**
     * 按名字取网卡；`name` 为 null 或该网卡已经不存在（拔了线、换了网）时返回 null。
     */
    fun faceByName(name: String?): NetFace? {
        if (name.isNullOrBlank()) return null
        return faces().firstOrNull { it.name == name }
    }

    /**
     * 当前实际该用哪块网卡：用户选的那块还在就用它，否则自动挑一块
     * （返回 null 代表一块可用的都没有，界面会提示）。
     */
    fun effectiveFace(preferred: String?): NetFace? = pick(faces(), preferred)

    /**
     * 从**已经拿到的**网卡列表里挑（界面每秒刷新，缓存住列表用这个，省掉重复的 JNI 枚举）。
     */
    fun pick(all: List<NetFace>, preferred: String?): NetFace? =
        all.firstOrNull { it.name == preferred } ?: autoPick(all)

    /**
     * 自动挑一块：优先 Wi-Fi / 以太网，避开移动网络、蓝牙与虚拟网卡，再偏好私有网段。
     * （跟电脑端 castRelay.ts 挑本机地址的思路一致：挑错了会变成"看起来一切正常的失败"。）
     */
    fun autoPick(all: List<NetFace>): NetFace? = all.maxByOrNull { score(it) }

    private fun score(f: NetFace): Int {
        var s = when (f.kind) {
            FaceKind.WIFI -> 30
            FaceKind.ETHERNET -> 20
            // USB 共享要用户在设置里显式选；自动挑时权重低于 Wi-Fi，
            // 否则"插着 USB 又想用 Wi-Fi"的用户会被莫名其妙改到 USB 网段上
            FaceKind.USB -> 10
            FaceKind.OTHER -> 0
            FaceKind.BLUETOOTH -> -10
            FaceKind.CELLULAR -> -20
        }
        if (f.ip.startsWith("192.168.")) s += 3
        else if (f.ip.startsWith("10.")) s += 2
        else if (is172Private(f.ip)) s += 1
        // 明显是虚拟/隧道网卡的减分：Android 上常见 dummy0/sit0/ip6tln0，
        // 开发机上还会出现 WSL/Hyper-V 的虚拟网卡。挑中它们的结果是"地址看着正常但没人能连上"。
        val n = f.name.lowercase()
        if (VIRTUAL_HINTS.any { n.contains(it) }) s -= 15
        return s
    }

    /** 名字里带这些字样的网卡几乎不可能是"电脑能到达"的那一块。 */
    private val VIRTUAL_HINTS = listOf(
        "p2p", "dummy", "sit", "ip6tnl", "tun", "tap", "ppp", "virt", "vmware", "vbox", "wsl",
    )

    private fun is172Private(ip: String): Boolean {
        val p = ip.split('.')
        if (p.size != 4 || p[0] != "172") return false
        val b = p[1].toIntOrNull() ?: return false
        return b in 16..31
    }

    /** 本机在指定网卡上的地址；一块可用网卡都没有时退回 127.0.0.1（界面会据此提示）。 */
    fun localIpv4(preferred: String?): String = effectiveFace(preferred)?.ip ?: "127.0.0.1"

    /**
     * 该往哪些地址发广播。
     *
     * 指定了网卡就只往那块网卡的定向广播地址发（外加有限广播 255.255.255.255）；
     * 没指定就把所有网卡的定向广播都发一遍 —— 多花几个字节，换来"在哪都能被发现"。
     */
    fun broadcastTargets(face: NetFace?): List<InetAddress> {
        val out = LinkedHashSet<InetAddress>()
        try {
            out.add(InetAddress.getByName("255.255.255.255"))
        } catch (_: Throwable) {
            // 解析失败就只发定向广播
        }
        for (f in (if (face != null) listOf(face) else faces())) {
            val b = f.broadcast ?: continue
            try {
                out.add(InetAddress.getByName(b))
            } catch (_: Throwable) {
                // 忽略单个失败，继续下一块
            }
        }
        return out.toList()
    }

    /** 有线/USB 类网卡（用来在界面上给一句"广播可能不通"的提示）。 */
    fun wiredFaces(all: List<NetFace>): List<NetFace> =
        all.filter { it.kind == FaceKind.USB || it.kind == FaceKind.ETHERNET }

    /**
     * 判断网卡类型。
     *
     * 名字是唯一可靠的依据（Android 没有 API 能直接问"这是不是 USB 共享"）：
     *  · `rndis0` / `usb0`       —— USB 网络共享（RNDIS），地址通常是 192.168.42.x
     *  · `eth0` / `eth1`         —— 有线以太网，也可能是有线网卡（界面里两者都提示）
     *  · `wlan0` / `wireless_*`  —— Wi-Fi
     *  · `bt-pan` / `bnep*`      —— 蓝牙共享
     *  · `rmnet*` / `ccmni*`     —— 移动网络
     *
     * 注意 `wireless` 这个写法：Android 上是 `wlan0`，但 Java 在别的系统（比如开发机上跑自测）
     * 会给出 `wireless_32768` 这类名字，只认 wlan/wifi 会把它误判成"其它"，
     * 从而在自动挑选时输给虚拟网卡 —— 这是自测当场抓到的。
     */
    private fun kindOf(name: String, ip: String): FaceKind {
        val n = name.lowercase()
        return when {
            n.contains("rndis") || n.startsWith("usb") -> FaceKind.USB
            n.startsWith("bt") || n.contains("bnep") || n.contains("bluetooth") -> FaceKind.BLUETOOTH
            n.contains("wlan") || n.contains("wifi") || n.contains("wireless") -> FaceKind.WIFI
            n.startsWith("eth") || n.startsWith("en") -> FaceKind.ETHERNET
            n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("pdp") -> FaceKind.CELLULAR
            // 192.168.42.x 是 Android USB 共享的默认网段，网卡名看不懂时也能兜住
            ip.startsWith("192.168.42.") -> FaceKind.USB
            else -> FaceKind.OTHER
        }
    }

    /** 按掩码算定向广播地址（系统没给 broadcast 时用）。 */
    private fun deriveBroadcast(ip: String, prefix: Int): String? {
        if (prefix !in 1..31) return null
        val parts = ip.split('.')
        if (parts.size != 4) return null
        var value = 0L
        for (p in parts) {
            val b = p.toIntOrNull() ?: return null
            if (b !in 0..255) return null
            value = (value shl 8) or b.toLong()
        }
        val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
        val bcast = (value and mask) or (mask.inv() and 0xFFFFFFFFL)
        return "${(bcast shr 24) and 0xFF}.${(bcast shr 16) and 0xFF}.${(bcast shr 8) and 0xFF}.${bcast and 0xFF}"
    }
}
