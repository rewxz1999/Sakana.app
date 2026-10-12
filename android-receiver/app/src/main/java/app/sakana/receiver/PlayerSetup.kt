package app.sakana.receiver

import com.shuyu.gsyvideoplayer.builder.GSYVideoOptionBuilder
import com.shuyu.gsyvideoplayer.listener.GSYStateUiListener
import com.shuyu.gsyvideoplayer.video.StandardGSYVideoPlayer

/**
 * 给 GSY 组装"这一集该怎么播"的全部选项。
 *
 * 单独一个文件的原因有两个，都不是审美：
 *
 * 1. `PlayerController.kt` 一直贴着 300 行上限，这段是里面最容易独立出来的一块
 *    （它不碰播放列表、不碰状态，只做一次性的配置翻译）。
 * 2. **这里的每一条都必须每次起播都重申一遍 —— 包括那些"关掉"的开关。**
 *    `GSYVideoOptionBuilder` 内部有自己的一套默认值（比如 `isTouchWiget` 默认 true），
 *    `build()` 会把它们**逐个写回播放视图**。也就是说：换第二集时如果这里少写一条，
 *    GSY 的默认行为就会在第二集"复活" —— 表现是"第一集好好的，切一集之后
 *    全屏开始自己转、手势开始和自己打架"，这种问题极难查。
 *    所以这里宁可啰嗦，也不要"反正构造里已经设过一遍了"。
 */
internal fun buildGsyOptions(
    player: StandardGSYVideoPlayer,
    url: String,
    title: String,
    headData: Map<String, String>,
    startMs: Long,
    autoPlay: Boolean,
    speed: Float,
    stateListener: GSYStateUiListener,
): GSYVideoOptionBuilder = GSYVideoOptionBuilder()
    .setUrl(url)
    .setVideoTitle(title)
    /*
     * ★ 请求头就是这一行带进去的。GSY 的链路（AAR 字节码核对过）：
     *   setMapHeadData → GSYModel.mapHeadData → Exo2PlayerManager.initVideoPlayer
     *   → IjkExo2MediaPlayer.setDataSource(ctx, uri, map)
     *   → ExoSourceManager.getHttpDataSourceFactory(...).setDefaultRequestProperties(map)
     * 也就是"默认请求头"，HLS 的主列表/子列表/每个分片都会带上。
     * 为什么 Referer / Cookie 必须带上、以及 User-Agent 与跨协议跳转两个坑，见 PlayHeaders.kt。
     */
    .setMapHeadData(headData)
    // 不缓存到本地：接收端是"投一集看一集"，缓存只会白占用户的存储
    .setCacheWithPlay(false)
    .setSeekOnStart(startMs.coerceAtLeast(0L))
    // 用户选的倍速要**跨集保持**：GSY 每次 setUp 都会用 builder 里的值覆盖播放速度，
    // 不写进去的话"切下一集回到 1 倍速"，用户会以为倍速按钮坏了。
    .setSpeed(speed)
    // 设置页关掉"收到投屏后自动播放"时，只加载不播，等电脑端发 resume
    .setStartAfterPrepared(autoPlay)
    .setGSYStateUiListener(stateListener)
    // —— 以下全部是"把 GSY 的自动行为关掉"，原因逐条写清 ——
    .setIsTouchWiget(false)          // 自带的亮度/音量/拖动进度手势：我们有自己的 PlayerGestures
    .setIsTouchWigetFull(false)
    .setNeedShowWifiTip(false)       // 局域网投屏，没有"你在用移动数据"这个场景
    .setShowPauseCover(false)        // 暂停时不截图盖在画面上
    .setNeedOrientationUtils(false)  // 不自己转屏：全屏/方向归 FullscreenController
    .setRotateViewAuto(false)
    .setRotateWithSystem(false)
    .setLockLand(false)
    .setAutoFullWithSize(false)
    .setOnlyRotateLand(false)
    .setShowFullAnimation(false)     // 不做 GSY 那套全屏切换动画
    .setDismissControlTime(0)        // 显隐只归 PlaybackControls（见那个类的说明）
