package app.sakana.receiver

import android.content.Context
import android.content.SharedPreferences
import android.util.Log

private const val TAG = "SakanaSyncStore"

/**
 * 同步数据的**本地缓存**与持久化。
 *
 * 为什么一定要落盘：用户点开 App 的那一刻，收藏/历史必须马上有东西可看 ——
 * 不能等网络、更不能因为电脑没开就是白屏。所以流程永远是
 * "先读缓存立刻显示 → 后台同步回来再刷新"。
 *
 * 存法是"整个列表序列化成一个 JSON 字符串塞进 SharedPreferences"：
 * 数据量是几百条以内，用不上数据库；而且序列化/反序列化都能复用我们手写的 Json，
 * 不引 Room/Gson。代价是每次保存要重写整个字符串 —— 对几百条数据可以忽略。
 */
object SyncStore {

    private const val PREFS = "sakana-sync"
    private const val K_FAVORITES = "favorites-json"
    private const val K_HISTORY = "history-json"
    private const val K_SYNC_URL = "sync-url"
    private const val K_PC_NAME = "pc-name"
    private const val K_PC_VERSION = "pc-version"
    private const val K_LAST_SYNC = "last-sync-at"
    private const val K_FAVORITES_AT = "favorites-cached-at"
    private const val K_HISTORY_AT = "history-cached-at"
    private const val K_PUSHED_SIG = "pushed-signature"

    private lateinit var prefs: SharedPreferences

    /**
     * 内存缓存：界面每秒都可能读它，不能每次都去反序列化 JSON。
     * 加 @Volatile：同步是在后台线程写、界面在主线程读，必须保证可见性。
     */
    @Volatile
    private var cachedFavorites: List<Favorite>? = null

    @Volatile
    private var cachedHistory: List<HistoryItem>? = null

    /**
     * 数据版本号：每次内容变化 +1。界面拿它判断"要不要重建列表"，
     * 省掉 LiveData/Flow 那套（本工程刻意只用最朴素的 View 体系）。
     */
    @Volatile
    var version: Int = 0
        private set

    fun init(context: Context) {
        if (!::prefs.isInitialized) {
            prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        }
    }

    /** 是否已经初始化（后台线程可能比 Application 更早碰到它，调用方据此决定要不要干活）。 */
    val isReady: Boolean get() = ::prefs.isInitialized

    private fun bump() {
        version++
    }

    // ---------------- 收藏 ----------------

    val favorites: List<Favorite>
        get() {
            val hit = cachedFavorites
            if (hit != null) return hit
            val loaded = Favorite.listFromJson(Json.parse(prefs.getString(K_FAVORITES, null) ?: ""))
            cachedFavorites = loaded
            return loaded
        }

    fun saveFavorites(list: List<Favorite>) {
        cachedFavorites = list
        prefs.edit().putString(K_FAVORITES, Json.stringify(list.map { it.toJson() })).apply()
        favoritesCachedAt = System.currentTimeMillis()
        bump()
        Log.i(TAG, "收藏已缓存：${list.size} 条")
    }

    /**
     * 用电脑端刚拉到的收藏替换本地缓存，但**不允许空列表覆盖非空缓存**。
     *
     * 为什么要这一层：`Favorite.listFromJson` 会把"没有名字"的条目丢掉（脏数据容错）。
     * 万一电脑端改了字段名，整份列表会被解析成空 —— 那时如果直接保存，
     * 用户看到的就是"收藏突然全没了"。宁可保留旧数据并在界面上说明同步没成功，
     * 也不要让一次解析事故把本地缓存清空。真的在电脑上删光了收藏属于极端情况，
     * 那时用户可以在电脑端重新同步一次（或清掉 App 数据）。
     */
    fun replaceFavoritesFromPc(list: List<Favorite>): Boolean {
        if (list.isEmpty() && favorites.isNotEmpty()) {
            Log.w(TAG, "电脑端这次返回 0 条收藏，本地有 ${favorites.size} 条，保留本地缓存不覆盖")
            return false
        }
        saveFavorites(list)
        return true
    }

    /** 收藏数据的缓存时间（0 = 从没缓存过）。 */
    var favoritesCachedAt: Long
        get() = prefs.getLong(K_FAVORITES_AT, 0L)
        private set(value) {
            prefs.edit().putLong(K_FAVORITES_AT, value).apply()
        }

