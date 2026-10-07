package app.sakana.receiver

/**
 * 电脑端同步服务的数据模型（收藏 / 观看历史）。
 *
 * 协议来源：`{syncUrl}/sync/favorites` 与 `{syncUrl}/sync/history`。
 * 解析一律**宽松**：字段缺失、类型串了（数字写成字符串）都不该让整条记录丢掉 ——
 * 同步数据是"锦上添花"，一条坏记录不该拖垮整个列表。
 */

/** 收藏条目（`/sync/favorites` 的 items[] 里的一项）。 */
data class Favorite(
    val subjectId: Int,
    /** 原名（可能是日文/罗马音） */
    val name: String,
    /** 中文名，优先显示这个 */
    val nameCn: String,
    /** 封面地址，**可能是 https**，也可能是空串 */
    val cover: String,
    val rating: Double,
    val airDate: String,
    val genres: List<String>,
    /** 集数；电脑端可能给数字也可能给 "12" 这样的字符串，认不出来就是 0 */
    val eps: Int,
) {
    /** 列表上显示的名字：优先中文名。 */
    val displayName: String get() = nameCn.ifBlank { name }

    /** 评分显示（没有评分时返回空串，让界面别显示 "0.0"）。 */
    val ratingText: String get() = if (rating > 0.0) String.format("%.1f", rating) else ""

    fun toJson(): Map<String, Any?> = linkedMapOf(
        "subjectId" to subjectId,
        "name" to name,
        "nameCn" to nameCn,
        "cover" to cover,
        "rating" to rating,
        "airDate" to airDate,
        "genres" to genres,
        "eps" to eps,
    )

    companion object {
        fun fromJson(value: Any?): Favorite? {
            val m = Json.obj(value) ?: return null
            val id = SyncJson.intOf(m["subjectId"])
            val name = SyncJson.strOf(m["name"])
            val nameCn = SyncJson.strOf(m["nameCn"])
            // 连名字都没有的条目没法显示也没法点，直接丢掉
            if (name.isBlank() && nameCn.isBlank()) return null
            return Favorite(
                subjectId = id,
                name = name,
                nameCn = nameCn,
                cover = SyncJson.strOf(m["cover"]),
                rating = SyncJson.doubleOf(m["rating"]),
                airDate = SyncJson.strOf(m["airDate"]),
                genres = SyncJson.strListOf(m["genres"]),
                eps = SyncJson.intOf(m["eps"]),
            )
        }

        fun listFromJson(value: Any?): List<Favorite> =
            Json.arr(value).mapNotNull { fromJson(it) }
    }
}

/** 观看历史条目。`/sync/history` 的 items[] 与本机记录共用这个结构。 */
data class HistoryItem(
    /** 电脑端给的稳定 id；本机记录的 id 由 [localId] 生成。 */
    val id: String,
    val subjectId: Int,
    val title: String,
    /** 第几集（电脑端的语义是集号，通常从 1 开始） */
    val episode: Int,
    /** 播放到的位置（毫秒） */
    val position: Long,
    /** 总时长（毫秒），未知时 0 */
    val duration: Long,
    /** 观看时间（毫秒时间戳） */
    val watchedAt: Long,
) {
    fun toJson(): Map<String, Any?> = linkedMapOf(
        "id" to id,
        "subjectId" to subjectId,
        "title" to title,
        "episode" to episode,
        "position" to position,
        "duration" to duration,
        "watchedAt" to watchedAt,
    )

    companion object {
        /** 本机记录的 id：稳定且可读（同一集反复看会覆盖而不是堆积）。 */
        fun localId(subjectId: Int, title: String, episode: Int): String =
            if (subjectId > 0) "local:$subjectId:$episode" else "local:${title.trim()}:$episode"

        fun fromJson(value: Any?): HistoryItem? {
            val m = Json.obj(value) ?: return null
            val title = SyncJson.strOf(m["title"])
            val subjectId = SyncJson.intOf(m["subjectId"])
            if (title.isBlank() && subjectId <= 0) return null
            val episode = SyncJson.intOf(m["episode"])
            val id = SyncJson.strOf(m["id"]).ifBlank { localId(subjectId, title, episode) }
            return HistoryItem(
                id = id,
                subjectId = subjectId,
                title = title,
                episode = episode,
                position = SyncJson.longOf(m["position"]),
                duration = SyncJson.longOf(m["duration"]),
                watchedAt = SyncJson.longOf(m["watchedAt"]),
            )
        }

        fun listFromJson(value: Any?): List<HistoryItem> =
            Json.arr(value).mapNotNull { fromJson(it) }
    }
}

/**
 * 同步数据的宽松取值工具。
 *
 * 为什么不直接用 Json.long/int：电脑端的字段类型不保证 —— 例如 `subjectId` 可能写成 `"123"`、
 * `eps` 可能写成 `"12"`、`id` 可能是数字也可能是字符串。同步数据宁可口径松一点，
 * 也不要因为一个字段类型不对就整条丢掉。
 */
internal object SyncJson {

    fun strOf(v: Any?): String = when (v) {
        null -> ""
        is String -> v
        is Double -> if (v == v.toLong().toDouble()) v.toLong().toString() else v.toString()
        else -> v.toString()
    }

    fun intOf(v: Any?): Int = when (v) {
        is Long -> v.toInt()
        is Int -> v
        is Double -> v.toInt()
        is Boolean -> if (v) 1 else 0
        is String -> v.trim().toIntOrNull() ?: v.trim().toDoubleOrNull()?.toInt() ?: 0
        else -> 0
    }

    fun longOf(v: Any?): Long = when (v) {
        is Long -> v
        is Int -> v.toLong()
        is Double -> v.toLong()
        is String -> v.trim().toLongOrNull() ?: v.trim().toDoubleOrNull()?.toLong() ?: 0L
        else -> 0L
    }

    fun doubleOf(v: Any?): Double = when (v) {
        is Double -> v
        is Long -> v.toDouble()
        is Int -> v.toDouble()
        is String -> v.trim().toDoubleOrNull() ?: 0.0
        else -> 0.0
    }

    /** 字符串数组；元素不是字符串时用 toString 兜底，空的丢掉。 */
    fun strListOf(v: Any?): List<String> = Json.arr(v)
        .mapNotNull { strOf(it).takeIf { s -> s.isNotBlank() } }
}
