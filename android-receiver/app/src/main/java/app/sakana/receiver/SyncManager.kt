package app.sakana.receiver

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executors

private const val TAG = "SakanaSync"

/**
 * 双端同步的调度中心：自动连接电脑、拉收藏/历史、把本地历史推给电脑、播放投屏。
 *
 * 所有网络操作都在**一个后台线程**上串行执行（[executor]），所以不会有两份同步互相踩；
 * 界面只读 [SyncStore] 的缓存与这里的几个 @Volatile 状态字段，不需要处理并发。
 *
 * 为什么"自动"很重要：用户点开 App 期望直接看到自己的收藏，而不是先点"连接电脑"。
 * 所以有三条自动路径，任何一条走通都会触发同步：
 *   ① 收到 `/play`（里面有 syncUrl，最权威）；
 *   ② 收到电脑的搜索广播 / 用户手填的地址 → 按候选端口探测 `/sync/ping`；
 *   ③ 冷启动时用上次记下的 syncUrl 直接试。
 */
object SyncManager {

    @Volatile
    var syncing: Boolean = false
        private set

    /** 最近一次同步/连接的失败原因；成功后清空。 */
    @Volatile
    var lastError: String? = null
        private set

    /** 界面顶部要显示的一句话（"正在解析播放源…" / 电脑返回的 message）。 */
    @Volatile
    var statusMessage: String? = null
        private set

    /** 正在等电脑解析播放源（收藏点击之后、`/play` 到达之前）。 */
    @Volatile
    var busyCommand: Boolean = false
        private set

