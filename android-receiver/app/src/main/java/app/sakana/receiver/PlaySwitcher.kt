package app.sakana.receiver

import android.app.Activity

/**
 * 「剧集 / 数据源」的选择与切换：弹面板 + 把选择送到正确的地方。
 *
 * 为什么从 MainActivity 拆出来：这几段逻辑（线路列表、本地切集、请电脑切集）
 * 本身就有一整套判断，堆在 Activity 里会让"接线与刷新"那部分被淹没，
 * 也把那个文件顶过 300 行。
 *
 * 核心的一条规矩：**接收端不抓流**。所以
 *  · 本地 `playlist[i].url` 有地址 → 本地直接切（最快，不用等电脑）；
 *  · 没有地址（规则模式电脑只给了标题）→ 只能请电脑解析：`/sync/command` 的 `play-subject`；
 *  · 换线路 → 一定得让电脑换（接收端连源站地址都不知道）。
 */
internal class PlaySwitcher(
    private val activity: Activity,
    private val player: PlayerController,
    private val onToast: (String) -> Unit,
    private val onNotice: (String) -> Unit,
    private val onChanged: () -> Unit,
) {

    /** 打开面板；[beforeOpen] 用来"保活"控制栏（否则面板还开着控制栏就淡出了）。 */
    fun showPicker(beforeOpen: () -> Unit) {
        val snapshot = player.snapshot()
        if (snapshot.titles.isEmpty()) {
            onToast(activity.getString(R.string.toast_no_playlist))
            return
        }
        beforeOpen()
        showPlayPickerDialog(
            activity = activity,
            titles = snapshot.titles,
            currentIndex = snapshot.index,
            playable = player.playableFlags(),
            sources = PlayCatalog.sources,
            currentSourceId = PlayCatalog.sourceId,
            onEpisode = { which -> switchEpisode(which, snapshot.titles) },
            onSource = { source -> switchSource(source) },
        )
    }

    /** 切集：本地有地址就本地切，否则请电脑切。两条路都会给出反馈。 */
    private fun switchEpisode(index: Int, titles: List<String>) {
        if (player.control("select", index.toLong())) {
            onNotice(activity.getString(R.string.picker_episode_local, titles.getOrNull(index) ?: "${index + 1}"))
            onChanged()
            return
        }
        // 本地切不动：规则模式下这一集没有地址，只能让电脑重新解析投回来
        if (PlayCatalog.subjectId <= 0) {
            onToast(player.notice() ?: activity.getString(R.string.picker_no_episode_id))
            return
        }
        askPc(index, PlayCatalog.sourceId, activity.getString(R.string.picker_episode_switching))
    }

    /** 换线路：交给电脑 —— 接收端不抓流，换线路只能由电脑重新解析。 */
    private fun switchSource(source: PlaySource) {
        if (PlayCatalog.subjectId <= 0) {
            onToast(activity.getString(R.string.picker_no_episode_id))
            return
        }
        val episode = player.snapshot().index.takeIf { it >= 0 }
        askPc(episode, source.id, activity.getString(R.string.picker_source_switching, source.name))
    }

    /** 请电脑解析指定线路/集数并投回来（结果会在 `/play` 送到时自动接上）。 */
    private fun askPc(episodeIndex: Int?, sourceId: String?, message: String) {
        onToast(message)
        SyncManager.playSubject(PlayCatalog.subjectId, episodeIndex, sourceId) { _, reply ->
            onToast(reply)
            onChanged()
        }
        onChanged()
    }
}
