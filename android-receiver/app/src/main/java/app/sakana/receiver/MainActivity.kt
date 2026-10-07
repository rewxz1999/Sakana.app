package app.sakana.receiver

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.media3.ui.PlayerView

/** 界面刷新周期：状态/进度/连接/同步提示都在这个节拍里更新，1 秒足够也不费电。 */
private const val UI_TICK_MS = 1000L

/**
 * 接收端主界面。
 *
 * 两个形态（见 activity_main.xml 的两层布局）：
 *  · **首页**：状态卡（设备名/IP/状态/同步）+ 收藏网格 + 观看历史 + 底部「立即同步/设置」；
 *  · **播放**：铺满窗口的播放器 + 横屏全屏 + 浮在画面上的控制栏（自动淡出）。
 *
 * 职责边界（每一块都单独成文件，这里只负责接线、刷新与生命周期）：
 *  · 播放器        PlayerController
 *  · 投屏协议      ControlApi / ControlServer
 *  · 双端同步      SyncManager / SyncStore / SyncClient / WatchRecorder
 *  · 两个形态与全屏 PlaybackUi
 *  · 顶部状态区    HeaderBinder
 *  · 收藏/历史列表 HomeBinder
 *  · 弹窗与文案    UiHelpers
 */
class MainActivity : Activity() {

    private lateinit var playerView: PlayerView
    private lateinit var header: HeaderBinder
    private lateinit var home: HomeBinder
    private lateinit var playback: PlaybackUi
    private lateinit var player: PlayerController

    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refreshUi()
            ui.postDelayed(this, UI_TICK_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Settings.init(this)
        SyncManager.init(this)
        CoverLoader.init(this)
        applyKeepScreenOn()

        setContentView(R.layout.activity_main)
        bindViews()

        player = PlayerController(this, playerView) { refreshUi() }
        // 把播放器交给运行期外壳：HTTP 控制接口从这里拿播放能力；界面销毁时置回 null
        Receiver.gateway = player
        Receiver.start(this)
        // 冷启动就尝试连电脑并同步（有上次的地址就直接用，没有就拿最近见过的地址探一探）
        SyncManager.autoConnect()

        refreshUi()
        ui.postDelayed(tick, UI_TICK_MS)
    }

    override fun onResume() {
        super.onResume()
        applyKeepScreenOn()
        Receiver.applyConfig(this)
        SyncManager.autoConnect()
        refreshUi()
    }

    override fun onDestroy() {
        // 顺序不能反：先让控制接口拿不到播放器，再拆服务，最后释放播放器
        ui.removeCallbacksAndMessages(null)
        playback.onDestroy()
        if (Receiver.gateway === player) Receiver.gateway = null
        Receiver.stop()
        player.release()
        super.onDestroy()
    }

