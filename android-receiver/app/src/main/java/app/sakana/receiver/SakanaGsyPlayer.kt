package app.sakana.receiver

import android.content.Context
import android.util.AttributeSet
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.SeekBar
import com.shuyu.gsyvideoplayer.GSYVideoManager
import com.shuyu.gsyvideoplayer.video.StandardGSYVideoPlayer
import com.shuyu.gsyvideoplayer.video.base.GSYVideoView

private const val TAG = "SakanaGsy"

/**
 * 播放视图 = **GSY 原生的** [StandardGSYVideoPlayer] + 一层"业务按钮条"。
 *
 * ## 控制栏用 GSY 原生的那套（没有改它一个字节）
 *
 * 类里**没有**覆写 `getLayoutId()`，所以 GSY 用的就是它自己的 `video_layout_normal.xml`：
 * 屏幕中央的播放/暂停键、顶栏的返回键与标题、底栏的进度条 / 时间 / 全屏键、缓冲转圈、
 * 控制栏隐藏后那条细进度线，全是 GSY 原生的图标与配色。
 * （上一版这里覆写了 `getLayoutId()` 去换一套白蓝配色 + 自己拼一整条控制栏；用户明确说
 * 那条不好看、要 GSY 原生观感，所以整条撤掉了，连自绘的 `player_seek*.xml` /
 * `player_progress_line.xml` 一起删了。）
 *
 * 业务上还需要的按钮（选集、上一集/下一集、±10 秒、倍速、方向锁、画面比例、音量±、设置）
 * GSY 的控制栏里没有 —— 于是按"叠一层"的方式补在它正上方：见 [installExtraBar]。
 *
 * ## 只有三件事必须由我们说了算
 *
 * 1. **控制栏什么时候显示/隐藏**：GSY 自己有一套（状态一变就显示 + 2.5 秒后隐藏），
 *    而 v1.1 已经为完全相同的问题跟 Media3 打过一架，结论是**只能有一个负责人**
 *    （见 `PlaybackControls`）。所以把它的计时器覆写成空方法，显隐仍归 `PlaybackControls`；
 *    显示/隐藏仍然是原生地调它自己的 `hideAllWidget()` / `changeUiToXxxShow()`，观感不变。
 * 2. **原生按钮按下去做什么**：返回键 = 退出播放（与返回键第二步、旧版顶栏的 ✕ 同一套动作），
 *    全屏键 = 我们自己的全屏开关。GSY 原来的全屏实现需要外面有一套容器配合
 *    （`startWindowFullscreen`），在本工程的布局里按了不会有任何反应。
 * 3. **手势挂到正确的那一层**：GSY 把手势挂在 `surface_container` 上，而它是覆盖整块画面的
 *    子视图 —— 挂在播放器自己身上一次都不会触发（v0.3.8 就是这么踩的）。见 [installGestureTarget]。
 *    「铺满」同理也得自己实现：GSY 的 `GSYVideoType.setShowType()` 在本工程的布局下是空操作，
 *    而它本来该用的 `GSYSurfaceView.setRenderMode()` 在 14.0.0 里是**空实现**
 *    （反汇编只有一个 `Debuger.printfLog("... not support setRenderMode now")`）。
 *    所以改成给画面视图设 scale，见 `VideoFill.kt`。
 */
class SakanaGsyPlayer @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : StandardGSYVideoPlayer(context, attrs) {

    /** 任何需要界面刷新的状态变化（播放/暂停/缓冲/结束）。 */
    var onChanged: () -> Unit = {}

    /** 播放失败的人话文案；由 PlayerController 记下来给界面和 /info 用。 */
    var onError: (String) -> Unit = {}

    /** 拖动进度条时通知（用来"重新计时"，否则拖到一半控制栏就淡出了）。 */
    var onScrub: () -> Unit = {}

    /** GSY 原生返回键被按下。 */
    var onBackPressed: () -> Unit = {}

    /** GSY 原生全屏键被按下。 */
    var onFullscreenToggle: () -> Unit = {}
    /** 叠在 GSY 底栏上方的那条业务按钮条（跟着 GSY 的底栏一起显隐）。 */
    private var extraBar: View? = null

    init {
        // 关掉 GSY 的自动行为：全屏/方向归 FullscreenController、手势归 PlayerGestures，
        // 让 GSY 也做一遍只会出现两套状态互相覆盖。
        setNeedOrientationUtils(false)
        setRotateViewAuto(false)
        setRotateWithSystem(false)
        setLockLand(false)
        setAutoFullWithSize(false)
        setOnlyRotateLand(false)
        setShowFullAnimation(false)
        setNeedShowWifiTip(false)   // 这是局域网投屏，不存在"你在用移动数据"这个场景
        setIsTouchWiget(false)      // 自带的亮度/音量/拖动进度手势，我们有自己的 PlayerGestures
        setIsTouchWigetFull(false)
        setShowPauseCover(false)    // 暂停时不截图盖在画面上（SurfaceView 也截不到）
        setDismissControlTime(0)    // 显隐归 PlaybackControls，见类注释 1
    }

