package app.sakana.receiver

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/**
 * 解析出来的一个 HTTP 请求。
 * headers 的键统一转成小写，取值时不用再操心大小写。
 */
class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String,
)

/**
 * 手写的极简 HTTP 读写，**不引任何 HTTP 框架**（NanoHTTPD / Ktor / OkHttp server 都不引）。
 *
 * 为什么不引框架：本工程只需要"读一个请求、回一个 JSON"这一件事。引框架会让 APK 变大，
 * 还得迁就它的线程模型和生命周期；而这段代码总共几百行，完全可控。
 *
 * 解析风格是**故意宽松**的（电脑端是 Node，请求写法可能很随意）：
 *  · 请求行/头行同时接受 CRLF 和裸 LF；
 *  · 畸形的头直接忽略，不因此拒掉整条请求；
 *  · body 支持 Content-Length 和 Transfer-Encoding: chunked 两种主流写法；
 *  · 两者都没有时，只对 POST/PUT/PATCH 兜底读到连接结束（靠 socket 超时收尾）；
 *  · 请求行写成绝对 URL（代理风格）也能正确取出 path；
 *  · 请求前后的空行、多余的空白都能容忍。
 *
 * 有意**不**做的：keep-alive（响应一律 Connection: close）、HTTP/2、分块响应、
 * multipart、gzip 请求体。协议用不到，做了反而是负担。
 */
object Http {

    /** body 上限 4MB：协议里最大的 body 就是带几百集 playlist 的 /play，正常只有几十 KB。 */
    private const val MAX_BODY_BYTES = 4 * 1024 * 1024

    /** 请求头总长上限，防止有人用无限的头把内存撑爆。 */
    private const val MAX_HEADER_CHARS = 64 * 1024

    /**
     * 读一个请求。连接直接断开（没读到任何内容）时返回 null。
     * 注意这个方法会**阻塞**到请求头读完、以及 body 按声明长度读满为止，
     * 所以调用方必须给 socket 设 soTimeout（见 ControlServer.serve）。
     */
    fun read(input: InputStream): HttpRequest? {
        val r = ByteReader(input)

        // 容忍请求前面可能出现空行
        var line = r.readLine()
        while (line != null && line.isBlank()) line = r.readLine()
        if (line == null) return null

        val parts = line.trim().split(' ').filter { it.isNotEmpty() }
        if (parts.size < 2) return null
        val method = parts[0].uppercase()
        val path = normalizePath(parts[1])

        val headers = HashMap<String, String>()
        var headerChars = 0
        while (true) {
            val h = r.readLine() ?: break
            if (h.isBlank()) break // 空行 = 头结束
            headerChars += h.length
            if (headerChars > MAX_HEADER_CHARS) return null
            val colon = h.indexOf(':')
            // 宽松：认不出是头的行直接跳过，不要因此拒绝整条请求
            if (colon <= 0) continue
            headers[h.substring(0, colon).trim().lowercase()] = h.substring(colon + 1).trim()
        }

        return HttpRequest(method, path, headers, readBody(r, method, headers))
    }

    /** 取出 path（丢掉 query）。协议里的路由都不带参数，留着反而要多做一次比较。 */
    private fun normalizePath(target: String): String {
        var t = target
        val scheme = t.indexOf("://")
        if (scheme >= 0) {
            // 绝对 URL 形式（有些客户端/代理会这么发）
            val slash = t.indexOf('/', scheme + 3)
            t = if (slash >= 0) t.substring(slash) else "/"
        }
        val query = t.indexOf('?')
        if (query >= 0) t = t.substring(0, query)
        if (t.isEmpty()) return "/"
        return if (t.startsWith("/")) t else "/$t"
    }

    private fun readBody(r: ByteReader, method: String, headers: Map<String, String>): String {
        val transferEncoding = headers["transfer-encoding"]
        if (transferEncoding != null && transferEncoding.contains("chunked", ignoreCase = true)) {
            return readChunked(r)
        }

        val length = headers["content-length"]?.trim()?.toIntOrNull() ?: -1
        if (length > 0) {
            if (length > MAX_BODY_BYTES) return ""
            // 按声明长度读满：这样即使 TCP 把一个 body 拆成好几个包也不会读到一半
            return String(r.readFully(length), StandardCharsets.UTF_8)
        }
        if (length == 0) return ""

        // 既没有 Content-Length 也没声明 chunked：
        // 只有"本来就可能带 body"的方法才值得冒险读到连接结束 ——
        // 对 GET 这么做会一直等到 socket 超时（因为客户端不会主动关连接）。
        return if (method == "POST" || method == "PUT" || method == "PATCH") {
            String(r.readToEnd(MAX_BODY_BYTES), StandardCharsets.UTF_8)
        } else {
            ""
        }
    }