    /**
     * 返回键：**全屏时先退出全屏**（回竖屏、显示系统栏），而不是直接退出应用；
     * 第二次按才走系统默认行为。这是用户点名要的顺序。
     */
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (playback.exitFullscreenIfNeeded()) return
        super.onBackPressed()
    }

    // ---------------- 视图与交互 ----------------

    private fun bindViews() {
        playerView = findViewById(R.id.player_view)
        header = HeaderBinder(this, findViewById(R.id.header))
        home = HomeBinder(
            activity = this,
            root = findViewById(R.id.home_view),
            onPlayFavorite = { playFavorite(it) },
            onFavoriteDetails = { showFavoriteDialog(this, it) },
            onHistoryClick = { playHistory(it) },
        )
        playback = PlaybackUi(
            activity = this,
            homeView = findViewById(R.id.home_view),
            layer = findViewById(R.id.player_layer),
            // 控制栏里的动作统统走同一条路：交给播放器，失败就把"人话提示"弹出来
            onControl = { action, value ->
                if (!player.control(action, value)) player.notice()?.let { toast(it) }
                refreshUi()
            },
            onPlaylist = { showPlaylist() },
            onSettings = { openSettings() },
        )
        playback.bind()

        findViewById<View>(R.id.btn_settings_home).setOnClickListener { openSettings() }
        findViewById<View>(R.id.btn_sync_now).setOnClickListener { syncNowManually() }
        // 地址只显示、不输入：点一下复制，用户拿去电脑端手填（输入入口在设置页）
        findViewById<View>(R.id.row_addr).setOnClickListener { copyAddress() }
    }

    private fun showPlaylist() {
        val snapshot = player.snapshot()
        if (snapshot.titles.isEmpty()) {
            toast(getString(R.string.toast_no_playlist))
            return
        }
        showPlaylistDialog(this, snapshot.titles, snapshot.index, player.playableFlags()) { which ->
            if (!player.control("select", which.toLong())) {
                toast(player.notice() ?: getString(R.string.toast_rule_mode, snapshot.titles.getOrNull(which) ?: ""))
            }
            refreshUi()
        }
    }

    /**
     * 点收藏 = 让**电脑**去播这一部。
     * 接收端不自己取流：电脑完成"选源 → 选集 → 嗅探直链 → 投屏到本机"，
     * 随后的 `/play` 会让界面自动切进播放层（见 refreshUi 里的 playerMode 判断）。
     */
    private fun playFavorite(favorite: Favorite) {
        if (SyncStore.syncUrl.isNullOrBlank()) {
            toast(getString(R.string.sync_need_connection))
            return
        }
        if (favorite.subjectId <= 0) {
            toast(getString(R.string.fav_detail_no_id))
            return
        }
        // playSubject 内部会先设好"电脑正在解析播放源…"，这里立刻刷一次让用户看到
        SyncManager.playSubject(favorite.subjectId, null) { _, message ->
            toast(message)
            refreshUi()
        }
        refreshUi()
    }

    /** 点历史：能认出条目 id 就从那一集接着播，否则如实说清为什么点不了。 */
    private fun playHistory(item: HistoryItem) {
        if (item.subjectId <= 0) {
            toast(getString(R.string.fav_detail_no_id))
            return
        }
        if (SyncStore.syncUrl.isNullOrBlank()) {
            toast(getString(R.string.sync_need_connection))
            return
        }
        // episode 是"第几集"（从 1 开始），play-subject 要的是从 0 开始的下标
        val index = if (item.episode > 0) item.episode - 1 else null
        SyncManager.playSubject(item.subjectId, index) { _, message ->
            toast(message)
            refreshUi()
        }
        refreshUi()
    }

    private fun syncNowManually() {
        if (SyncStore.syncUrl.isNullOrBlank()) {
            // 没连过电脑时"立即同步"没有意义，如实说清该怎么做
            toast(getString(R.string.sync_need_connection))
        } else {
            SyncManager.syncNow("用户手动同步")
            toast(getString(R.string.sync_status_syncing))
        }
        refreshUi()
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    private fun copyAddress() {
        // 复制界面上**显示的那个**地址（含真实端口与当前网卡），保证与用户看到的一致
        val address = header.address() ?: return
        if (copyToClipboard(this, "sakana-receiver", address)) {
            toast(getString(R.string.toast_copied, address))
        }
    }

    // ---------------- 刷新 ----------------

    private fun refreshUi() {
        val snapshot = player.snapshot()
        val error = player.lastError()
        val notice = player.notice()

        // 有媒体就是"播放态"（含缓冲/暂停/播完）；stop 之后 state 回到 idle 即回首页
        val active = snapshot.state != Proto.STATE_IDLE
        playback.setPlayerMode(active, snapshot.playing)

        if (active) {
            playback.refresh(
                snapshot = snapshot,
                error = error,
                notice = notice,
                connectedIp = if (Receiver.isConnected()) Receiver.lastClientIp else null,
                searchingIp = null,
            )
        } else {
            // 只刷新当前可见的那一层，省掉看不见的视图上的无谓工作
            header.refresh(snapshot, error, notice)
            home.refresh()
        }

        // 本地观看历史：WatchRecorder 内部会限流（最多 15 秒写一次）
        SyncManager.notePlayback(snapshot)
    }

    // ---------------- 小工具 ----------------

    private fun applyKeepScreenOn() {
        if (Settings.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
