package app.sakana.receiver

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * 投屏设置页。
 *
 * 这里集中了所有"需要用户拍板"的东西：设备名、控制端口、首选网卡（解决多网段）、
 * 主动连接的电脑地址（解决 USB 共享网络/跨网段广播不通）、三个开关，以及"关于"。
 *
 * 改动如何生效：
 *  · 设备名 / 自动播放 / 屏幕常亮：运行期是**实时读取** Settings 的，保存即生效；
 *  · 控制端口 / 首选网卡：需要重启控制服务与发现服务，调 [Receiver.applyConfig]；
 *  · 主动连接的电脑地址：发现服务每 5 秒读一次，保存后立刻多发一次宣告（[Receiver.announceTo]）。
 */
class SettingsActivity : Activity() {

    private lateinit var etName: EditText
    private lateinit var etPort: EditText
    private lateinit var etPeer: EditText
    private lateinit var tvFace: TextView
    private lateinit var layoutRecent: LinearLayout
    private lateinit var swKeepOn: Switch
    private lateinit var swAutoplay: Switch
    private lateinit var swBoot: Switch
    private lateinit var tvAboutVersion: TextView
    private lateinit var tvAboutPort: TextView
    private lateinit var tvAboutFace: TextView
    private lateinit var tvAboutBroadcast: TextView
    private lateinit var tvAboutRequests: TextView
    private lateinit var tvAboutStatus: TextView
    private lateinit var tvSyncState: TextView
    private lateinit var tvSyncUrl: TextView
    private lateinit var tvSyncCounts: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Settings.init(this)
        setContentView(R.layout.activity_settings)
        bindViews()
        loadValues()
        bindActions()
        refreshAbout()
        refreshSync()
    }

    override fun onResume() {
        super.onResume()
        // 端口/网卡可能在别处被改（或者服务重启后顺延了端口），每次回来都重新读一遍；
        // 同步状态也会变（后台可能刚好同步完了）
        loadValues()
        refreshAbout()
        refreshSync()
    }

    private fun bindViews() {
        etName = findViewById(R.id.et_name)
        etPort = findViewById(R.id.et_port)
        etPeer = findViewById(R.id.et_peer)
        tvFace = findViewById(R.id.tv_face)
        layoutRecent = findViewById(R.id.layout_recent)
        swKeepOn = findViewById(R.id.sw_keep_on)
        swAutoplay = findViewById(R.id.sw_autoplay)
        swBoot = findViewById(R.id.sw_boot)
        tvAboutVersion = findViewById(R.id.tv_about_version)
        tvAboutPort = findViewById(R.id.tv_about_port)
        tvAboutFace = findViewById(R.id.tv_about_face)
        tvAboutBroadcast = findViewById(R.id.tv_about_broadcast)
        tvAboutRequests = findViewById(R.id.tv_about_requests)
        tvAboutStatus = findViewById(R.id.tv_about_status)
        tvSyncState = findViewById(R.id.tv_sync_state)
        tvSyncUrl = findViewById(R.id.tv_sync_url)
        tvSyncCounts = findViewById(R.id.tv_sync_counts)
    }

    private fun loadValues() {
        etName.setText(Settings.deviceName)
        etPort.setText(Settings.controlPort.toString())
        etPeer.setText(Settings.manualPeer ?: "")
        swKeepOn.isChecked = Settings.keepScreenOn
        swAutoplay.isChecked = Settings.autoPlay
        swBoot.isChecked = Settings.autoOpenOnBoot
        tvFace.text = faceLabel()
        bindRecentHosts(layoutRecent, Settings.recentPeers) { etPeer.setText(it) }
    }

    private fun bindActions() {
        findViewById<ImageButton>(R.id.btn_back).setOnClickListener { finish() }
        findViewById<Button>(R.id.btn_name_save).setOnClickListener { saveName() }
        findViewById<Button>(R.id.btn_port_save).setOnClickListener { savePort() }
        findViewById<Button>(R.id.btn_peer).setOnClickListener { connectPeer() }
        findViewById<LinearLayout>(R.id.row_face).setOnClickListener { pickFace() }
        findViewById<Button>(R.id.btn_sync_now_settings).setOnClickListener {
            if (SyncStore.syncUrl.isNullOrBlank()) {
                // 没连过电脑时"立即同步"没有意义，如实说明该怎么做，而不是假装同步了一下
                toast(getString(R.string.sync_need_connection))
            } else {
                SyncManager.syncNow("设置页手动同步")
                toast(getString(R.string.sync_status_syncing))
            }
            refreshSync()
        }

        swKeepOn.setOnCheckedChangeListener { _, checked ->
            Settings.keepScreenOn = checked
            toast(getString(R.string.toast_saved))
        }
        swAutoplay.setOnCheckedChangeListener { _, checked ->
            Settings.autoPlay = checked
            toast(getString(R.string.toast_saved))
        }
        swBoot.setOnCheckedChangeListener { _, checked ->
            Settings.autoOpenOnBoot = checked
            toast(getString(R.string.toast_saved))
        }
    }

    // ---------------- 各项保存 ----------------

    private fun saveName() {
        val name = etName.text.toString().trim()
        Settings.deviceName = name
        // 名字是靠 UDP 广播出去的，下个周期（最多 5 秒）电脑端就能看到，不用重启任何服务
        loadValues()
        toast(getString(R.string.toast_name_saved, Settings.deviceName))
    }

    private fun savePort() {
        val port = etPort.text.toString().trim().toIntOrNull()
        if (port == null || port !in 1024..65535) {
            toast(getString(R.string.toast_port_invalid))
            return
        }
        Settings.controlPort = port
        // 端口变了必须重启控制服务；顺延后的真实端口会在"关于"里显示
        Receiver.applyConfig(this)
        refreshAbout()
        toast(getString(R.string.toast_port_saved, port))
    }

    /**
     * "主动连接电脑"：把地址存下来，并立刻单播一次宣告。
     *
     * 这是 USB 网络共享 / 跨网段 / AP 隔离 Wi-Fi 下**唯一还能工作**的发现路径：
     * 广播出不了本网段，但"我知道你在哪，直接发给你"总是可行的。
     * 端口固定发到 52888（电脑在那里监听宣告），所以这里输入的端口只作格式兼容。
     */
    private fun connectPeer() {
        val host = parseHost(etPeer.text.toString())
        if (host == null) {
            toast(getString(R.string.set_peer_bad))
            return
        }
        Settings.manualPeer = host
        Receiver.announceTo(host)
        // 光"宣告自己"还不够：顺手按候选端口探一下这台电脑的**同步服务**，
        // 探到就立刻把收藏/历史拉过来 —— 这就是需求里"主动连接电脑成功后自动同步"。
        SyncManager.onPcSeen(host)
        loadValues()
        refreshSync()
        toast(getString(R.string.set_peer_sent, host))
    }

    private fun pickFace() {
        showFacePickerDialog(this, Lan.faces(), Settings.preferredInterface) { name ->
            Settings.preferredInterface = name
            // 换网卡意味着"报给电脑的地址"和"广播走哪块网卡"都变了，必须重启服务
            Receiver.applyConfig(this)
            loadValues()
            refreshAbout()
        }
    }

    // ---------------- 关于 ----------------

    /**
     * 同步状态区：状态一句话、同步地址、两边各有多少条。
     *
     * 地址显示出来是有用的：连不上时可以照着核对该连哪台电脑（多网卡/多网段时尤其需要）。
     */
    private fun refreshSync() {
        val status = syncStatusText(this)
        tvSyncState.text = status.text
        tvSyncState.setTextColor(getColor(if (status.error) R.color.warn else R.color.text_secondary))
        tvSyncUrl.text = "${getString(R.string.set_sync_url)}：" +
            (SyncStore.syncUrl ?: getString(R.string.sync_status_offline))
        tvSyncCounts.text = getString(
            R.string.set_sync_counts,
            SyncStore.favorites.size,
            SyncStore.history.size,
        )
    }

    private fun refreshAbout() {
        tvAboutVersion.text = "${getString(R.string.about_version)}：${versionName()}\n" +
            getString(R.string.about_protocol_line, Proto.VERSION)
        val port = Receiver.actualPort
        tvAboutPort.text = if (port > 0) {
            val extra = if (Receiver.portShifted) {
                getString(R.string.about_port_shifted, Settings.controlPort, port)
            } else {
                Settings.controlPort.toString()
            }
            "${getString(R.string.about_port)}：$port（$extra）"
        } else {
            "${getString(R.string.about_port)}：${getString(R.string.about_stopped)}"
        }

        val face = Lan.effectiveFace(Settings.preferredInterface)
        tvAboutFace.text = "${getString(R.string.about_face)}：" +
            (face?.label ?: getString(R.string.set_face_none))

        tvAboutBroadcast.text = "${getString(R.string.about_broadcast)}：" +
            (face?.broadcast ?: "255.255.255.255")

        tvAboutRequests.text = "${getString(R.string.about_requests)}：${Receiver.requestCount}"

        val state = if (Receiver.running) getString(R.string.about_running) else getString(R.string.about_stopped)
        tvAboutStatus.text = "${getString(R.string.about_status)}：$state" +
            (Receiver.lastError?.let { "\n$it" } ?: "")
    }

    private fun faceLabel(): String {        val current = Settings.preferredInterface
        if (current.isNullOrBlank()) return getString(R.string.set_face_auto)
        val face = Lan.faceByName(current)
        // 选过的那块网卡已经不在了（拔了 USB）：如实说明，不要假装还选着它
        return face?.label ?: "$current（已不可用，将自动选择）"
    }

    @Suppress("DEPRECATION")
    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (t: Throwable) {
        "?"
    }

    /**
     * 从用户输入里取出电脑的 IP。
     * 接受 `192.168.1.20` 与 `192.168.1.20:52890` 两种写法（后者端口只作格式兼容，
     * 真正的宣告固定发到 52888）。格式不对返回 null。
     */
    private fun parseHost(raw: String): String? {
        val host = raw.trim().substringBefore(':').trim()
        val parts = host.split('.')
        if (parts.size != 4) return null
        for (p in parts) {
            val n = p.toIntOrNull() ?: return null
            if (n !in 0..255) return null
        }
        return host
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
