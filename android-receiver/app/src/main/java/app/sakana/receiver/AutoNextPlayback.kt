package app.sakana.receiver

import android.content.Context

/**
 * 自动连播的"执行器"：把纯逻辑决策（[autoNextAction]）变成实际的请求。
 *
 * 为什么要单独一个类：这段代码要和"每秒刷新的心跳"共存，而它本身**不能每秒都动作** ——
 * 一集只会播完一次，重复触发就会变成"反复请求电脑"。所以这里自己记住
 * "这一集的 ended 已经处理过了"，并且额外做了两道保险：
 *   · **循环保护**：如果切过去的下一集刚开播就又 ended（地址失效 / 片长为 0），
 *     不再继续往下切，而是明确写一句原因 —— 否则用户会看到"停不下来地跳集"。
 *   · **失败不静默**：[notice] 里放的就是给用户看的原因，界面一直显示到下一集真的开播为止。
 */
internal class AutoNextPlayback(
    private val context: Context,
    private val player: PlayerController,
    private val onChanged: () -> Unit,
) {

    /** 给用户看的原因/结果（"正在让电脑准备下一集…"/"已经是最后一集"…）。 */
    var notice: String? = null
        private set

    /** 已经为哪一集触发过连播 —— 防止同一集的 ended 被心跳重复处理。 */
    private var handledIndex = Int.MIN_VALUE

    /** 上一次连播切到了哪一集（用于循环保护：切过去又立刻结束就不再切）。 */
    private var advancedFrom = Int.MIN_VALUE
    private var advancedTo = Int.MIN_VALUE

    fun onTick(snapshot: PlayerSnapshot) {
        if (snapshot.state != Proto.STATE_ENDED) {
            // 离开 ended：清掉本次连播的记号，并允许下一次触发
            handledIndex = Int.MIN_VALUE
            if (snapshot.state == Proto.STATE_PLAYING) {
                // 真的开始播下一集了，把上一次的提示收掉，免得一直挂在画面上
                notice = null
            }
            return
        }
        // 用户在设置里关掉了连播：什么都不做，也不用弹提示（那是他自己的选择）
        if (!Settings.autoNext) return
        if (handledIndex == snapshot.index) return // 这一集已经处理过
        handledIndex = snapshot.index

        val playable = player.playableFlags()
        // 循环保护：刚从这个下标切出去，又立刻 ended，就不再切了
        if (advancedTo == snapshot.index && advancedFrom != Int.MIN_VALUE) {
            notice = context.getString(R.string.auto_next_loop_guard)
            advancedFrom = Int.MIN_VALUE
            advancedTo = Int.MIN_VALUE
            onChanged()
            return
        }

        when (autoNextAction(snapshot.state, snapshot.index, playable, PlayCatalog.subjectId)) {
            AutoNextAction.NONE -> Unit

            AutoNextAction.LOCAL_NEXT -> {
                val next = nextPlayableIndex(snapshot.index, playable)
                if (next < 0 || !player.control("select", next.toLong())) {
                    notice = context.getString(R.string.auto_next_no_address)
                } else {
                    notice = context.getString(
                        R.string.auto_next_done,
                        snapshot.titles.getOrNull(next) ?: "${next + 1}",
                    )
                    advancedFrom = snapshot.index
                    advancedTo = next
                }
                onChanged()
            }

            AutoNextAction.ASK_PC -> {
                // 本地没有下一集的地址，但知道是哪个条目：让电脑解析后投回来
                val wanted = if (snapshot.index >= 0) snapshot.index + 1 else null
                notice = context.getString(R.string.auto_next_asking_pc)
                advancedFrom = snapshot.index
                advancedTo = -1 // 电脑投回来之后才知道真实下标
                SyncManager.playSubject(PlayCatalog.subjectId, wanted, PlayCatalog.sourceId) { ok, message ->
                    if (!ok) notice = message
                    onChanged()
                }
                onChanged()
            }

            AutoNextAction.STOP_LAST -> {
                notice = context.getString(R.string.auto_next_last)
                onChanged()
            }

            AutoNextAction.STOP_NO_ADDRESS -> {
                notice = context.getString(R.string.auto_next_no_address)
                onChanged()
            }
        }
    }
}
