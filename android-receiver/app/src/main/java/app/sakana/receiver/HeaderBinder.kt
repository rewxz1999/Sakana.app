package app.sakana.receiver

import android.app.Activity
import android.view.View
import android.widget.TextView

/**
 * 顶部状态区：设备名、大字状态、副状态、以及"本机 IP:端口（点一下复制）"。
 *
 * 单独成类的原因：这一块有 5 个 TextView、一段优先级规则（见 [statusLines]）、
 * 还要缓存网卡列表，全塞进 MainActivity 会让"界面接线"那部分被淹没。
 * MainActivity 只需要在每次刷新时调一次 [refresh]。
 *
 * **地址只显示、不输入**：填电脑地址的入口在设置页（"主动连接电脑"），
 * 这里显示的是"电脑该连本机的哪个地址"，点一下复制走。
 */
internal class HeaderBinder(private val activity: Activity, header: View) {

    private val tvName: TextView = header.findViewById(R.id.tv_name)
    private val tvState: TextView = header.findViewById(R.id.tv_state)
    private val tvDetail: TextView = header.findViewById(R.id.tv_detail)
    private val tvAddr: TextView = header.findViewById(R.id.tv_addr)
    private val tvAddrHint: TextView = header.findViewById(R.id.tv_addr_hint)
    private val tvSyncStatus: TextView = header.findViewById(R.id.tv_sync_status)

    /**
     * 网卡列表的缓存。
     * 界面每秒刷新一次，而 `NetworkInterface.getNetworkInterfaces()` 每次都要走 JNI 枚举，
     * 没必要这么勤 —— 网卡变化（插拔 USB）本来就是"几秒级"的事，5 秒看一次足够。
     */
    private var cachedFaces: List<NetFace> = emptyList()
    private var faceTick = 0

    /** 当前该用哪块网卡。 */
    fun face(): NetFace? = Lan.pick(faces(), Settings.preferredInterface)

    /** 当前显示（也是给电脑端手填用）的地址，例如 `192.168.42.129:52889`；服务没起来时返回 null。 */
    fun address(): String? {
        val port = Receiver.actualPort
        if (port <= 0) return null
        return "${face()?.ip ?: Lan.localIpv4(null)}:$port"
    }

    fun refresh(snapshot: PlayerController.Snapshot, error: String?, notice: String?) {
        tvName.text = Settings.deviceName
        refreshAddress()
        refreshSyncStatus()

        val connected = Receiver.isConnected()
        val searching = Receiver.isSearching()
        val lines = statusLines(
            activity = activity,
            state = snapshot.state,
            title = snapshot.title,
            error = error,
            notice = notice,
            connectedIp = if (connected) Receiver.lastClientIp else null,
            searchingIp = if (searching) Receiver.searchFromIp else null,
            // USB/有线 提示只在"既没连上也没在搜索"时出现，否则真正重要的信息会被挤掉
            wiredFaceLabel = if (!connected && !searching) Lan.wiredFaces(faces()).firstOrNull()?.label else null,
        )
        tvState.text = lines.state
        tvDetail.text = lines.detail
        tvDetail.setTextColor(
            activity.getColor(
                when {
                    error != null -> R.color.warn
                    connected -> R.color.accent
                    else -> R.color.text_secondary
                },
            ),
        )
    }

    /**
     * 同步状态行。
     *
     * ⚠️ 这一行曾经是布局里写死的 `android:text="未连接电脑 · …"`，**没有任何代码去改它**，
     * 所以不管实际同步到没到、缓存了没有，首页永远显示"未连接电脑"。
     * 真机验证时才发现的（设置页那行是动态的，光看代码不容易注意到首页这行是死的）。
     * 现在它和设置页共用 [syncStatusText]：连接状态、离线时的"缓存于 …"、
     * 失败原因都来自同一份判断，不会再对不上。
     */
    private fun refreshSyncStatus() {
        val status = syncStatusText(activity)
        tvSyncStatus.text = status.text
        tvSyncStatus.setTextColor(
            activity.getColor(if (status.error) R.color.warn else R.color.text_muted),
        )
    }

    /**
     * 地址行每秒刷新一次（Wi-Fi 重连后 IP 会变），并顺带标出"是哪块网卡" ——
     * 多网卡时用户必须知道现在到底是哪块在广播，否则排查不通时会一头雾水。
     */
    private fun refreshAddress() {
        val shown = address()
        if (shown == null) {
            tvAddr.text = activity.getString(R.string.addr_unavailable)
            tvAddrHint.text = ""
            return
        }
        tvAddr.text = shown
        tvAddrHint.text = listOfNotNull(
            face()?.name,
            activity.getString(R.string.addr_tap_to_copy),
        ).joinToString(" · ")
    }

    private fun faces(): List<NetFace> {
        if (faceTick <= 0) {
            cachedFaces = Lan.faces()
            faceTick = 5
        }
        faceTick--
        return cachedFaces
    }
}
