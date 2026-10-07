package app.sakana.receiver

import android.util.Log
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

private const val TAG = "SakanaHttp"

/** 单个连接的读超时。卡住的客户端最多占用一个线程这么久，然后被丢掉。 */
private const val SOCKET_TIMEOUT_MS = 5000

/** 统一的成功响应。协议规定就是这三个字，别多也别少。 */
internal const val OK_JSON = "{\"ok\":true}"

/**
 * 统一的失败响应。
 * 错误信息走 Json.stringify 转义，避免消息里的引号把响应体拼成非法 JSON ——
 * 电脑端如果解析失败，只会看到"投屏没反应"，那就白写这条错误了。
 */
internal fun errorJson(message: String): String =
    "{\"ok\":false,\"error\":" + Json.stringify(message) + "}"

/**
 * 一个 HTTP 响应：状态码 + JSON 文本。
 *
 * **为什么失败一定要用非 2xx**：电脑端（`cast.ts` 的 `sakanaPost`）只判断
 * `status >= 200 && status < 300`，**完全不看响应体**。所以如果我们失败时也回 200，
 * 电脑端会显示"已投屏"，而设备其实什么都没播 —— 这种"看起来成功的失败"最难排查。
 */
class Reply(val code: Int, val json: String) {
    companion object {
        fun ok(): Reply = Reply(200, OK_JSON)
        /** 请求本身有问题（缺字段、url 为空、动作不支持…）：400，让电脑端能立刻知道自己错了。 */
        fun bad(message: String): Reply = Reply(400, errorJson(message))
    }
}

/**
 * 控制接口服务端：HTTP + JSON，自己用 ServerSocket 实现。
 *
 * 职责边界：这里只管"HTTP 怎么解析、路由怎么分发"，
 * 完全不碰播放器 —— 业务动作通过 [Api] 回调出去（实现见 ControlApi）。
 * 这样播放器改逻辑、或者协议加端点，两边互不影响。
 */
class ControlServer(private val api: Api) {

    /** 控制接口的业务实现方。 */
    interface Api {
        /** 每个 HTTP 请求都会先调它，参数是客户端地址（用来在界面上显示"已被谁连接"）。 */
        fun onRequest(remoteIp: String)

        fun pingJson(): String
        fun infoJson(): String
        fun play(body: String): Reply
        fun control(body: String): Reply
    }

    /** 实际绑定的端口；可能不是 52889（见 [start]）。调用 start 之前是 -1。 */
    @Volatile
    var port: Int = -1
        private set

    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null

    /**
     * 绑定端口并开始服务，返回真实端口。
     *
     * **为什么端口被占用要顺延，而不是直接报错**：
     * 端口只是"默认值"（用户还能在设置里改），设备上完全可能已经被别的程序占着，
     * 或者被上一个还没被系统完全回收的本应用进程占着（TIME_WAIT / 进程还在退出）。
     * 如果这时直接失败，用户看到的现象是"电脑端说投屏成功但完全控制不了"，
     * 而且没有任何可操作的提示。顺延之后，真实端口会通过两个渠道告诉电脑端：
     *   ① UDP 发现报文里的 port 字段（自动发现时用）；
     *   ② 界面上显示的 IP:端口（用户手动填写时用）。
     * 所以电脑端永远不需要猜端口。
     */
    fun start(startPort: Int = Proto.DEFAULT_CONTROL_PORT): Int {
        var candidate = startPort.coerceIn(1024, 65535)
        val first = candidate
        var lastError: IOException? = null
        for (i in 0 until Proto.MAX_PORT_TRIES) {
            try {
                val s = ServerSocket()
                // 允许快速重启：上一个实例刚退出时端口可能还在 TIME_WAIT，此时也应该能绑上。
                // 注意 reuseAddress **不会**让"另一个正在 LISTEN 的 socket"被抢走，
                // 所以真正的占用仍然会走到下面的顺延分支。
                s.reuseAddress = true
                s.bind(InetSocketAddress(candidate), 16)
                serverSocket = s
                port = candidate
                running = true
                acceptThread = Thread({ acceptLoop(s) }, "sakana-http").apply {
                    isDaemon = true
                    start()
                }
                Log.i(TAG, "控制服务已启动: 0.0.0.0:$candidate")
                return candidate
            } catch (e: IOException) {
                lastError = e
                candidate++
            }
        }
        throw IOException("从 $first 起连续 ${Proto.MAX_PORT_TRIES} 个端口都被占用", lastError)
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: IOException) {
            // 关闭失败没有补救手段，忽略
        }
        serverSocket = null
        acceptThread = null
    }

    private fun acceptLoop(s: ServerSocket) {
        while (running) {
            val client = try {
                s.accept()
            } catch (e: IOException) {
                if (!running) return // 是我们自己 close 掉的，正常退出
                // 别在异常上打转，歇一下再 accept
                try {
                    Thread.sleep(50)
                } catch (_: InterruptedException) {
                    return
                }
                continue
            }
            // 一个连接一个短命线程。并发量就是"电脑端一个人"，不值得引线程池；
            // 加上 soTimeout，卡住的客户端最多占住一个线程 5 秒。
            Thread({ serve(client) }, "sakana-http-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun serve(client: Socket) {
        try {
            client.soTimeout = SOCKET_TIMEOUT_MS
            val request = Http.read(client.getInputStream()) ?: return
            // 记一下是谁在跟我说话：界面上的"已被 192.168.1.20 连接"就是从这里来的
            api.onRequest(client.inetAddress?.hostAddress ?: "")
            val reply = route(request)
            Http.writeJson(client.getOutputStream(), reply.code, reply.json)
        } catch (t: Throwable) {
            // 连不上的客户端不值得记 Error 级别的日志，但排查问题时有用
            Log.w(TAG, "处理请求失败: ${t.message}")
        } finally {
            try {
                client.close()
            } catch (_: IOException) {
                // 忽略
            }
        }
    }

    private fun route(request: HttpRequest): Reply {
        // OPTIONS 一律放行：浏览器跨域预检用。电脑端是 Node，本来不需要，加上无害。
        if (request.method == "OPTIONS") return Reply.ok()

        val known = request.path == "/ping" || request.path == "/info" ||
            request.path == "/play" || request.path == "/control"
        if (!known) return Reply(404, errorJson("未知路径 ${request.path}"))

        return try {
            when {
                // /ping 与 /info 的响应体不是固定的 {"ok":true}，所以直接用自定义 JSON 构造 200 响应
                request.path == "/ping" && request.method == "GET" -> Reply(200, api.pingJson())
                request.path == "/info" && request.method == "GET" -> Reply(200, api.infoJson())
                request.path == "/play" && request.method == "POST" -> api.play(request.body)
                request.path == "/control" && request.method == "POST" -> api.control(request.body)
                else -> {
                    val expect = if (request.path == "/ping" || request.path == "/info") "GET" else "POST"
                    Reply(405, errorJson("${request.path} 只接受 $expect，收到 ${request.method}"))
                }
            }
        } catch (t: Throwable) {
            // 业务异常也必须回 JSON：否则电脑端只能看到"连接被重置"，
            // 完全无从判断是设备没收到、还是设备自己崩了。
            Log.w(TAG, "处理 ${request.method} ${request.path} 失败", t)
            Reply(500, errorJson("服务端异常: ${t.message ?: t.javaClass.simpleName}"))
        }
    }
}
