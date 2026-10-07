package app.sakana.receiver

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 等待主线程完成一个操作的上限。超过就说明主线程被卡住了，不能把 HTTP 线程拖死。 */
private const val MAIN_THREAD_TIMEOUT_MS = 4000L

/** 界面没打开时 /info 要回的"什么都没在放"。电脑端会一直轮询 /info，不能让它拿到错误对象。 */
private val IDLE_SNAPSHOT = PlayerController.Snapshot(
    playing = false,
    positionMs = 0L,
    durationMs = 0L,
    volume = 100,
    muted = false,
    index = -1,
    titles = emptyList(),
    state = Proto.STATE_IDLE,
    title = null,
    canStepPrev = false,
    canStepNext = false,
)

/**
 * 控制接口的业务实现：把 HTTP 请求翻译成对播放器的调用，并把状态序列化成 JSON。
 *
 * **为什么所有动作都要绕一趟主线程**：ExoPlayer 强制要求只在创建它的线程（这里是主线程）上
 * 访问，而 HTTP 请求跑在 ServerSocket 的连接线程里。所以这里统一 post 到主线程，
 * 再用 CountDownLatch 等一小会儿，好让 HTTP 响应能带上**真实结果**。
 */
class ControlApi(
    private val gateway: () -> PlayerGateway?,
    private val deviceName: () -> String,
    private val autoPlay: () -> Boolean,
    private val onClient: (String) -> Unit,
) : ControlServer.Api {

    private val main = Handler(Looper.getMainLooper())

    /** 一次跨线程调用的结果：要么成功拿到值，要么带一个错误说明。 */
    private class CallResult<T> {
        var value: T? = null
        var error: String? = null
    }

    override fun onRequest(remoteIp: String) {
        if (remoteIp.isNotBlank()) onClient(remoteIp)
    }

    /**
     * 在**调用它的那个线程**上阻塞地执行 block（真正的工作会派到主线程）。
     * block 里只能碰必须在主线程访问的东西，也不要做耗时操作，否则会把两个线程一起拖住。
     */
    private fun <T> onMain(block: () -> T): CallResult<T> {
        val result = CallResult<T>()

        // 万一从主线程调用（界面按钮复用同一套逻辑），直接执行，避免自己等自己造成死锁
        if (Looper.myLooper() === Looper.getMainLooper()) {
            try {
                result.value = block()
            } catch (t: Throwable) {
                result.error = t.message ?: t.javaClass.simpleName
            }
            return result
        }

        val latch = CountDownLatch(1)
        main.post {
            try {
                result.value = block()
            } catch (t: Throwable) {
                result.error = t.message ?: t.javaClass.simpleName
            } finally {
                // 无论成功失败都必须 countDown，否则 HTTP 线程要白等满超时
                latch.countDown()
            }
        }
        if (!latch.await(MAIN_THREAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            result.error = "等待主线程超时（${MAIN_THREAD_TIMEOUT_MS}ms）"
        }
        return result
    }

    // ---------------- GET /ping ----------------

    override fun pingJson(): String = Json.stringify(
        linkedMapOf(
            "ok" to true,
            "app" to Proto.APP_ID,
            "v" to Proto.VERSION,
        ),
    )

    // ---------------- GET /info ----------------

    override fun infoJson(): String {
        val player = gateway()
        // 界面没打开时也要回一份合法合理的 /info：电脑端的设备列表与状态一直靠它。
        // 真读不到就用 IDLE_SNAPSHOT 兜底，绝不回错误对象（那会让电脑端显示一片 undefined）。
        val snapshot = if (player == null) {
            IDLE_SNAPSHOT
        } else {
            onMain { player.snapshot() }.value ?: IDLE_SNAPSHOT
        }
        // 字段名和顺序都按协议来。这里**不加** ok 字段：/info 的契约就是这 10 个字段。
        return Json.stringify(
            linkedMapOf(
                "name" to deviceName(),
                "playing" to snapshot.playing,
                "positionMs" to snapshot.positionMs,
                "durationMs" to snapshot.durationMs,
                "volume" to snapshot.volume,
                "muted" to snapshot.muted,
                "index" to snapshot.index,
                "total" to snapshot.titles.size,
                "titles" to snapshot.titles,
                "state" to snapshot.state,
            ),
        )
    }

    // ---------------- POST /play ----------------

    override fun play(body: String): Reply {
        val root = Json.obj(Json.parse(body)) ?: return Reply.bad("请求体不是合法的 JSON 对象")

        // 电脑把自己的**同步服务地址**随每次投屏一起下发（可能是空串 = 用户选了"只用直连"
        // 或同步服务没起来）。先记下来并触发一次同步，再管播放 ——
        // 这样即使本次投屏因为 url 为空而失败，地址也已经存住了，界面上马上就有收藏/历史。
        SyncManager.onPlayReceived(Json.str(root, "syncUrl"))

        val url = Json.str(root, "url")
        if (url.isNullOrBlank()) {
            // 规则模式下电脑端可能只有标题、没有取流地址，这时**必须**明确失败：
            // 电脑端的 sakanaPost 只看状态码，回 200 它会显示"已投屏"，而设备什么都没播。
            return Reply.bad("url 为空：接收端没有可播放的地址（规则模式请在电脑上切集后重新投屏）")
        }

        val player = gateway() ?: return Reply.bad("接收端界面没有打开，无法播放")

        val title = Json.str(root, "title") ?: ""
        val headers = Json.strMap(root["headers"])
        val startMs = Json.long(root, "startMs", 0L)
        // 没给 index（默认 -1）时由 PlayerController 按 url 反查
        val index = Json.int(root, "index", -1)
        val playlist = Json.arr(root["playlist"]).mapNotNull { entry ->
            val m = Json.obj(entry) ?: return@mapNotNull null
            // 规则模式下 playlist 里可能只有 title、url 是空串：这种项**保留**
            // （选集列表要显示标题），但不会被真的拿去播放（PlayerController 会拦住）。
            PlayerController.Item(Json.str(m, "url") ?: "", Json.str(m, "title") ?: "")
        }

        val result = onMain { player.play(url, title, headers, startMs, index, playlist, autoPlay()) }
        // 这里只代表"已经把播放任务下发给播放器了"。真正的起播是异步的，
        // 拉流是否成功要看 /info 的 state 或界面上的错误提示。
        return result.error?.let { Reply.bad("起播失败：$it") } ?: Reply.ok()
    }

    // ---------------- POST /control ----------------

    override fun control(body: String): Reply {
        val root = Json.obj(Json.parse(body)) ?: return Reply.bad("请求体不是合法的 JSON 对象")

        val action = Json.str(root, "action")
        if (action.isNullOrBlank()) return Reply.bad("缺少 action 字段")

        val player = gateway() ?: return Reply.bad("接收端界面没有打开，无法执行控制")

        val value = Json.long(root, "value", 0L)
        val result = onMain { player.control(action, value) }
        result.error?.let { return Reply.bad("执行 $action 失败：$it") }
        // control 返回 false 表示"动作不认识"或"参数不合法"（如 select 越界、或选到规则模式下的空地址）。
        // 必须如实回报 400，否则电脑端会以为操作成功了。
        if (result.value != true) {
            // 把播放器给出的"人话提示"拼进去，让电脑端/日志能直接看出原因
            val why = player.notice()?.let { "：$it" } ?: ""
            return Reply.bad("动作未生效 $action$why")
        }
        return Reply.ok()
    }
}
