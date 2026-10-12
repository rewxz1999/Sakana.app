package app.sakana.receiver

/**
 * 电脑端没指定 UserAgent 时用的默认值：不少 CDN 会拒绝空 UA 的请求。
 * 和换 GSY 之前是同一个值，不要改 —— 有些站点是按 UA 白名单放行的。
 */
private const val DEFAULT_UA =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/**
 * 把 `/play` 带来的 `headers` 组装成 GSY 要的 `Map<String, String>`。
 *
 * ## 这份 map 最后是怎么发出去的（真机/字节码都核对过）
 *
 * ```
 * GSYVideoOptionBuilder.setMapHeadData(map)
 *   → GSYModel.mapHeadData
 *   → Exo2PlayerManager.initVideoPlayer()  (tv.danmaku.ijk.media.exo2)
 *        mediaPlayer.setDataSource(context, uri, mapHeadData)
 *   → ExoSourceManager.getHttpDataSourceFactory(..., headers)
 *        new DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers)
 * ```
 *
 * `setDefaultRequestProperties` 正是换 GSY 之前用的那条路：**默认请求头**会跟着
 * HLS 的主列表、子列表、以及每一个分片请求一起发出去。所以"设备直连 CDN 拉流、
 * 电脑不做中转"这个前提在 GSY 上依然成立（这是 `caps` 里 `headers` 的含义）。
 *
 * ## 与旧实现（Media3 直连）的两处差别，都是 GSY 的接口决定的
 *
 * 1. **User-Agent 现在放进 map 里**。旧实现走的是
 *    `DefaultHttpDataSource.Factory.setUserAgent(...)`（一个独立字段），
 *    而 GSY 没有把它暴露出来 —— 我们只能把 `User-Agent` 当成一个普通请求头透传。
 *    效果一样（DefaultHttpDataSource 会把 map 里的头原样 setRequestProperty 出去），
 *    所以这里把协议里的 `UserAgent` 规范成标准头名 `User-Agent`。
 * 2. **跨协议跳转要靠 map 里一个特殊键**。GSY 的 `ExoSourceManager` 会读
 *    map 里的 `allowCrossProtocolRedirects` 来决定 `setAllowCrossProtocolRedirects(...)`，
 *    所以这里主动塞一个 `"true"`。副作用是它同时也会被当成一个 HTTP 头发出去
 *    （GSY 自己的写法就是这样），多一个没人认识的头不会影响播放。
 *    不带它的后果很具体：不少站点是 http 入口 302 到 https 的 CDN，
 *    默认不允许跨协议跳转时**整条流直接拉不起来**。
 */
internal object PlayHeaders {

    /** 会被翻译成 HttpDataSource 开关、而不是当普通请求头用的键（GSY 的约定）。 */
    private const val KEY_CROSS_PROTOCOL = "allowCrossProtocolRedirects"

    /**
     * @param headers 来自 `/play` 的 headers（Referer / Cookie / UserAgent …）。
     *                整张播放列表共用一份，切集时会继续用同一个 map。
     */
    fun build(headers: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        var userAgent: String? = null
        for ((k, v) in headers) {
            if (v.isEmpty()) continue
            val lower = k.lowercase()
            // 协议里写的是 "UserAgent"，HTTP 标准写法是 "User-Agent"：两个都认，
            // 最后只发一个标准的 User-Agent（发两个同名头，有些 CDN 会当成异常请求直接拒）
            if (lower == "user-agent" || lower == "useragent") {
                userAgent = v
                continue
            }
            if (lower in DROP_HEADERS) continue
            out[k] = v
        }
        out["User-Agent"] = userAgent ?: DEFAULT_UA
        // 见类注释第 2 点：这个键是给 GSY 读的开关，不是给服务器看的头
        out[KEY_CROSS_PROTOCOL] = "true"
        return out
    }

    /**
     * 要丢弃的头，全部用小写比较（HTTP 头名大小写不敏感）。
     * 带错了会出现很难定位的播放问题，所以逐条写清原因：
     *  · Range —— ExoPlayer 靠它做分片与 seek。电脑端如果带了 Range，
     *    我们只会拿到一小段，播放和拖动直接坏掉。
     *  · Accept-Encoding —— HttpURLConnection 一旦看到调用方手动设了它就不再自动解压，
     *    而 ExoPlayer 不认 gzip 的响应体，m3u8 会解析失败。
     *  · Host / Connection / Content-Length / Transfer-Encoding / Expect —— 连接层自己决定，手设会冲突。
     *  · allowCrossProtocolRedirects —— 这个名字在 GSY 里**有特殊含义**（见类注释），
     *    不能让电脑端随便覆盖我们的设置。
     */
    private val DROP_HEADERS = setOf(
        "range",
        "accept-encoding",
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "expect",
        KEY_CROSS_PROTOCOL.lowercase(),
    )
}
