package app.sakana.receiver

import android.content.Context
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

private const val TAG = "SakanaPlayer"

/**
 * 播放控制：ExoPlayer 的封装 + 播放列表 / 音量 / 状态。
 *
 * 职责边界：本类只关心"什么时候播、播哪一集、音量多少、现在是什么状态"。
 * "这个 URL 该怎么组装成 MediaSource、Referer/Cookie 怎么带上去"在 MediaSources.kt。
 *
 * **线程约定（很重要）**：ExoPlayer 只允许在创建它的线程上访问，这里就是主线程。
 * 所以本类所有 public 方法都必须从主线程调用 —— ControlApi 负责把 HTTP 线程上的
 * 请求 post 到主线程（见 ControlApi.onMain）。
 */
class PlayerController(
    context: Context,
    playerView: PlayerView,
    private val onChanged: () -> Unit,
) : PlayerGateway {

    /**
     * 播放列表里的一集。
     *
     * ⚠️ `url` 可能是**空串**：电脑端在"规则模式"下只能拿到剧集标题、拿不到每一集的取流地址，
     * 于是 playlist 里全是 `{"url":"","title":"第 3 集"}`。这种项要保留（选集列表得显示标题），
     * 但**绝不能**拿空地址去请求 —— 那会变成一句谁也看不懂的解码错误。
     */
    data class Item(val url: String, val title: String)

    /** /info 需要的快照。一次性抓出来，避免调用方反复访问 ExoPlayer。 */
    data class Snapshot(
        val playing: Boolean,
        val positionMs: Long,
        val durationMs: Long,
        val volume: Int,
        val muted: Boolean,
        val index: Int,
        val titles: List<String>,
        val state: String,
        val title: String?,
        /** 上一集/下一集有没有能切的目标（规则模式下 playlist 只有标题，这里就是 false）。 */
        val canStepPrev: Boolean,
        val canStepNext: Boolean,
    )

    private val player: ExoPlayer = ExoPlayer.Builder(context).build()

    private val items = ArrayList<Item>()
    private var index = -1
    private var volumePercent = 100
    private var muted = false
    private var currentTitle: String? = null
    private var errorText: String? = null
    private var noticeText: String? = null

    /** /play 是否要求立刻播放（设置里的"自动播放"）。关掉时只 prepare 不 play。 */
    private var startPlaying = true

    /**
     * /play 带来的请求头（Referer / Cookie / UserAgent 等）。
     * 整张播放列表共用一份：切集时继续用同一份头，否则下一集会被 CDN 拒掉。
     */
    private var headers: Map<String, String> = emptyMap()

    init {
        // 用 PlayerView 只为了拿到它现成的 Surface 与画面比例适配逻辑。
        // 控制条自己画（useController = false）：投屏的人是坐在电脑前面操作的，
        // 设备上那套触摸控制条既用不上，还会跟我们的按钮抢焦点、挡住画面。
        playerView.useController = false
        playerView.player = player

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                onChanged()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                onChanged()
            }

            override fun onPlayerError(error: PlaybackException) {
                // ExoPlayer 出错后自己会停在 IDLE，不会自动恢复。
                // 这里记下来给界面和 /info 用；要不要重试由电脑端决定（再发一次 /play），
                // 接收端擅自重试反而可能把"地址过期"变成无限重连。
                errorText = "${error.errorCodeName}：${error.message ?: "未知错误"}"
                Log.w(TAG, "播放失败", error)
                onChanged()
            }
        })

        applyVolume()
    }

    // ---------------- /play ----------------

    override fun play(
        url: String,
        title: String,
        headers: Map<String, String>,
        startMs: Long,
        index: Int,
        playlist: List<Item>,
        autoPlay: Boolean,
    ) {
        this.headers = headers
        this.startPlaying = autoPlay
        items.clear()
        items.addAll(playlist)

        var idx = index
        if (idx !in items.indices) {
            // 电脑端可能只发 url 不发 index：按 url 在列表里反查
            idx = items.indexOfFirst { it.url == url }
        }
        if (idx !in items.indices) {
            // 反查不到（列表里的 url 和 url 字段不一致，或者干脆没给列表）：
            // 把这一集当成列表里新的一项
            items.add(Item(url, title))
            idx = items.size - 1
        } else if (items[idx].url.isBlank() && url.isNotBlank()) {
            // 规则模式：列表里那一项只有标题，而 url 字段给的是**当前这一集**的真实地址，
            // 把它补进去，否则这一集根本播不起来。
            items[idx] = items[idx].copy(url = url)
        }

        startItem(idx, startMs)
    }

    /**
     * 起播第 idx 集。
     * @return false 表示这一集没有可播放的地址（规则模式），已经给出人话提示而不是发请求。
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
        try {
            // MediaSource 怎么组装（含 Referer/Cookie 为什么必须带）见 MediaSources.kt
            player.setMediaSource(
                MediaSources.create(item.url, item.title, headers),
                startMs.coerceAtLeast(0L),
            )
            player.prepare()
            // 设置里关掉"自动播放"时，这里只加载不播，等电脑端发 resume
            player.playWhenReady = startPlaying
        } catch (t: Throwable) {
            errorText = t.message ?: t.toString()
            Log.w(TAG, "起播失败: ${item.url}", t)
        }
        onChanged()
        return true
    }

    // ---------------- /control ----------------

    /**
     * 执行一个控制动作。
     * @return false 表示动作名不认识、或参数不合法 / 目标集没有播放地址，
     *         调用方会据此回 400（并可用 [notice] 拿到人话解释）。
     */
    override fun control(action: String, value: Long): Boolean {
        when (action.lowercase()) {
            "pause" -> player.pause()
            "resume" -> player.play()
            "toggle" -> if (player.isPlaying) player.pause() else player.play()
            "stop" -> {
                // stop 之后**保留**列表和下标：这样电脑端还能接着发 next / select 把它拉回来，
                // 界面上"选集"列表也不会突然变空（用户会以为投屏断了）。
                player.stop()
                player.clearMediaItems()
                currentTitle = null
                errorText = null
                noticeText = null
            }
            "next" -> if (!step(1)) return false
            "prev" -> if (!step(-1)) return false
            "seek" -> {
                val target = value.coerceAtLeast(0L)
                val duration = player.duration
                // 直播流（duration 未知 = C.TIME_UNSET）也允许 seek，
                // 超出范围的值交给 ExoPlayer 自己夹紧
                player.seekTo(
                    if (duration != C.TIME_UNSET && duration > 0) target.coerceAtMost(duration) else target,
                )
            }
            "volume" -> {
                // value 是 0-100，内部换算成 0-1 的播放器音量
                volumePercent = value.toInt().coerceIn(0, 100)
                // 调音量视为"取消静音"：否则用户按了音量键听不到变化，会以为遥控坏了
                muted = false
                applyVolume()
            }
            "mute" -> {
                muted = value != 0L
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
        // ExoPlayer 没有独立的静音开关，只能把音量设成 0，
        // 并自己记住"静音前的档位"，这样取消静音能回到原音量而不是回到 100%。
        player.volume = if (muted) 0f else volumePercent / 100f
    }

    // ---------------- /info ----------------

    override fun snapshot(): Snapshot {
        val duration = player.duration.let { if (it == C.TIME_UNSET || it < 0) 0L else it }
        return Snapshot(
            playing = player.isPlaying,
            positionMs = player.currentPosition.coerceAtLeast(0L),
            durationMs = duration,
            volume = volumePercent,
            muted = muted,
            index = index,
            titles = items.map { it.title },
            state = stateName(),
            title = currentTitle,
            canStepPrev = canStep(-1),
            canStepNext = canStep(1),
        )
    }

    /** 最近一次播放错误；没有错误时是 null（界面拿它显示"播放失败：…"）。 */
    override fun lastError(): String? = errorText

    /** 最近一次"人话提示"（规则模式、到最后一集…），和 errorText 分开：它不是故障。 */
    override fun notice(): String? = noticeText

    fun release() {
        player.release()
    }

    /**
     * 把 ExoPlayer 的状态映射到协议里的 state 枚举。
     * 映射规则在 PlaybackState.kt（那是协议的一部分，单独放更好找）。
     */
    private fun stateName(): String = playbackStateName(
        playbackState = player.playbackState,
        isPlaying = player.isPlaying,
        mediaItemCount = player.mediaItemCount,
        hasError = errorText != null,
    )
}
