package app.sakana.receiver

/**
 * "一集播完之后该干什么"的决策（**纯逻辑**，可在桌面上直接断言）。
 *
 * 为什么要抽成纯函数：这件事有三个容易出错的地方，全都值得用断言钉住 ——
 *  ① **不能在播放中途触发**：只有 `ended` 才算一集放完；
 *  ② **不能死循环**：如果切过去的下一集立刻又 ended（比如地址失效、时长 0），
 *     再触发一次就变成"停不下来地反复请求电脑"；
 *  ③ **不能不吭声**：连播失败必须给一句人话（"已经是最后一集""电脑端没给地址"），
 *     否则用户看到的就是"播完突然停住，什么也没说"。
 */
internal enum class AutoNextAction {
    /** 什么都不做。 */
    NONE,

    /** 列表里下一集就有地址 —— 本地直接切，最快，不用等电脑。 */
    LOCAL_NEXT,

    /** 本地没有地址，但知道是哪个条目 —— 让电脑端解析下一集并投回来。 */
    ASK_PC,

    /** 已经是最后一集，没有下一集了。 */
    STOP_LAST,

    /** 有下一集，但电脑端没给地址、也没有条目 id，接收端无能为力。 */
    STOP_NO_ADDRESS,
}

/**
 * @param state 协议里的播放状态（只有 `ended` 会触发连播）
 * @param index 当前集下标（-1 = 不知道）
 * @param playable 每集有没有可播地址（空列表 = 电脑端没给 playlist）
 * @param subjectId 当前条目 id（0 = 电脑端没给）
 */
internal fun autoNextAction(
    state: String,
    index: Int,
    playable: List<Boolean>,
    subjectId: Int,
): AutoNextAction {
    if (state != Proto.STATE_ENDED) return AutoNextAction.NONE
    if (index < 0 || playable.isEmpty()) {
        // 连自己在第几集都不知道：能问电脑就问，问不了就如实说
        return if (subjectId > 0) AutoNextAction.ASK_PC else AutoNextAction.STOP_NO_ADDRESS
    }

    // 往后找第一个"有地址"的集：中间的占位集（规则模式下只有标题）跳过
    for (i in index + 1 until playable.size) {
        if (playable[i]) return AutoNextAction.LOCAL_NEXT
    }
    // 本地没有可播的下一集了：如果知道条目 id，让电脑去解析下一集
    if (index + 1 < playable.size || subjectId > 0) {
        return if (subjectId > 0) AutoNextAction.ASK_PC else AutoNextAction.STOP_NO_ADDRESS
    }
    return AutoNextAction.STOP_LAST
}

/** 连播时"下一集"的下标（本地可播的那一集；没有就返回 -1）。 */
internal fun nextPlayableIndex(index: Int, playable: List<Boolean>): Int {
    for (i in index + 1 until playable.size) if (playable[i]) return i
    return -1
}
