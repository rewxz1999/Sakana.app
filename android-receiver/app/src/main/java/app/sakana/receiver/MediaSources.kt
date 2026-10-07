package app.sakana.receiver

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource

/** 电脑端没指定 UserAgent 时用的默认值：不少 CDN 会拒绝空 UA 的请求。 */
private const val DEFAULT_UA =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/**
 * 把一个 URL 组装成 ExoPlayer 能播的 MediaSource，并负责把电脑端给的请求头带上去。
 *
 * 单独一个文件（而不是塞进 PlayerController）的原因：
 *  · 这里关心的是"网络请求怎么发"，PlayerController 关心的是"播放状态怎么管"，两件事；
 *  · 这段逻辑是本协议实现里最容易出问题、也最需要解释的部分，值得独立成一篇。
 */
internal object MediaSources {

    /**
     * @param headers 来自 /play 的 headers（Referer / Cookie / UserAgent …）。
     *                整张播放列表共用一份，切集时会继续用同一个 map。
     */
    fun create(url: String, title: String, headers: Map<String, String>): MediaSource {
        // 兜底：规则模式下 playlist 里可能只有标题。拿空地址去构造 Uri 会得到一个
        // 谁也看不懂的解码错误，不如在这里就明确失败（调用方会把它显示成人话提示）。
        require(url.isNotBlank()) { "播放地址为空（规则模式请在电脑上切集后重新投屏）" }

        val factory = DefaultHttpDataSource.Factory()
            // ★ 这个协议实现里最关键的一行 ★
            // 把 Referer / Cookie 设成「默认请求头」。HLS 播放会发出很多次请求：
            // 主列表 m3u8、子列表、以及**每一个分片**。用 setDefaultRequestProperties 之后，
            // 这些请求全部自动带上同样的头，既不用为每次请求单独配置，
            // 更不需要电脑端做中转代理 —— 设备直接连 CDN 拉流，
            // 画质和流畅度才不会被电脑的上传带宽卡住。
            // （这也是 caps 里承诺 "headers" 的含义）
            .setDefaultRequestProperties(sanitizeHeaders(headers))
            // UserAgent 单独设置：DefaultHttpDataSource 会把它作为真正的 User-Agent 头发出去。
            // 如果只塞进默认头里，发出去的会是名字很怪的 "UserAgent:"（协议里字段就叫这个名字），
            // 有些 CDN 看到没有标准 UA 会直接 403。
            .setUserAgent(headerValue(headers, "UserAgent") ?: headerValue(headers, "User-Agent") ?: DEFAULT_UA)
            // 不少 CDN 会 302 到另一个协议（http <-> https），而默认是不允许跨协议跳转的
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)

        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(url))
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()

        // 明确区分 HLS 与直链：
        //  · url 里出现 .m3u8 -> 用 HlsMediaSource
        //  · 其它（mp4 直链等）-> 用 DefaultMediaSourceFactory（渐进式播放）
        // 为什么不统一交给 DefaultMediaSourceFactory：它内部是用**反射**去找 HLS 工厂的，
        // release 开混淆后万一被裁掉，表现是"悄悄退化成只认 mp4"，没有任何报错，很难查。
        // 这里写死更稳，代价只是多几行。
        return if (url.lowercase().contains(".m3u8")) {
            HlsMediaSource.Factory(factory).createMediaSource(mediaItem)
        } else {
            DefaultMediaSourceFactory(factory).createMediaSource(mediaItem)
        }
    }

    /**
     * 过滤掉"不该由我们设置"的请求头。带错了会出现很难定位的播放问题，所以列清楚原因：
     *  · Range —— ExoPlayer 靠它做分片与 seek。电脑端如果带了 Range，
     *    我们会只拿到一小段，播放和拖动直接坏掉。
     *  · Accept-Encoding —— HttpURLConnection 一旦看到调用方手动设了它，
     *    就不再自动解压，而 ExoPlayer 不认 gzip 的响应体，m3u8 会解析失败。
     *  · Host / Connection / Content-Length / Transfer-Encoding —— 连接层自己决定，手设会冲突。
     *  · User-Agent / UserAgent —— 走 setUserAgent 单独设置（见 create）。
     * 其余的（Referer / Cookie / Origin / 自定义鉴权头…）原样透传。
     */
    private fun sanitizeHeaders(headers: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((k, v) in headers) {
            if (k.lowercase() in DROP_HEADERS) continue
            if (v.isEmpty()) continue
            // 头名大小写不敏感，HttpURLConnection 自己会规范化，这里原样透传即可
            out[k] = v
        }
        return out
    }

    /** 大小写不敏感地取一个请求头（协议里写的是 "UserAgent"，标准写法是 "User-Agent"，两个都认）。 */
    private fun headerValue(headers: Map<String, String>, name: String): String? = headers.entries
        .firstOrNull { it.key.equals(name, ignoreCase = true) }
        ?.value
        ?.takeIf { it.isNotBlank() }

    /** 要丢弃的头，全部用小写比较（HTTP 头名大小写不敏感）。原因见 [sanitizeHeaders]。 */
    private val DROP_HEADERS = setOf(
        "range",
        "accept-encoding",
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "user-agent",
        "useragent",
        "expect",
    )
}
