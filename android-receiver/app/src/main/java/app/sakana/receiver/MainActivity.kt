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
 *  · **首页**：固定状态卡 + 单个 RecyclerView（收藏两列网格 + 观看历史卡片）+ 固定底栏；
 *  · **播放**：官方 PlayerView 铺满窗口 + 横屏全屏 + 浮在画面上的控制栏与手势。
 *
 * 职责边界（每一块都单独成文件，这里只负责接线、刷新与生命周期）：
 *  · 播放器        PlayerController
 *  · 投屏协议      ControlApi / ControlServer
 *  · 双端同步      SyncManager / SyncStore / SyncClient / WatchRecorder
 *  · 播放层（控制栏/手势/全屏）PlaybackUi + PlayerGestures + player_control_view.xml
 *  · 首页列表      HomeRows（纯逻辑）+ HomeAdapter + HomeBinder
 *  · 顶部状态区    HeaderBinder
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
        // 设置页里可能改过"铺满画面"，回来时同步一下播放器的 resize_mode
        playback.applyResizeMode()
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
     * 返回键：**先退全屏，再退出播放，最后才退出应用** —— 用户点名要的顺序，
     * 免得看得好好的按一下返回就把应用关了。
     */
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (playback.exitFullscreenIfNeeded()) return
        if (playback.isInPlayerMode()) {
            // 退全屏后还在播放：这一步是"退出播放"（回首页，播放器停止但不退出应用）
            player.control("stop", 0L)
            refreshUi()
            return
        }
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
            onHistoryDetails = { showHistoryDialog(this, it) { refreshUi() } },
        )
        playback = PlaybackUi(
            activity = this,
            playerView = playerView,
            controller = player,
            homeView = findViewById(R.id.home_view),
            gestureLayer = findViewById(R.id.gesture_layer),
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
        playback.keepControlsAlive()
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
            toast(getString(R.string.hist_detail_no_id))
            return
        }
        if (SyncStore.syncUrl.isNullOrBlank()) {
            toast(getString(R.string.hist_need_sync))
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
            playback.refresh(snapshot, error, notice)
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
