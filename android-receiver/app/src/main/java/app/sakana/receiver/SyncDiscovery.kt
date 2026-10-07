package app.sakana.receiver

import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executor

/**
 * "怎么找到电脑的同步服务"这一件事：地址规范化、候选端口探测、限流、自动重连。
 *
 * 单独成文件的原因：这是**发现**问题（和投屏那条 UDP 发现是一类），
 * 而 SyncManager 管的是"找到之后同步什么"；混在一起会让两边都难读。
 *
 * 三条路径，任何一条走通就会把 [onFound] 交给 SyncManager：
 *   ① 收到 `/play` 里的 `syncUrl` —— 最权威，见 SyncManager.onPlayReceived；
 *   ② 冷启动/回到前台：拿上次记下的地址直接试；
 *   ③ 看到了电脑（它发搜索广播，或用户手填了地址）：按候选端口 [PROBE_PORTS] 探一下。
 * ③ 是"还没投过屏时"唯一的自动路径，所以要猜端口：电脑端的同步服务用 52890。
 */
internal class SyncDiscovery(
    private val executor: Executor,
    /** 探测成功（或已有可用地址）时回调，参数是规范化后的同步地址。 */
    private val onFound: (String, String) -> Unit,
) {

    /** 电脑端同步服务的候选端口（与投屏中转同一段）。 */
    private val probePorts = intArrayOf(52890)

    /** 地址 -> 上次探测时间（单调时钟）。 */
    private val probedAt = HashMap<String, Long>()
    private var lastAutoConnectAt = 0L

    /** 手动触发一次探测（设置页"主动连接电脑"、或 UI 的"立即同步"）。 */
    fun probe(host: String) {
        val clean = host.trim().substringBefore(':')
        if (clean.isBlank()) return
        val now = SystemClock.elapsedRealtime()
        synchronized(probedAt) {
            val last = probedAt[clean] ?: 0L
            if (now - last < PROBE_COOLDOWN_MS) return
            probedAt[clean] = now
        }
        executor.execute { probeNow(clean) }
    }

    /**
     * 冷启动/回到前台时调：有已知地址就直接同步，没有就拿最近见过的地址探一探。
     */
    fun autoConnect() {
        val now = SystemClock.elapsedRealtime()
        synchronized(probedAt) {
            if (now - lastAutoConnectAt < PROBE_COOLDOWN_MS) return
            lastAutoConnectAt = now
        }
        executor.execute {
            val known = SyncStore.syncUrl
            if (known != null && SyncClient.probe(known).ok) {
                onFound(known, "自动同步")
                return@execute
            }
            if (known != null) Log.i(TAG, "上次的同步地址 $known 不通，尝试重新探测")
            // 下面这些地址都来自"真的见过这台电脑"：它广播过、或用户手填过
            probeNow(Receiver.searchFromIp.orEmpty())
            val peer = Settings.manualPeer
            if (!peer.isNullOrBlank()) probeNow(peer)
            Settings.recentPeers.forEach { probeNow(it.substringBefore(':')) }
        }
    }

    /** 真正去敲端口（已经在后台线程上）。 */
    private fun probeNow(host: String) {
        val clean = host.trim().substringBefore(':')
        if (clean.isBlank()) return
        for (port in probePorts) {
            val base = "http://$clean:$port"
            if (SyncClient.probe(base).ok) {
                Log.i(TAG, "探测到电脑同步服务: $base")
                onFound(base, "探测到电脑")
                return
            }
        }
    }

    private companion object {
        const val TAG = "SakanaSync"

        /** 同一个地址两次探测之间的最小间隔，避免每收到一个广播包就去敲一遍电脑。 */
        const val PROBE_COOLDOWN_MS = 20_000L
    }
}
