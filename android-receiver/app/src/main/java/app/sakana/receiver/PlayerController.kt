package app.sakana.receiver

import android.util.Log
import com.shuyu.gsyvideoplayer.listener.GSYStateUiListener
import com.shuyu.gsyvideoplayer.video.base.GSYVideoView

private const val TAG = "SakanaPlayer"

/**
 * 播放控制：GSY（内核是 Media3 的 exo2）的封装 + 播放列表 / 音量 / 状态。
 *
 * 职责边界：只关心"什么时候播、播哪一集、音量多少、现在什么状态"。
 * 请求头在 `PlayHeaders.kt`，播放视图与事件在 `SakanaGsyPlayer.kt`，选项翻译在 `PlayerSetup.kt`，
 * 列表下标在 `PlaylistNav.kt`，数据模型在 `PlayerModels.kt`，状态映射在 `PlaybackState.kt`。
 *
 * **与换 GSY 之前最大的区别**：以前这里自己建内核、自己 `setMediaSource`；现在内核归 GSY 管
 * （**进程内单例**），我们只负责"给它 url + 请求头 + 起播位置"和"读它现在的状态"。
 * 代价是**换集前必须先 release 旧的**，否则两次 setUp 会抢内核。
 * 线程约定：GSY 的视图只能在主线程访问，所以所有方法都必须从主线程调用。
 */