    private var appContext: Context? = null
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "sakana-sync").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())

    /**
     * 找电脑的同步服务（探端口、限流、自动重连）都在 SyncDiscovery.kt；
     * 这里只关心"找到之后同步什么"。找到地址就先记下来，再同步一次。
     */
    private val discovery = SyncDiscovery(executor) { url, reason ->
        if (SyncStore.syncUrl != url) SyncStore.syncUrl = url
        doSync(reason)
    }

    fun init(context: Context) {
        appContext = context.applicationContext
        SyncStore.init(context)
    }

    private fun post(block: () -> Unit) {
        main.post(block)
    }

    // ---------------- 触发点 ----------------

    /**
     * 收到 `/play`：里面的 `syncUrl` 是**最权威**的同步地址，存下来并立刻同步一次。
     * `syncUrl` 可能为空（用户选了"只用直连"或同步服务没起来），这时清掉旧的地址，
     * 界面上的同步按钮会置灰 —— 不能让用户以为还能同步。
     */
    fun onPlayReceived(syncUrl: String?) {
        val normalized = SyncClient.normalizeBase(syncUrl)
        if (normalized == null) {
            SyncStore.syncUrl = null
            statusMessage = null
            Log.i(TAG, "本次投屏没有带 syncUrl，同步功能暂不可用")
            return
        }
        if (normalized != SyncStore.syncUrl) {
            SyncStore.syncUrl = normalized
            Log.i(TAG, "记住同步地址: $normalized")
        }
        // 投屏刚发生，正是同步的好时机（用户此刻就在用设备）
        syncNow("收到投屏")
    }

    /**
     * 看到了电脑（收到它的搜索广播，或用户手填了它的地址）。
     * 还没连过同步服务时，顺手探一下它有没有开同步服务 —— "自动连接"的第 ③ 条路径。
     */
    fun onPcSeen(ip: String) {
        if (ip.isBlank()) return
        val known = SyncStore.syncUrl
        if (known != null && known.contains(ip)) return
        discovery.probe(ip)
    }

    /** 冷启动/回到前台时调：有已知地址就直接同步，没有就拿最近见过的地址探一探。 */
    fun autoConnect() {
        discovery.autoConnect()
    }

    // ---------------- 手动触发 ----------------

    fun syncNow(reason: String) {
        executor.execute { doSync(reason) }
    }

    // ---------------- 同步本体 ----------------

    private fun doSync(reason: String) {
        if (syncing) return
        val base = SyncStore.syncUrl
        if (base == null) {
            lastError = "还没有电脑的同步地址（投屏一次或让电脑搜索本设备即可）"
            return
        }
        syncing = true
        try {
            // ① ping：拿电脑名/版本，顺便确认服务还活着
            val ping = SyncClient.probe(base)
            if (!ping.ok) {
                lastError = "连不上电脑同步服务（$base）"
                Log.w(TAG, "ping 失败: ${ping.error}")
                return
            }
            val pingObj = Json.obj(ping.json())
            if (pingObj != null) {
                SyncStore.pcName = Json.str(pingObj, "pc")
                SyncStore.pcVersion = Json.str(pingObj, "version")
            }

            // ② 收藏（电脑端是权威来源：手机上只读不写）
            val fav = SyncClient.get(base, "/sync/favorites")
            if (fav.ok) {
                val items = Favorite.listFromJson(Json.obj(fav.json())?.get("items"))
                // 空列表不覆盖非空缓存：解析事故不该让用户"收藏全没了"（见 SyncStore 的说明）
                SyncStore.replaceFavoritesFromPc(items)
            } else {
                Log.w(TAG, "拉收藏失败: ${fav.error}")
            }

            // ③ 历史：先合并（同一集取看得更晚的那份），再决定要不要推回电脑
            val hist = SyncClient.get(base, "/sync/history")
            if (hist.ok) {
                val remote = HistoryItem.listFromJson(Json.obj(hist.json())?.get("items"))
                SyncStore.saveHistory(HistoryMerge.merge(SyncStore.history, remote))
            } else {
                Log.w(TAG, "拉历史失败: ${hist.error}")
            }

            // ④ 把本地新增/更新的历史推回电脑；**有变化才推**，否则每次启动都全量写一遍
            if (SyncStore.hasUnpushedHistory()) {
                pushLocalHistory(base)
            }

            SyncStore.lastSyncAt = System.currentTimeMillis()
            lastError = null
            Log.i(TAG, "同步完成（$reason）：收藏 ${SyncStore.favorites.size} 条，历史 ${SyncStore.history.size} 条")
            // ⑤ 同步完成后在后台把"缺图"的封面预取一遍，滚到就有。
            //    已有的缓存会被跳过（一个都不重复抓），计费网络下 CoverPrefetch 自己会放弃。
            CoverLoader.prefetchMissing(SyncStore.favorites.map { it.cover })
        } catch (t: Throwable) {
            lastError = "同步失败：${t.message ?: t.javaClass.simpleName}"
            Log.w(TAG, "同步异常", t)
        } finally {
            syncing = false
            // 通知界面"数据可能变了，去重建列表"（真正的数据在 saveXxx 里已经落盘）
            SyncStore.touch()
        }
    }

    /**
     * 把本地历史推给电脑。电脑端会把它们合并进自己的历史并返回 merged 条数。
     * 推送成功后记下指纹，下次没变化就不再推。
     */
    private fun pushLocalHistory(base: String) {
        val items = SyncStore.history
        if (items.isEmpty()) return
        val body = Json.stringify(linkedMapOf("items" to items.map { it.toJson() }))
        val result = SyncClient.postJson(base, "/sync/history", body)
        if (result.ok) {
            SyncStore.pushedSignature = HistoryMerge.signatureOf(items)
            Log.i(TAG, "本地历史已推给电脑：${items.size} 条")
        } else {
            Log.w(TAG, "推历史失败: ${result.error}")
        }
    }

    // ---------------- 收藏点播 ----------------

    /**
     * 让**电脑**去播一个条目：`POST /sync/command {"action":"play-subject",...}`。
     *
     * 注意语义：接收端**不**自己取流 —— 它只是告诉电脑"放这一部"，
     * 电脑完成"选源 → 选集 → 嗅探直链 → 投屏到本机"，随后 `/play` 会自己送上门。
     * 所以这里只负责显示进度与结果，成功后界面会在收到 `/play` 时自动进入播放。
     */
    fun playSubject(subjectId: Int, episodeIndex: Int?, onDone: (Boolean, String) -> Unit) {
        val base = SyncStore.syncUrl
        if (base == null) {
            onDone(false, "还没有连上电脑的同步服务，无法点播")
            return
        }
        if (busyCommand) {
            onDone(false, "上一条指令还在处理中，请稍候")
            return
        }
        if (subjectId <= 0) {
            onDone(false, "这个条目没有可播放的 id（电脑端没给 subjectId）")
            return
        }
        busyCommand = true
        statusMessage = "电脑正在解析播放源…"

        executor.execute {
            val payload = linkedMapOf<String, Any?>(
                "action" to "play-subject",
                "subjectId" to subjectId,
            )
            // episodeIndex 可省略：不给就是"从第 1 集/续播位置开始"，由电脑端决定
            if (episodeIndex != null && episodeIndex >= 0) payload["episodeIndex"] = episodeIndex

            val result = SyncClient.command(base, Json.stringify(payload))
            val obj = Json.obj(result.json())
            val ok = result.ok && (obj == null || Json.bool(obj, "ok", true))
            // obj 可能为 null（电脑没回 JSON），这时 message 用兜底文案
            val message = (obj?.let { Json.str(it, "message") } ?: "").ifBlank {
                when {
                    ok -> "已交给电脑播放"
                    else -> result.error ?: "电脑没有接受这条指令"
                }
            }

            if (ok) {
                // 记下 subjectId：等 /play 回来就能把这次播放认到具体条目上（历史记录要用）
                WatchRecorder.markPendingSubject(subjectId)
                val episodes = Json.arr(obj?.get("episodes")).size
                statusMessage = if (episodes > 0) "$message（共 $episodes 集）" else message
            } else {
                statusMessage = message
                // 也让状态行用警告色把它显示出来：失败原因比"失败"两个字有用得多
                lastError = message
            }
            busyCommand = false
            post { onDone(ok, message) }
        }
    }

    // ---------------- 本地观看历史 ----------------

    /**
     * 把当前播放状态记进本地历史（由主界面每秒调一次）。
     * 真正的记录逻辑与"等 /play 认领 subjectId"的窗口都在 WatchRecorder.kt。
     */
    fun notePlayback(snapshot: PlayerController.Snapshot) {
        WatchRecorder.notePlayback(snapshot)
    }
}