    // ---------------- 业务按钮条 ----------------

    /**
     * 把业务按钮条叠到 **GSY 自己那条底栏的正上方**。
     *
     * 为什么是"叠"而不是"改 GSY 的布局"：改布局等于把 GSY 的控制栏抄一份进来自己维护，
     * 既是用户明确不要的（他要的就是 GSY 的原生观感），也会在 GSY 升级时立刻过期。
     * 叠上去之后：位置贴着它的底栏（底边距在运行时被修正成底栏的真实高度）、显隐和它完全同步
     * （[setViewShowState] 里镜像）、整层 FrameLayout **不可点击** —— 触摸会继续传给下层的
     * GSY 控制栏与 `surface_container`，所以原生的播放/暂停/进度/时间/全屏照旧能用。
     */
    fun installExtraBar() {
        val bottom = mBottomContainer ?: return
        val root = bottom.parent as? ViewGroup ?: return
        val overlay = LayoutInflater.from(context).inflate(R.layout.player_overlay, root, false)
        overlay.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        root.addView(overlay)
        val bar = overlay.findViewById<View>(R.id.extra_bar)
        // 初始可见性跟随 GSY 的底栏（GSY 的布局里底栏一开始是 invisible）
        bar.visibility = bottom.visibility
        extraBar = bar
        // 底栏高度量过一次才知道，量完把按钮条的底边距对齐它 —— 这样不管 GSY 把底栏做多高，
        // 按钮条永远是"贴在它上面"，不会压住进度条也不会飘在半空
        bottom.post {
            val lp = bar.layoutParams
            if (lp is FrameLayout.LayoutParams && bottom.height > 0) {
                lp.bottomMargin = bottom.height
                bar.layoutParams = lp
            }
        }
    }

    // ---------------- 控制栏显隐 ----------------

    /**
     * 把 GSY 的自动隐藏计时器变成空操作。这是"只留一个显隐负责人"的关键一步：
     * GSY 会在 `changeUiToXxxShow()`、点击空白处等地方调它，只要它还是真的，
     * 就会在我们隐藏之后又把控制栏拉回来。
     */
    override fun startDismissControlViewTimer() = Unit

    override fun cancelDismissControlViewTimer() = Unit

    /** 控制栏（GSY 的顶栏 + 底栏）现在是不是可见的。 */
    fun widgetsVisible(): Boolean =
        mBottomContainer != null && mBottomContainer.visibility == View.VISIBLE

    /**
     * 显示控制栏。**按当前状态选对应的 `changeUiToXxxShow()`**，而不是把两个容器设成 VISIBLE
     * —— 那些方法顺带管着中央播放键、缓冲指示、封面占位该不该出现，自己拼容易漏。
     */
    fun showWidgets() {
        when (currentState) {
            GSYVideoView.CURRENT_STATE_PLAYING -> changeUiToPlayingShow()
            GSYVideoView.CURRENT_STATE_PAUSE -> changeUiToPauseShow()
            GSYVideoView.CURRENT_STATE_AUTO_COMPLETE -> changeUiToCompleteShow()
            GSYVideoView.CURRENT_STATE_ERROR -> changeUiToError()
            GSYVideoView.CURRENT_STATE_PREPAREING,
            GSYVideoView.CURRENT_STATE_PLAYING_BUFFERING_START,
            -> changeUiToPlayingBufferingShow()
            else -> changeUiToNormal()
        }
    }

    /** 隐藏控制栏：直接复用 GSY 的 `hideAllWidget()`（它还会把中央播放键一起收掉）。 */
    fun hideWidgets() {
        hideAllWidget()
    }

    /**
     * GSY 动它的顶/底栏时，把同一份可见性镜像给我们那条业务按钮条。
     * 这样"同一时刻显示/隐藏"不需要第二个计时器，也不可能出现
     * "控制栏淡出了、按钮条还挂在那"这种两套状态打架的画面。
     */
    override fun setViewShowState(view: View?, state: Int) {
        super.setViewShowState(view, state)
        if (view === mBottomContainer) extraBar?.visibility = state
    }

    /**
     * GSY 原生按钮的落点。**图标与位置完全不动**，只换"按下去做什么"：
     *  · 返回键 → 退出播放（和返回键第二步、旧版顶栏的 ✕ 是同一个方法）；
     *  · 全屏键 → 我们自己的全屏开关（横屏 + 隐藏系统栏 + 刘海可用）。
     *    不接的话它会走 GSY 的 `startWindowFullscreen`，那套需要外面有容器配合，
     *    在本工程的布局里按了没有任何反应 —— 那才是真的"按钮不可用"。
     *  · 中央播放键（`R.id.start`）**不拦**，原样交给 GSY 自己的播放/暂停逻辑。
     */
    override fun onClick(v: View) {
        when {
            v === mBackButton -> onBackPressed()
            v === mFullscreenButton -> onFullscreenToggle()
            else -> super.onClick(v)
        }
    }

