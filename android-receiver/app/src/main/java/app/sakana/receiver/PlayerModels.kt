package app.sakana.receiver

/**
 * 播放层对外暴露的两个数据模型。
 *
 * 为什么从 `PlayerController` 里搬出来（v1.2 换 GSY 时做的）：
 * 这两个类型被 `/info` 的响应、观看历史（`WatchRecorder`）、自动连播（`AutoNextPlayback`）、
 * 首页与设置页的状态显示一起用着，而 `PlayerController` 的职责是"驱动 GSY"。
 * 混在一起会让那个文件长期贴着本工程的 300 行上限（硬规矩，README §4 写着）。
 *
 * 为什么叫 `PlayerItem` / `PlayerSnapshot` 而不是 `Item` / `Snapshot`：
 * 顶层声明的名字会进入整个 `app.sakana.receiver` 包，`Item` 这种名字迟早和
 * 别的语义（收藏条目、历史条目、列表 item）撞车，而那种撞车是编译期看不出来的。
 */

/**
 * 播放列表里的一集。
 *
 * ⚠️ `url` 可能是**空串**（规则模式下电脑端只有标题）：要保留（选集列表要显示标题，
 * 并把当前集高亮），但**绝不能**拿空地址去请求 —— 判定与防护在 `PlaylistNav` / `PlayerController`。
 */
data class PlayerItem(val url: String, val title: String)

/** `/info` 需要的快照。一次性抓出来，避免调用方反复访问 GSY 的视图。 */
data class PlayerSnapshot(
    val playing: Boolean,
    val positionMs: Long,
    val durationMs: Long,
    val volume: Int,
    val muted: Boolean,
    val index: Int,
    val titles: List<String>,
    val state: String,
    val title: String?,
    val canStepPrev: Boolean,
    val canStepNext: Boolean,
)