    /** 历史数据的缓存时间（0 = 从没缓存过）。 */
    var historyCachedAt: Long
        get() = prefs.getLong(K_HISTORY_AT, 0L)
        private set(value) {
            prefs.edit().putLong(K_HISTORY_AT, value).apply()
        }

    /**
     * 本地缓存"有多新"：收藏与历史里**最近**的那次缓存时间。
     * 界面上的"缓存于 …"用的就是它 —— 用户关心的是"我看到的数据是哪一刻的"，
     * 而不是某个分区的精确时间。
     */
    val cachedAt: Long get() = maxOf(favoritesCachedAt, historyCachedAt)

    /** 有没有可用的本地缓存（决定要不要显示"离线 · 缓存于 …"）。 */
    val hasCachedData: Boolean get() = favoritesCachedAt > 0L || historyCachedAt > 0L

    // ---------------- 观看历史 ----------------

    val history: List<HistoryItem>
        get() {
            val hit = cachedHistory
            if (hit != null) return hit
            val loaded = HistoryItem.listFromJson(Json.parse(prefs.getString(K_HISTORY, null) ?: ""))
            cachedHistory = loaded
            return loaded
        }

    fun saveHistory(list: List<HistoryItem>) {
        cachedHistory = list
        prefs.edit().putString(K_HISTORY, Json.stringify(list.map { it.toJson() })).apply()
        historyCachedAt = System.currentTimeMillis()
        bump()
    }

    /**
     * 记一次观看：合并进本地历史并落盘。
     * 同一集反复看会**覆盖**同一条（[HistoryMerge.keyOf] 保证），不会越积越多。
     */
    fun recordWatch(item: HistoryItem) {
        val merged = HistoryMerge.upsert(history, item)
        if (merged == history) return
        saveHistory(merged)
    }

    /** 删掉一条本地历史（长按历史卡片的「删除这条记录」）。 */
    fun removeHistory(item: HistoryItem) {
        val key = HistoryMerge.keyOf(item)
        val kept = history.filterNot { HistoryMerge.keyOf(it) == key }
        if (kept.size == history.size) return
        saveHistory(kept)
    }

    // ---------------- 与电脑的连接信息 ----------------

    /** 电脑端同步服务地址，形如 `http://192.168.1.8:52890`。 */
    var syncUrl: String?
        get() = prefs.getString(K_SYNC_URL, null)?.takeIf { it.isNotBlank() }
        set(value) {
            prefs.edit().putString(K_SYNC_URL, value?.trim()?.takeIf { it.isNotEmpty() }).apply()
            bump()
        }

    /** 电脑名（`/sync/ping` 返回的 `pc`），用来在界面上显示"已连接 <电脑名>"。 */
    var pcName: String?
        get() = prefs.getString(K_PC_NAME, null)?.takeIf { it.isNotBlank() }
        set(value) = prefs.edit().putString(K_PC_NAME, value).apply()

    var pcVersion: String?
        get() = prefs.getString(K_PC_VERSION, null)?.takeIf { it.isNotBlank() }
        set(value) = prefs.edit().putString(K_PC_VERSION, value).apply()

    /** 上次同步成功的时间戳（0 = 从没成功过）。 */
    var lastSyncAt: Long
        get() = prefs.getLong(K_LAST_SYNC, 0L)
        set(value) = prefs.edit().putLong(K_LAST_SYNC, value).apply()

    /** 上次推给电脑的本地历史指纹；用来判断"有变化才推"。 */
    var pushedSignature: String?
        get() = prefs.getString(K_PUSHED_SIG, null)
        set(value) = prefs.edit().putString(K_PUSHED_SIG, value).apply()

    /** 本地历史相对"上次推给电脑的那份"有没有变化。 */
    fun hasUnpushedHistory(): Boolean =
        !history.isEmpty() && HistoryMerge.signatureOf(history) != pushedSignature

    /**
     * 只把版本号 +1，不写盘。
     * 同步结束时用它通知界面"数据可能变了，去重建列表"（真正的数据在 saveXxx 里已经落盘）。
     */
    fun touch() {
        bump()
    }
}
