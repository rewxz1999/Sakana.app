package app.sakana.receiver

/**
 * 播放器网关：控制接口需要的那几个播放动作。
 *
 * 为什么要这层间接：控制服务（HTTP）和界面（Activity）的生命周期不一样 ——
 * 用户去设置页时界面还在，但如果界面被销毁了，HTTP 线程不能去碰一个已经释放的 ExoPlayer。
 * 有了这层接口，Receiver 只持有"网关"，界面活着时把它自己（的 PlayerController）注册进来，
 * 界面没了就注册 null，服务端据此回一个明确错误，而不是崩在空指针上。
 */
interface PlayerGateway {

    fun play(
        url: String,
        title: String,
        headers: Map<String, String>,
        startMs: Long,
        index: Int,
        playlist: List<PlayerController.Item>,
        autoPlay: Boolean,
    )

    /** @return false 表示动作不认识或参数不合法（调用方据此回 400） */
    fun control(action: String, value: Long): Boolean

    fun snapshot(): PlayerController.Snapshot

    /** 最近一次播放错误原因；没有错误时为 null。 */
    fun lastError(): String?

    /**
     * 最近一次"人话提示"（规则模式下点了切集、已经是最后一集…）。
     * 和 [lastError] 分开：这些不是故障，只是"做不了，原因是什么"，
     * 控制接口失败时会把它拼进错误信息，让电脑端的报错能说清原因。
     */
    fun notice(): String?
}