class PlayerController(
    private val gsy: SakanaGsyPlayer,
    private val onChanged: () -> Unit,
) : PlayerGateway {

    private val items = ArrayList<PlayerItem>()
    private var index = -1
    private var volumePercent = 100
    private var muted = false
    private var currentTitle: String? = null
    private var errorText: String? = null
    private var noticeText: String? = null

    /** "当前有一集在播/准备播"。`stop` 之后是 false —— `/info` 靠它如实报 idle。 */
    private var active = false

    /** 内核还没建好时设音量会被丢掉：记一个"欠一次"的标志，等下次回调补上。 */
    private var volumeDirty = true

    /** `/play` 是否要求立刻播放（设置里的"自动播放"）。关掉时只加载不播。 */
    private var startPlaying = true

    /** 当前倍速。换集时要重新写进 GSY 的 options，否则切一集就回到 1 倍速。 */
    var playbackSpeed: Float = 1f
        private set

    /**
     * `/play` 带来的请求头（Referer / Cookie / UserAgent 等）。
     * 整张播放列表共用一份：切集时继续用同一份头，否则下一集会被 CDN 拒掉。
     * 怎么变成 GSY 要的 map（含 User-Agent 与跨协议跳转那两个坑）见 `PlayHeaders.kt`。
     */
    private var headers: Map<String, String> = emptyMap()

    /** GSY 的状态变化回调；显式持有，避免每次 build 都新建一个匿名对象。 */
    private val stateListener = object : GSYStateUiListener {
        override fun onStateChanged(state: Int) = notifyChanged()
    }

    init {
        gsy.onChanged = { notifyChanged() }
        gsy.onError = { message ->
            errorText = message
            onChanged()
        }
    }

    /** 状态一变就顺手把"欠着的音量"补上（见 [volumeDirty]），再通知界面。 */
    private fun notifyChanged() {
        if (volumeDirty) applyVolume()
        onChanged()
    }

    // ---------------- /play ----------------

    override fun play(
        url: String,
        title: String,
        headers: Map<String, String>,
        startMs: Long,
        index: Int,
        playlist: List<PlayerItem>,
        autoPlay: Boolean,
    ) {
        this.headers = headers
        this.startPlaying = autoPlay
        items.clear()
        items.addAll(playlist)
        // 下标怎么对齐（index 无效要反查、规则模式要补地址、认不出来就新增一项）在 PlaylistNav 里
        startItem(PlaylistNav.resolvePlayIndex(items, url, title, index), startMs)
    }

    /**
     * 起播第 idx 集。返回 false 表示这一集没有可播放的地址（规则模式），已给出人话提示。
     */
    private fun startItem(idx: Int, startMs: Long): Boolean {
        if (idx !in items.indices) return false
        val item = items[idx]
        index = idx
        currentTitle = item.title.ifEmpty { null }

        if (item.url.isBlank()) {
            noticeText = "「${item.title.ifEmpty { "这一集" }}」在规则模式下没有播放地址，请在电脑上切集"
            errorText = null
            onChanged()
            return false
        }

        noticeText = null
        errorText = null
        volumeDirty = true
        try {
            /*
             * 换集前先 release 旧内核。GSY 的 MediaPlayer 是**进程内单例**，
             * 不释放就重新 setUp 会出现"上一集的音频还在响 / 新地址起不来"这类怪现象。
             */
            gsy.release()
            buildGsyOptions(
                player = gsy,
                url = item.url,
                title = item.title,
                headData = PlayHeaders.build(headers),
                startMs = startMs,
                autoPlay = startPlaying,
                speed = playbackSpeed,
                stateListener = stateListener,
            ).build(gsy)
            active = true
            gsy.startPlayLogic()
        } catch (t: Throwable) {
            active = false
            errorText = t.message ?: t.toString()
            Log.w(TAG, "起播失败: ${item.url}", t)
        }
        onChanged()
        return true
    }

    // ---------------- /control ----------------

    /**
     * 出错后重新加载当前这一集（控制栏上的「重试」）。从这一集开头重来：
     * 出错多半是流地址/网络问题，从断点重试往往再错一次。
     */
    fun retry(): Boolean {
        if (index !in items.indices) return false
        errorText = null
        noticeText = null
        return startItem(index, 0L)
    }

    /** 倍速（控制栏的倍速菜单与长按 2 倍速手势都走这里）。GSY 的视图只能在主线程访问。 */
    fun setPlaybackSpeed(speed: Float) {
        playbackSpeed = speed.coerceIn(0.25f, 4f)
        runCatching { gsy.setSpeed(playbackSpeed, false) }
    }

    /**
     * 执行一个控制动作。
     * @return false 表示动作名不认识、参数不合法、或目标集没有播放地址；调用方据此回 400
     *         （并可用 [notice] 拿到人话解释）。
     */
    override fun control(action: String, value: Long): Boolean {
        when (action.lowercase()) {
            "pause" -> pause()
            "resume" -> resume()
            "toggle" -> if (isPlayingNow()) pause() else resume()
            "stop" -> {
                // stop 之后**保留**列表和下标：电脑端还能接着发 next / select 把它拉回来，
                // 界面上的"选集"列表也不会突然变空（用户会以为投屏断了）。
                active = false
                errorText = null
                noticeText = null
                runCatching { gsy.release() }
                onChanged()
                return true
            }
            "next" -> if (!step(1)) return false
            "prev" -> if (!step(-1)) return false
            "seek" -> {
                val duration = gsy.safeDuration()
                val target = value.coerceAtLeast(0L)
                gsy.seekTo(if (duration > 0) target.coerceAtMost(duration) else target)
            }
            "volume" -> {
                volumePercent = value.toInt().coerceIn(0, 100)
                // 调音量视为"取消静音"：否则用户按了音量键听不到变化，会以为遥控坏了
                muted = false
                volumeDirty = true
                applyVolume()
            }
            "mute" -> {
                muted = value != 0L
                volumeDirty = true
                applyVolume()
            }
            "select" -> {
                val i = value.toInt()
                if (i !in items.indices) return false
                if (!startItem(i, 0L)) return false
            }
            else -> return false
        }
        onChanged()
        return true
    }

    /**
     * 暂停 / 继续（GSY 原生中央播放键与 /control 都走这里）。
     * 为什么按状态分开处理：GSY 没有"播放器对象"，只有视图状态 + 单例内核。
     * `startAfterPrepared()` 是它的"从暂停处继续"，而 AUTO_COMPLETE（播完）必须**重新起播**，
     * 否则会停在那里不动 —— 在用户看来就是"按了播放没反应"。
     */
    private fun pause() {
        if (active && isPlayingNow()) runCatching { gsy.onVideoPause() }
    }

    private fun resume() {
        if (!active) {
            // stop 之后的 resume：把当前这一集从头拉回来（列表和下标都还在）
            if (index in items.indices) startItem(index, 0L)
            return
        }
        when (gsy.currentState) {
            GSYVideoView.CURRENT_STATE_PLAYING,
            GSYVideoView.CURRENT_STATE_PREPAREING,
            GSYVideoView.CURRENT_STATE_PLAYING_BUFFERING_START,
            -> Unit // 已经在播/在准备，什么都不用做
            GSYVideoView.CURRENT_STATE_AUTO_COMPLETE -> startItem(index, 0L) // 播完了 -> 重播
            else -> runCatching { gsy.startAfterPrepared() }
        }
    }

    private fun isPlayingNow(): Boolean = gsy.currentState == GSYVideoView.CURRENT_STATE_PLAYING

    /** 朝 delta 方向找**下一个有地址的**集；都没有就给一句提示并返回 false。 */
    private fun step(delta: Int): Boolean {
        val target = PlaylistNav.nextPlayable(items, index, delta)
        if (target >= 0) return startItem(target, 0L)
        if (items.isEmpty()) {
            noticeText = "还没有播放列表"
            onChanged()
            return false
        }
        // 到头就停住，**不循环**（原因见 PlaylistNav.nextPlayable 的注释）
        noticeText = if (delta > 0) "没有下一集可以播了" else "没有上一集可以播了"
        onChanged()
        return false
    }

    /** 指定方向上还有没有能切的集（界面据此禁用上一集/下一集按钮）。 */
    fun canStep(delta: Int): Boolean = PlaylistNav.canStep(items, index, delta)

    /** 每一集有没有可播放的地址（规则模式下 playlist 全是空串，这里就全是 false）。 */
    fun playableFlags(): List<Boolean> = PlaylistNav.playableFlags(items)

    private fun applyVolume() {
        // GSY 没有独立的静音开关（跟 ExoPlayer 一样），只能把音量设成 0，
        // 并自己记住"静音前的档位"，这样取消静音能回到原音量而不是回到 100%。
        // 内核还没建好时这一下会被丢掉（见 SakanaGsyPlayer.setVolumeRatio）→ 保持 dirty 下次再试。
        val v = if (muted) 0f else volumePercent / 100f
        if (gsy.setVolumeRatio(v)) volumeDirty = false
    }

    // ---------------- /info ----------------

    override fun snapshot(): PlayerSnapshot = PlayerSnapshot(
        playing = active && isPlayingNow(),
        positionMs = gsy.currentPositionWhenPlaying.coerceAtLeast(0L),
        durationMs = gsy.safeDuration(),
        volume = volumePercent,
        muted = muted,
        index = index,
        titles = items.map { it.title },
        state = stateName(),
        title = currentTitle,
        canStepPrev = canStep(-1),
        canStepNext = canStep(1),
    )

    /** 最近一次播放错误；没有错误时是 null（界面拿它显示"播放失败：…"）。 */
    override fun lastError(): String? = errorText

    /** 最近一次"人话提示"（规则模式、到最后一集…），和 errorText 分开：它不是故障。 */
    override fun notice(): String? = noticeText

    fun release() {
        active = false
        runCatching { gsy.release() }
    }

    /**
     * 把 GSY 的状态映射到协议里的 state 枚举。
     * 映射规则在 PlaybackState.kt（那是协议的一部分，单独放更好找）。
     */
    private fun stateName(): String = playbackStateName(
        gsyState = gsy.currentState,
        hasMedia = active,
        hasError = errorText != null,
    )
}
