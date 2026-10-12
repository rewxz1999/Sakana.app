package app.sakana.receiver

/**
 * 一条**可选数据源/线路**（电脑端解析出来的"线路 1 / 线路 2 / 备用源"）。
 *
 * 为什么接收端不自己去猜线路：接收端不引规则引擎、也不抓流（这是刻意的取舍，
 * 见 README 的"设计选择"）。电脑端把候选线路连同 `/play` 一起发过来，
 * 接收端只负责"列出来 + 把选择结果发回去"，解析与取流的权威始终在电脑端。
 */
internal data class PlaySource(val id: String, val name: String)

/**
 * 当前这次投屏的"上下文"：属于哪个条目、有哪些线路、现在用的是哪条。
 *
 * 为什么单独一个单例、而不是塞进 PlayerController：这几项是**控制接口带来的数据**，
 * 和播放器实例的生命周期无关 —— 界面被销毁重建时它们照样有效；
 * 而 PlayerController 已经贴着 300 行上限，塞进去就要把它拆散。
 * 写入只在 HTTP 线程（`ControlApi.play`），读取在界面线程；字段都是 @Volatile。
 */
internal object PlayCatalog {

    /** 当前投屏对应的条目 id（电脑端在 `/play` 里给）。0 = 没给。 */
    @Volatile
    var subjectId: Int = 0
        private set

    /** 电脑端给的全部可选线路；空 = 电脑端没给这个字段（老版本电脑端）。 */
    @Volatile
    var sources: List<PlaySource> = emptyList()
        private set

    /** 当前正在用的线路 id；null = 电脑端没给。 */
    @Volatile
    var sourceId: String? = null
        private set

    fun update(subjectId: Int, sources: List<PlaySource>, sourceId: String?) {
        this.subjectId = subjectId.coerceAtLeast(0)
        this.sources = sources
        this.sourceId = sourceId?.takeIf { it.isNotBlank() }
    }

    /** 当前线路的显示名（拿不到就返回 null，界面据此决定要不要画这一行）。 */
    fun currentSourceName(): String? =
        sources.firstOrNull { it.id == sourceId }?.name

    /** 有没有"可切换"的线路（只有一条时没必要给用户选）。 */
    val hasSourceChoice: Boolean get() = sources.size > 1

    /**
     * 解析 `/play` 里的 `sources` 字段（纯函数，可在桌面上直接断言）。
     *
     * 宽松约定（和收藏/历史一样做人话容错）：每一项至少要有 `id` 或 `name` 之一；
     * `id` 缺失时用 `name` 当 id —— 电脑端只要给个能区分的东西就行，
     * 接收端回传时原样带回去，语义由电脑端自己解释。
     */
    fun parseSources(node: Any?): List<PlaySource> {
        val out = ArrayList<PlaySource>(4)
        val seen = HashSet<String>()
        for (entry in Json.arr(node)) {
            val m = Json.obj(entry) ?: continue
            val name = Json.str(m, "name") ?: ""
            val id = Json.str(m, "id")?.takeIf { it.isNotBlank() }
                ?: name.takeIf { it.isNotBlank() }
                ?: continue
            if (!seen.add(id)) continue
            out.add(PlaySource(id, name.ifBlank { id }))
        }
        return out
    }
}