    private fun readChunked(r: ByteReader): String {
        val out = ByteArrayOutputStream(1024)
        while (true) {
            val sizeLine = r.readLine() ?: break
            // 允许 "1a;ext=value" 这种带扩展的块长度写法
            val hex = sizeLine.trim().substringBefore(';').trim()
            val size = hex.toIntOrNull(16) ?: break
            if (size <= 0) {
                // 末块（size 为 0）：把 trailer 头读干净，通常就是一串空行
                while (true) {
                    val trailer = r.readLine() ?: break
                    if (trailer.isBlank()) break
                }
                break
            }
            if (out.size() + size > MAX_BODY_BYTES) break
            out.write(r.readFully(size))
            r.readLine() // 块数据后面的 CRLF；读不到也无所谓
        }
        return String(out.toByteArray(), StandardCharsets.UTF_8)
    }

    /**
     * 写一个 JSON 响应。
     * 所有响应都是"带 Content-Length + Connection: close"，不含分块响应 ——
     * 客户端（Node）看到 close 就知道读完即断，不会有歧义。
     */
    fun writeJson(out: OutputStream, code: Int, json: String) {
        val body = json.toByteArray(StandardCharsets.UTF_8)
        val head = buildString(256) {
            append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            // 不做 keep-alive：省掉连接状态管理，也避免"响应还没读完客户端又发下一个请求"的边界情况
            append("Connection: close\r\n")
            append("Cache-Control: no-store\r\n")
            // 电脑端是 Node 直连，严格来说不需要 CORS；加上是为了万一有人用浏览器/网页工具调接口时不被拦
            append("Access-Control-Allow-Origin: *\r\n")
            append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: *\r\n")
            append("Access-Control-Max-Age: 600\r\n")
            append("\r\n")
        }
        // 头部用 ISO-8859-1 写出：头部只可能是 ASCII，用这个编码能保证字节与字符一一对应，
        // 不会因为默认编码（Windows 上可能是 GBK）把内容改掉。
        out.write(head.toByteArray(StandardCharsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun reason(code: Int): String = when (code) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        413 -> "Payload Too Large"
        500 -> "Internal Server Error"
        else -> "Status"
    }
}

/**
 * 带缓冲的按需读取器。
 *
 * 为什么不用 BufferedReader：它会**预读**一大块到自己的缓冲区里，
 * 于是"读完请求头之后从原始流里读 body"就会读不到（数据已经被 BufferedReader 吃掉了）。
 * 自己管缓冲就能精确控制"头读到哪、body 从哪开始"。
 */
private class ByteReader(private val input: InputStream) {

    private val buf = ByteArray(8192)
    private var len = 0
    private var pos = 0

    /** 确保缓冲区里还有数据；返回 false 表示连接已结束。 */
    private fun fill(): Boolean {
        if (pos < len) return true
        len = input.read(buf)
        pos = 0
        return len > 0
    }

    /** 读一行（不含换行符）。连接已结束且一个字节都没读到时返回 null。 */
    fun readLine(): String? {
        val out = ByteArrayOutputStream(128)
        var any = false
        while (true) {
            if (!fill()) {
                return if (any) String(out.toByteArray(), StandardCharsets.ISO_8859_1) else null
            }
            val b = buf[pos++].toInt() and 0xFF
            any = true
            if (b == '\n'.code) {
                val bytes = out.toByteArray()
                // 同时接受 CRLF 和裸 LF：末尾是 \r 就一并去掉
                val n = if (bytes.isNotEmpty() && bytes[bytes.size - 1] == '\r'.code.toByte()) {
                    bytes.size - 1
                } else {
                    bytes.size
                }
                return String(bytes, 0, n, StandardCharsets.ISO_8859_1)
            }
            out.write(b)
        }
    }

    /** 尽量读满 n 个字节；对端提前断开时返回已经读到的部分（不要死等）。 */
    fun readFully(n: Int): ByteArray {
        val out = ByteArrayOutputStream(n)
        var left = n
        while (left > 0) {
            if (!fill()) break
            val take = minOf(left, len - pos)
            out.write(buf, pos, take)
            pos += take
            left -= take
        }
        return out.toByteArray()
    }

    /** 一直读到连接结束，或达到 limit 为止（只用于没声明长度的兜底路径）。 */
    fun readToEnd(limit: Int): ByteArray {
        val out = ByteArrayOutputStream(1024)
        while (out.size() < limit) {
            if (!fill()) break
            val take = minOf(limit - out.size(), len - pos)
            out.write(buf, pos, take)
            pos += take
        }
        return out.toByteArray()
    }
}
