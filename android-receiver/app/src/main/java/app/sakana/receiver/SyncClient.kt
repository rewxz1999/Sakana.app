package app.sakana.receiver

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/** 探测同步服务时的超时要短：这是"顺手试一下"，不能把界面卡住。 */
private const val PROBE_TIMEOUT_MS = 1_500

/** 正式同步的超时：要下载收藏/历史，给宽松一点。 */
private const val SYNC_TIMEOUT_MS = 6_000

/** 发指令（play-subject）要等电脑去选源/嗅探，给最长的一个超时。 */
private const val COMMAND_TIMEOUT_MS = 90_000

/**
 * 电脑端同步服务的 HTTP 客户端。
 *
 * 用 `HttpURLConnection` 而不是 OkHttp：本工程不引任何第三方依赖，
 * 而这里只需要"发一个 GET/POST、拿回一段 JSON"，标准库完全够用。
 * **所有方法都是阻塞的**，必须在后台线程调用（调用方见 SyncManager 的单线程执行器）。
 */
internal object SyncClient {

    class Result(val ok: Boolean, val body: String?, val error: String?) {
        fun json(): Any? = body?.let { Json.parse(it) }
    }

    /**
     * 规范化同步地址：没有协议就补 `http://`，去掉尾部斜杠。
     * 电脑端给的是 `http://192.168.1.8:52890` 这种形状，但用户手填的候选地址可能只有 IP，
     * 所以这里统一处理。看不出主机名时返回 null。
     */
    fun normalizeBase(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val withScheme =
            if (text.startsWith("http://") || text.startsWith("https://")) text else "http://$text"
        val trimmed = withScheme.trimEnd('/')
        val host = trimmed.substringAfter("://")
        if (host.isBlank() || host.startsWith(":")) return null
        return trimmed
    }

    fun get(base: String, path: String, timeoutMs: Int = SYNC_TIMEOUT_MS): Result =
        request(base, path, null, timeoutMs)

    fun postJson(
        base: String,
        path: String,
        body: String,
        timeoutMs: Int = SYNC_TIMEOUT_MS,
    ): Result = request(base, path, body, timeoutMs)

    fun probe(base: String): Result = request(base, "/sync/ping", null, PROBE_TIMEOUT_MS)

    fun command(base: String, body: String): Result = postJson(base, "/sync/command", body, COMMAND_TIMEOUT_MS)

    private fun request(base: String, path: String, body: String?, timeoutMs: Int): Result {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(base + path)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = if (body == null) "GET" else "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                useCaches = false
                instanceFollowRedirects = true
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            if (body != null) {
                conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            }
            val code = conn.responseCode
            // 失败时也要把响应体读出来：电脑端的错误说明（message）就在里面，比 "HTTP 400" 有用得多
            val text = streamFor(conn, code)?.use { it.readBytes().toString(StandardCharsets.UTF_8) }
            if (code in 200..299) Result(true, text, null) else Result(false, text, "HTTP $code")
        } catch (t: Throwable) {
            Result(false, null, t.message ?: t.javaClass.simpleName)
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
                // 忽略
            }
        }
    }

    private fun streamFor(conn: HttpURLConnection, code: Int): InputStream? = try {
        if (code in 200..299) conn.inputStream else conn.errorStream
    } catch (_: Throwable) {
        null
    }
}