    // ---------------- 手势接入 ----------------

    /**
     * 把手势挂到**真正会收到触摸**的那一层（`surface_container`），并清掉 GSY 挂在上面的
     * 点击监听。控制栏与按钮条是它的兄弟视图、z 序更高，ViewGroup 派发时先给子 View，
     * 所以"按钮优先、空白处才走手势"天然成立。
     */
    fun installGestureTarget(listener: View.OnTouchListener) {
        val target = findViewById<View>(R.id.surface_container) ?: return
        target.setOnClickListener(null)
        target.setOnTouchListener(listener)
    }

    /**
     * 设置播放器音量（0..1）。返回 false 表示内核还没建好、这一下被丢掉了。
     *
     * 为什么要绕到 `GSYVideoManager` 上去：GSY（和 ExoPlayer 一样）**没有独立音量接口**，
     * 只对外暴露 `setNeedMute(boolean)`。真正的音量在内核上，而内核是进程内单例 ——
     * 这也解释了为什么"静音"必须用"音量设 0 + 记住原档位"来实现。
     */
    fun setVolumeRatio(volume: Float): Boolean {
        val player = GSYVideoManager.instance().player ?: return false
        return try {
            player.setVolume(volume, volume)
            true
        } catch (t: Throwable) {
            Log.d(TAG, "音量设置被丢掉（内核未就绪）: ${t.message}")
            false
        }
    }

    /** 每个心跳都要用到的时间/进度；GSY 自己的 `getDuration()` 在未 prepare 时返回 -1。 */
    fun safeDuration(): Long = getDuration().let { if (it < 0) 0L else it }

    /** 播放器尺寸变了（横竖屏切换、进出播放层）时通知一次，用来重算"铺满"。 */
    var onSizeChangedHook: (() -> Unit)? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w != oldw || h != oldh) onSizeChangedHook?.invoke()
    }

    // ---------------- 状态回调 ----------------

    /*
     * 下面这些覆写都**必须先调 super**：GSY 的界面状态机就建在这些方法里，
     * 只通知不转发会让画面停在上一个状态（比如转圈一直转）。
     */

    override fun onPrepared() {
        super.onPrepared()
        onChanged()
    }

    override fun onBufferingUpdate(percent: Int) {
        super.onBufferingUpdate(percent)
        onChanged()
    }

    override fun onInfo(what: Int, extra: Int) {
        super.onInfo(what, extra)
        onChanged()
    }

    override fun onAutoCompletion() {
        super.onAutoCompletion()
        onChanged()
    }

    override fun onError(what: Int, extra: Int) {
        super.onError(what, extra)
        // GSY 只给两个整数（what/extra），在这里翻译成人话；原始码也留着 ——
        // 真机上排查"某个 CDN 的流放不了"时这两行就是唯一的线索。
        Log.w(TAG, "播放失败 what=$what extra=$extra")
        onError("ExoPlaybackException($what/$extra)：${gsyErrorHint(what)}")
        onChanged()
    }

    // ---------------- 拖动进度条 ----------------

    /*
     * 为什么覆写 SeekBar 的三个回调，而不是给 SeekBar 再 setOnTouchListener：
     * GSY 在 init 里**已经** `mProgressBar.setOnTouchListener(this)` 且
     * `setOnSeekBarChangeListener(this)`，我们再设一次会把它的换掉，
     * `mTouchingProgressBar` 就没人维护了 —— 表现是"拖动时进度条自己跳回去"。
     * 覆写这三个回调既拿到了"正在拖"这个事件，又一个字节都没动 GSY 的接线。
     */

    override fun onStartTrackingTouch(seekBar: SeekBar) {
        super.onStartTrackingTouch(seekBar)
        onScrub()
    }

    override fun onStopTrackingTouch(seekBar: SeekBar) {
        super.onStopTrackingTouch(seekBar)
        onScrub()
    }

    override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
        super.onProgressChanged(seekBar, progress, fromUser)
        if (fromUser) onScrub()
    }
}

/**
 * GSY 的 exo2 内核出错时只上报 `IMediaPlayer` 的两个整数。
 * 这两个值来自 Media3 的 `PlaybackException.errorCode`，翻译成人话方便用户在设备上直接看懂。
 */
private fun gsyErrorHint(what: Int): String = when (what) {
    1 -> "加载失败（地址打不开或需要请求头）"
    2 -> "解码失败（编码格式不支持）"
    3 -> "播放中断（网络或数据源中断）"
    else -> "未知错误"
}
