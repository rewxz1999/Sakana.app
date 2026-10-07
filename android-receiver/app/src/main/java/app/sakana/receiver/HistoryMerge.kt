package app.sakana.receiver

/**
 * 观看历史的**合并去重**。单独一个文件是因为这块逻辑要被单测钉住 ——
 * 合并错了的表现很恶心：要么手机上看过的记录被电脑的旧记录覆盖，
 * 要么每次同步都把同一条反复推给电脑，把电脑端的历史刷成一片重复。
 */
object HistoryMerge {

    /** 历史上限：太多了既没用又占 SharedPreferences，留最近 500 条足够。 */
    const val MAX_ITEMS = 500

    /**
     * 去重键：**同一部番的同一集**才算同一条。
     *
     * 优先用 `subjectId + episode`（电脑端给的 id 稳定）；没有 subjectId 时退化成
     * "标题 + 集号"，标题统一 trim + 小写，避免大小写/空格差异把同一条拆成两条。
     */
    fun keyOf(item: HistoryItem): String = if (item.subjectId > 0) {
        "s:${item.subjectId}:e:${item.episode}"
    } else {
        "t:${item.title.trim().lowercase()}:e:${item.episode}"
    }

    /**
     * 合并两份历史：
     *  · 同一条（同 key）保留**看得更晚**的那份；
     *  · `watchedAt` 一样时保留播放位置更靠后的（说明看得更多）；
     *  · 结果按 watchedAt 倒序（最近看的在最前），最多 [MAX_ITEMS] 条。
     */
    fun merge(local: List<HistoryItem>, remote: List<HistoryItem>): List<HistoryItem> {
        val byKey = LinkedHashMap<String, HistoryItem>()
        for (item in local + remote) {
            val key = keyOf(item)
            val exists = byKey[key]
            byKey[key] = if (exists == null) item else pickNewer(exists, item)
        }
        return byKey.values
            .sortedByDescending { it.watchedAt }
            .take(MAX_ITEMS)
    }

    private fun pickNewer(a: HistoryItem, b: HistoryItem): HistoryItem = when {
        a.watchedAt != b.watchedAt -> if (a.watchedAt > b.watchedAt) a else b
        // 时间戳相同（同一秒内两边都写了）时，用位置更靠后的那份，别把进度往回退
        else -> if (a.position >= b.position) a else b
    }

    /** 只看本条本地记录要不要合并进去（本地记录观看时用）。 */
    fun upsert(list: List<HistoryItem>, item: HistoryItem): List<HistoryItem> = merge(list, listOf(item))

    /**
     * 列表的"指纹"。用它判断"本地历史有没有变化、需不需要推给电脑"——
     * 每次同步都全量 POST 一遍会让电脑端做无谓的写盘，也没必要。
     * 取条数 + 最新时间 + 位置总和，足够灵敏又便宜。
     */
    fun signatureOf(list: List<HistoryItem>): String {
        if (list.isEmpty()) return "0"
        val latest = list.maxOf { it.watchedAt }
        val sum = list.sumOf { it.position }
        return "${list.size}:$latest:$sum"
    }
}
