package app.sakana.receiver

import android.os.SystemClock

/** 播放中的观看进度最多每 15 秒写一次本地历史，没必要每秒写盘。 */
private const val RECORD_INTERVAL_MS = 15_000L

/** play-subject 之后等 `/play` 回来的有效窗口；超过就当这次指令没下文了。 */
private const val PENDING_SUBJECT_TTL_MS = 120_000L

/**
 * 本地观看历史记录器。
 *
 * 单独成类的原因：这块状态（"这一集记过了没"、"刚点播的是哪一部"）和同步的网络逻辑
 * 完全是两回事，放在 SyncManager 里会让那边又长又难读。
 *
 * 记录时机（在主界面的 1 秒心跳里调用，内部自己限流）：
 *  · 正在看、且距上次记录超过 15 秒 —— 定期存进度，中途被杀也不会丢太多；
 *  · 从"在播"变成"不在播"（暂停/停止）—— 立刻存一次最终位置；
 *  · 播完 —— 存一次。
 */
internal object WatchRecorder {

    private var lastRecordAt = 0L
    private var lastPlaybackState: String? = null

    /**
     * 用户刚点了"播这一部"时记下 subjectId。
     * 电脑随后投过来的 `/play` 里**没有** subjectId，靠这个把这次播放认到具体条目上，
     * 否则历史里只能存一个标题，合并去重时也认不出是同一部。
     */
    @Volatile
    private var pendingSubjectId: Int = 0
    private var pendingSubjectAt = 0L

    fun markPendingSubject(subjectId: Int) {
        pendingSubjectId = subjectId
        pendingSubjectAt = SystemClock.elapsedRealtime()
    }

    /** 取出待认领的 subjectId；过期或没有时返回 0。 */
    fun consumePendingSubjectId(): Int {
        val id = pendingSubjectId
        if (id <= 0) return 0
        if (SystemClock.elapsedRealtime() - pendingSubjectAt > PENDING_SUBJECT_TTL_MS) {
            pendingSubjectId = 0
            return 0
        }
        return id
    }

    /** 把当前播放状态记进本地历史（限流，见类注释）。 */
    fun notePlayback(snapshot: PlayerController.Snapshot) {
        if (!SyncStore.isReady) return
        val state = snapshot.state
        val active = state == Proto.STATE_PLAYING || state == Proto.STATE_BUFFERING ||
            state == Proto.STATE_PAUSED
        val wasActive = lastPlaybackState == Proto.STATE_PLAYING ||
            lastPlaybackState == Proto.STATE_BUFFERING ||
            lastPlaybackState == Proto.STATE_PAUSED
        val now = SystemClock.elapsedRealtime()
        val due = now - lastRecordAt >= RECORD_INTERVAL_MS
        // 三条记录时机：正在看且到点了 / 从"在播"变成"不播了" / 播完
        val leaving = wasActive && !active
        if (!(active && due) && !leaving && state != Proto.STATE_ENDED) {
            lastPlaybackState = state
            return
        }
        lastPlaybackState = state

        val title = snapshot.title?.takeIf { it.isNotBlank() }
            ?: snapshot.titles.getOrNull(snapshot.index)?.takeIf { it.isNotBlank() }
            ?: return
        val subjectId = resolveSubjectId(title)
        val episode = if (snapshot.index >= 0) snapshot.index + 1 else 0
        lastRecordAt = now
        SyncStore.recordWatch(
            HistoryItem(
                id = HistoryItem.localId(subjectId, title, episode),
                subjectId = subjectId,
                title = title,
                episode = episode,
                position = snapshot.positionMs,
                duration = snapshot.durationMs,
                watchedAt = System.currentTimeMillis(),
            ),
        )
    }

    /**
     * 尽量把这次播放对应到某个收藏条目上（历史条目需要 subjectId）。
     * 优先用"刚点过 play-subject 的那个 id"，其次按标题在缓存的收藏里找同名的。
     * 都找不到就返回 0 —— 记录照样会写（只有标题），合并时按标题+集号去重。
     */
    private fun resolveSubjectId(title: String): Int {
        val pending = consumePendingSubjectId()
        if (pending > 0) return pending
        val key = title.trim().lowercase()
        if (key.isEmpty()) return 0
        return SyncStore.favorites.firstOrNull {
            it.displayName.trim().lowercase() == key ||
                it.name.trim().lowercase() == key ||
                (key.length >= 2 && it.displayName.contains(title.trim()))
        }?.subjectId ?: 0
    }
}
