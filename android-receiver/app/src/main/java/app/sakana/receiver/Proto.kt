package app.sakana.receiver

/**
 * 与电脑端约定的协议常量。
 *
 * ⚠️ 这个文件里的每个值都是**协议的一部分**，改动必须和电脑端
 * （`src/main/services/cast.ts`）同时改，否则会出现"能发现但控制不了"这种很难查的现象。
 *
 * 对齐说明（2026-10 读完 PC 端实现后确认）：
 *  · 发现报文：PC 向广播地址的 52888 发 `{"sakana":"discover","v":1,"host":"<PC的局域网IP>"}`；
 *    接收端**单播**回
 *    `{"sakana":"receiver","v":1,"host":"<接收端IP>","name":...,"port":...,"caps":[...]}`。
 *  · **应答里必须有 `host`**：PC 的 UDP 回调**不使用报文来源地址**（`rinfo.address`），
 *    它只读报文里的 `host` 字段，取不到就直接 `return` 把设备丢掉。所以 `host` 是
 *    "接收端告诉电脑该连哪个地址"，漏了就等于电脑永远发现不到本机。
 *  · 控制接口的**失败必须用非 2xx 状态码**：PC 的 `sakanaPost` 只看
 *    `status >= 200 && status < 300`，完全不解析响应体。所以"200 + {"ok":false}"
 *    在 PC 看来仍然是"投屏成功"。见 ControlServer.Reply。
 */
object Proto {

    /** UDP 发现端口：电脑往这个端口发广播，接收端也在这个端口上收。 */
    const val DISCOVER_PORT = 52888

    /** 控制接口默认端口。被占用时依次 +1 顺延，真实端口会告诉电脑端（见 ControlServer.start）。 */
    const val DEFAULT_CONTROL_PORT = 52889

    /** 端口顺延的最大次数。100 次足够绕开任何正常的端口占用。 */
    const val MAX_PORT_TRIES = 100

    /** 发现报文的协议版本。 */
    const val VERSION = 1

    /** /ping 响应里的应用标识。 */
    const val APP_ID = "sakana-receiver"

    // ---- 发现报文的字段名/取值：两边共用的字面量集中在这里，避免手写错 ----
    const val KEY_SAKANA = "sakana"
    const val KEY_HOST = "host"
    const val KEY_PORT = "port"
    const val KEY_NAME = "name"
    const val KEY_CAPS = "caps"
    const val KEY_VERSION = "v"
    const val VAL_DISCOVER = "discover"
    const val VAL_RECEIVER = "receiver"

    /**
     * 主动宣告的间隔（毫秒）。
     * 5 秒是权衡：太短会让设备一直发包、耗电且没必要；太长的话"接收端先开着、电脑后打开"
     * 时用户要在投屏菜单里干等。电脑端的设备表 TTL 是 60 秒，5 秒一次足够稳。
     */
    const val ANNOUNCE_INTERVAL_MS = 5000L

    /**
     * 本接收端的能力列表，电脑端据此决定界面里哪些按钮可用。
     *  · hls      —— 支持 m3u8（Media3 的 HLS 模块）
     *  · mp4      —— 支持 mp4 直链（渐进式播放）
     *  · seek     —— 支持按毫秒定位
     *  · volume   —— 支持远端调音量
     *  · playlist —— 支持整个播放列表 + 选集/上一集/下一集
     *  · headers  —— 支持自定义请求头（Referer / Cookie / UserAgent），
     *                设备直连 CDN 拉流，不经过电脑中转
     */
    val CAPS = listOf("hls", "mp4", "seek", "volume", "playlist", "headers")

    // ---- /info 里 state 字段的取值（协议枚举，不能自造） ----
    const val STATE_IDLE = "idle"
    const val STATE_PLAYING = "playing"
    const val STATE_PAUSED = "paused"
    const val STATE_BUFFERING = "buffering"
    const val STATE_ENDED = "ended"
}
