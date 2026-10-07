# Sakana 投屏接收端（Android）

一个**极简**的安卓「投屏接收端」：电脑端 Sakana 播放器把视频投到同一局域网的安卓设备
（手机 / 平板 / 电视盒子）上播放，并且可以被电脑遥控（选集、暂停、音量）。

设计目标是**小、直白、可控**：

- 依赖只有 **Media3（ExoPlayer）三个模块** + RecyclerView（后者本来就被 media3-ui 带进来，不增加体积）；HTTP 服务、JSON、UDP 发现、同步客户端、封面加载全是手写的（不引 OkHttp / Retrofit / Gson / Glide）。
- 界面只有 **普通 View + XML**，不用 Compose、不用 AppCompat、不用 ConstraintLayout；图标是自己画的矢量图。
- 权限只有 4 条网络权限 + `RECEIVE_BOOT_COMPLETED`（开机自启开关用），读不到你的存储、也不碰定位。
- **设备直接连 CDN 拉流**（把 Referer / Cookie 交给 ExoPlayer 作为默认请求头），
  视频流量不经过电脑中转 —— 这是"投屏后依然流畅"的前提。

## 这个 App 从哪来 / 怎么装

**它不是应用商店里的应用**，而是电脑端 Sakana 播放器的**配套接收端**，随仓库一起分发：

- **源码位置**：本仓库的 `android-receiver/` 目录（就是你现在看的这个目录）。
- **直接下载安装**：`dist/SakanaReceiver-0.3.8-debug.apk` —— 这就是电脑端设置页里那个
  「下载安卓接收端 APK」按钮指向的文件，拷到安卓设备上点开安装即可（需允许"安装未知应用"）。
  它是 **debug 签名**（自用没问题）；要正式分发请用你自己的 keystore 重新签 `assembleRelease` 的产物。
- **自己构建**：见下面第 1 节，产物是 `app/build/outputs/apk/debug/app-debug.apk`。

功能一览：

- **自动发现**：UDP 广播 + 应答（电脑一打开投屏面板就能看到本机）。
- **主动连电脑**：设置里填电脑 IP，接收端每 5 秒直接向它宣告 —— USB 网络共享 / 跨网段 / AP 隔离时的兜底。
- **首选网络接口**：Wi-Fi / USB 共享 / 有线 各自列出，用户指定"该在哪块网卡上广播、把哪个地址报给电脑"。
- **遥控**：电脑端可暂停/继续/停止/定位/调音量/静音；设备上也有上一集/下一集/选集/音量。
- **双端同步**：收藏与观看历史缓存到本机（断网也能看），连上电脑后自动双向同步；
  观看历史会在本机记录并推给电脑。
- **点收藏直接播**：收藏里点一部 → 电脑自己"选源 → 选集 → 嗅探直链 → 投回本机"。
- **播放时横屏全屏**：进播放自动转横屏 + 隐藏系统栏，控制栏浮在画面上、几秒自动淡出。
- **设置页**：设备名、控制端口、首选网卡、主动连接、屏幕常亮、自动播放、开机自启、同步状态、下载说明、关于。
- **状态可见**：缓冲中 / 播放中 / 已暂停 / 播完 / 播放失败（带原因），以及"已被谁连接"。

体积（本机实测）：debug **5.74 MB**，release（R8 + 资源压缩）**1.11 MB**。

---

## 1. 构建

### 1.1 环境要求

| 项目 | 要求 | 本机实测值 |
| --- | --- | --- |
| JDK | 17 或更高 | `E:\environment\jdk-21.0.2` |
| Android SDK | 需要 `platforms/android-36`（Media3 1.11 的 AAR 要求 compileSdk ≥ 36）、`build-tools` | `E:\environment\Android SDK` |
| Gradle | 由 Wrapper 提供（8.14.3），**不需要**本机装 Gradle | `gradle/wrapper/` |
| AGP / Kotlin | 8.13.0 / 2.2.20（写在 `build.gradle` 里） | — |

`local.properties` 里写了本机的 `sdk.dir`。它**不入库**（见 `.gitignore`），换机器时
Android Studio 会自动重写，手动构建时改成你自己的路径即可（用正斜杠可以免去反斜杠转义）。

### 1.2 用 Android Studio 打开

**直接 Open `android-receiver` 这个目录**，不要 Open 仓库根目录（根目录那套是 Electron/Node 的构建，
和本工程无关）。本工程是独立 Gradle 工程，不 include 仓库里任何其它模块。

### 1.3 命令行构建

```powershell
cd E:\sakana.app\android-receiver
$env:JAVA_HOME='E:\environment\jdk-21.0.2'
$env:ANDROID_HOME='E:\environment\Android SDK'
.\gradlew.bat assembleDebug          # 产物：app\build\outputs\apk\debug\app-debug.apk
.\gradlew.bat assembleRelease        # 产物：app\build\outputs\apk\release\app-release-unsigned.apk
```

release 包**未签名**（本工程没有配置 release 签名，这是有意的：签名密钥不应该进仓库）。
要装到设备上，用 debug 包，或者自己加一个 signingConfig。

### 1.4 如果构建环境有限制（本机沙箱/CI 的情况）

本机验证时遇到过两个"环境问题"，都不是代码问题，记录在这里备查。
**正常机器（`%USERPROFILE%\.gradle` 可写、有网络、Kotlin 守护进程能起来）完全不需要这一节。**

**问题 1：`C:\Users\<用户名>\.gradle` 不可写**（Gradle 建不了锁文件、依赖缓存也写不进去）。
做法是把 Gradle 家目录挪进工程内，并把已有的依赖缓存以**只读**方式挂上：

```powershell
$ws = 'E:\sakana.app\android-receiver'
New-Item -ItemType Directory -Force -Path "$ws\.gradle-home\wrapper\dists\gradle-8.14.3-bin" | Out-Null
Copy-Item "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.14.3-bin\*" `
          "$ws\.gradle-home\wrapper\dists\gradle-8.14.3-bin\" -Recurse -Force

$env:GRADLE_USER_HOME    = "$ws\.gradle-home"          # 可写，放在工程内
$env:GRADLE_RO_DEP_CACHE = "$env:USERPROFILE\.gradle\caches"   # 只读复用已有依赖缓存
```

**问题 2：用户名含非 ASCII 字符 + `%LOCALAPPDATA%` 不可写**。
Kotlin 编译守护进程建不了自己的目录时会**退化成"进程内编译"**，而这条退路会把传给编译器的
classpath 里的中文路径转义错 —— `RE妄想症` 变成 `REu5984u60F3u75C7`，于是报一屏
`error: cannot access built-in declaration 'kotlin.String'. Ensure that you have a dependency
on the Kotlin standard library.`（看起来像缺 stdlib，实际上 stdlib 好好的）。
把 `LOCALAPPDATA` 指到工程内可写目录、让守护进程能起来即可：

```powershell
New-Item -ItemType Directory -Force -Path "$ws\.localappdata" | Out-Null
$env:LOCALAPPDATA = "$ws\.localappdata"
```

**问题 3（Android 签名相关）：`~/.android` 不可写**时 `validateSigningDebug` 会报
`AccessDeniedException: ...\debug.keystore.lock`。把 Android 用户目录也指到工程内：

```powershell
New-Item -ItemType Directory -Force -Path "$ws\.android-home" | Out-Null
$env:ANDROID_USER_HOME = "$ws\.android-home"
```

这三个目录（`.gradle-home/` `.localappdata/` `.android-home/`）都已在 `.gitignore` 里，
是纯本地环境产物，**可以随时删掉**（本次交付时已删除，所以要复现得先按上面重建）。

---

## 2. 使用

### 2.1 最省事的路径（同一个 Wi-Fi）

1. 在安卓设备上装 `app-debug.apk`，打开 App。
2. 电脑端 Sakana：打开投屏菜单 → 本设备会出现在列表里（自动发现）。
3. 点投屏，开始播放。设备上的控制栏和电脑端都能遥控。

### 2.2 自动发现不通时（USB 网络共享 / 跨网段 / AP 隔离）

三条兜底路径，任选其一即可：
- **接收端主动连电脑**（推荐，最省事）：设备上点「设置」→ 在「主动连接电脑」里填**电脑的局域网 IP**
  （例如 `192.168.1.20`）→ 点「连接电脑」。之后接收端每 5 秒直接向那个地址发一次宣告，
  电脑端的投屏列表里就会出现本设备。填过的地址会进"最近用过"，下次点一下即可。
- **在电脑上手填手机地址**：设备主界面顶部显示的就是"电脑该连的地址"（例如 `192.168.42.129:52889`），
  **点一下即复制**，粘到电脑端的"手动连接"框里。
- **先确认网卡选对了**：设置 →「首选网络接口」，选**电脑能到达**的那一块
  （USB 共享通常是 `rndis0` 或 `192.168.42.x`）。选完"关于"里的「当前广播地址」会跟着变，
  主界面顶部的地址也会变 —— 这两处显示的就是要填给电脑的地址。

界面出现红色/橙色提示时说明检测到 USB 共享或有线网卡，此时广播常常出不了本网段，
用上面第一条或第二条即可。

### 2.3 主界面

界面分**两个形态**，靠可见性切换（不是两个 Activity —— 换 Activity 会重建播放器、画面会断）：

**① 首页**（空闲时）

- 顶部状态卡：应用名 + 设备名、大字状态（等待投屏 / 正在播放：X / 已暂停 / 缓冲中 / 播完 / 播放失败）、
  副状态（请让电脑搜索本设备 / 电脑 192.168.1.20 正在搜索 / 已被 192.168.1.20 连接 / 失败原因 /
  USB 共享网络提示）、本机地址（**点击复制**，只显示不输入），以及**同步状态行**。
- 收藏：两列网格（封面 + 名字 + 评分/集数），点一下让电脑播，长按看详情。
- 观看历史：横向列表，点一下从那一集接着播。
- 底部：「立即同步」「设置」。
- 两个列表都有**空态文案**（"还没有从电脑同步收藏，连上电脑后会自动同步"之类），不会留白屏。

**② 播放层**（有媒体时）

- 播放器铺满整个窗口，自动切**横屏全屏**并隐藏系统栏；
- 控制栏浮在画面上（半透明）：进度条 + 上一集 / 播放暂停 / 下一集 / 音量− / 音量+ / 选集 / 设置，
  右上角一个「退出全屏」；
- **点一下画面**显示/隐藏控制栏；播放中 4 秒无操作自动淡出，暂停时保持常显；拖动进度时不会消失；
- **返回键先退出全屏**（回到竖屏、恢复系统栏），再按一次才走系统默认行为；
- 退出播放（停止、或回到 idle）时恢复 `SCREEN_ORIENTATION_UNSPECIFIED` 和系统栏。

### 2.4 设置页

| 项 | 说明 |
| --- | --- |
| 设备名 | 电脑端发现列表里显示的名字，默认设备型号；改完最多 5 秒（下一次广播）电脑端可见 |
| 控制端口 | 默认 52889，改动后服务立即重启；被占用会自动顺延，真实端口见「关于」 |
| 首选网络接口 | Wi-Fi / USB 共享 / 有线 各自列出，指定"在哪块网卡上广播、把哪个地址报给电脑" |
| 主动连接电脑 | 填电脑 IP 后每 5 秒向它单播宣告（见 2.2） |
| 保持屏幕常亮 | 默认开；黑屏会连带 Wi-Fi 省电，发现与控制都可能不稳 |
| 收到投屏后自动播放 | 默认开；关掉时只加载不播放，等电脑端按播放 |
| 开机后尝试自动打开接收端 | 默认关；见下方"已知限制"里关于 Android 10+ 的说明 |
| 同步状态 | 已连上哪台电脑、上次同步时间、同步地址、收藏/历史各多少条 + **立即同步**按钮 |
| 下载 / 构建 | 说明本 App 从哪来、怎么构建（见开头"这个 App 从哪来"一节），供电脑端设置页里的"下载地址"指向 |
| 关于 | 版本、协议版本、当前监听端口（含顺延说明）、当前网卡、当前广播地址、已响应请求数、服务状态；并写明**蓝牙暂未支持** |

### 2.5 收藏、历史与同步怎么用

1. **连上电脑**（任一路径，都是自动的）：投屏一次 / 让电脑搜索本设备 / 在设置里「主动连接电脑」。
   一旦连上，接收端会在后台把**收藏**和**观看历史**拉下来并缓存在本机。
2. **点收藏里的一部** → 界面顶部显示「电脑正在解析播放源…」→ 电脑完成选源/选集/嗅探后把流投过来 →
   **本机自动进入横屏全屏播放**。
   - 失败时会把电脑返回的原因原样弹出来（例如"这条番剧在已启用的规则里都搜不到"）；
   - 条目没有 `subjectId`（电脑端没给）时，点它会明确提示"请回到电脑上点播"，而不是装作能播。
   - 长按条目看详情（原名/评分/集数/放送日期/类型/条目 id）。
3. **观看历史**：每次通过投屏播放都会记在本机（最多每 15 秒写一次进度，暂停/停止时补一次最终位置），
   下次同步时推给电脑合并。点历史里的一条可以从那一集接着播（前提是能认出 `subjectId`）。
4. **断网也能看**：收藏与历史都在本机（`SharedPreferences`），冷启动先显示缓存再后台刷新。
5. **手动同步**：首页底部或设置页里的「立即同步」。没连过电脑时它会明确告诉你该怎么做，
   而不是假装同步了一下。

---

## 3. 协议

> 字段名是两边约定的**契约**，不能改。接收端这边所有协议常量集中在
> `Proto.kt`，端点实现在 `ControlServer.kt` / `ControlApi.kt`。

### 3.1 局域网发现（UDP，端口 52888）

| 方向 | 报文 |
| --- | --- |
| 电脑 → 广播地址:52888 | `{"sakana":"discover","v":1,"host":"<PC的局域网IP>"}` |
| 接收端 → **单播**回发包方 | `{"sakana":"receiver","v":1,"host":"<接收端IP>","name":"<设备名>","port":<控制端口>,"caps":["hls","mp4","seek","volume","playlist","headers"]}` |
| 接收端 → 广播地址:52888，每 **5 秒**一次 | 同上一行（让"接收端先开着、电脑后打开"也能被发现） |
| 接收端 → **用户手填的电脑地址**:52888，每 **5 秒**一次 | 同上一行（`主动连接电脑`，见 2.2） |

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sakana` | string | `"discover"` 是查询，`"receiver"` 是应答 |
| `v` | int | 协议版本，当前 `1` |
| `host` | string | 电脑→接收端时是**电脑自己的 IP**（接收端只用它做"谁在搜索"的显示，回复时以报文来源地址为准）；**接收端→电脑时是本机在选定网卡上的 IP，电脑会直接拿它去连 HTTP 控制接口** |
| `name` | string | 设备型号（`Build.MODEL`）或用户在设置里改的名字 |
| `port` | int | **控制接口真实监听端口**（默认 52889，被占用时会顺延） |
| `caps` | string[] | 能力列表，见 `Proto.CAPS` |

> ⚠️ **应答里的 `host` 不能省。** 电脑端（`cast.ts` 的 UDP `message` 回调）**不使用**报文来源地址
> （`rinfo.address`），它只读报文里的 `host`，取不到就直接 `return` 把设备丢掉。
> 所以 `host` 是"接收端告诉电脑该连哪个地址"，漏了就等于电脑永远发现不到本机。

实现要点：`DiscoveryService.kt`（绑定/收发/宣告）、`Lan.kt`（列网卡、挑网卡、算广播目标）、
`WifiMulticastLock.kt`(Wi-Fi 省电时顶住广播帧)。

### 3.2 控制接口（HTTP + JSON，默认端口 52889）

端口被占用时会**自动 +1 顺延**（最多试 100 次），真实端口通过 UDP 应答和界面显示告知电脑端。
所有响应都是 `Content-Type: application/json; charset=utf-8` + `Connection: close`，
并带 `Access-Control-Allow-Origin: *` 等 CORS 头（电脑端是 Node，用不到，加上是为了方便用浏览器调试）。

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/ping` | — | `{"ok":true,"app":"sakana-receiver","v":1}` |
| `GET` | `/info` | — | 见 3.3 |
| `POST` | `/play` | 见 3.4 | 成功 `{"ok":true}`；失败 `{"ok":false,"error":"..."}` |
| `POST` | `/control` | 见 3.5 | 同上 |
| `OPTIONS` | 任意 | — | `200` + CORS 头 |

请求解析是**故意宽松**的：同时接受 CRLF 与裸 LF、`Content-Length` 与 `Transfer-Encoding: chunked`、
绝对 URL 形式的请求行（代理风格）也能取出 path，畸形的头直接忽略而不是拒掉整条请求。

> ⚠️ **失败用非 2xx 状态码，这一点不能将就。** 电脑端的 `sakanaPost` 只看
> `status >= 200 && status < 300`，**完全不解析响应体**。所以"返回 200 + `{"ok":false}`"
> 在电脑端看来仍然是"投屏成功"，而设备其实什么都没播 —— 这种"看起来成功的失败"最难排查。
> 因此：成功 → `200 {"ok":true}`；请求有问题（缺字段、`url` 为空、动作不支持…）→
> `400 {"ok":false,"error":"…"}`；服务端异常 → `500`。实现见 `ControlServer.Reply`。

### 3.3 `GET /info`

```json
{"name":"Pixel 7","playing":true,"positionMs":12345,"durationMs":1420000,
 "volume":80,"muted":false,"index":2,"total":12,
 "titles":["第 1 集","第 2 集"],"state":"playing"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 设备名 |
| `playing` | bool | 是否正在播放 |
| `positionMs` | long | 当前播放位置（毫秒） |
| `durationMs` | long | 总时长（毫秒）；未知（如直播流）时为 `0` |
| `volume` | int | 音量档位 `0-100`（与 `muted` 相互独立） |
| `muted` | bool | 是否静音 |
| `index` | int | 当前集在 `playlist` 里的下标；没有当前集时为 `-1` |
| `total` | int | `playlist` 的长度 |
| `titles` | string[] | 整个播放列表的标题；没有列表时为 `[]` |
| `state` | string | `idle` / `playing` / `paused` / `buffering` / `ended` |

`state` 映射自 ExoPlayer 的 `PlaybackState`；**播放出错时如实报 `idle`**
（出错后 ExoPlayer 自己停在 IDLE，如果继续报 `buffering`，电脑端的"缓冲中"会永远转下去）。

### 3.4 `POST /play`

```json
{"url":"https://cdn.example.com/ep3/index.m3u8",
 "title":"第 3 集",
 "headers":{"Referer":"https://example.com/","Cookie":"a=b; c=d","UserAgent":"SakanaPlayer/1.0"},
 "startMs":12345,
 "index":2,
 "playlist":[{"url":"https://cdn.example.com/ep1/index.m3u8","title":"第 1 集"},
             {"url":"https://cdn.example.com/ep2/index.m3u8","title":"第 2 集"}]}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要播的地址（HLS 的 m3u8 或 mp4 直链）。**为空直接回 400**，见下方"规则模式" |
| `title` | string | 否 | 标题，界面上显示"正在播放：<标题>" |
| `headers` | object | 否 | 逐条透传给播放请求（见下）；`{}` 也完全可以 |
| `startMs` | long | 否 | 起播位置（毫秒），默认 `0` |
| `index` | int | 否 | 当前集在 `playlist` 里的下标；不传则按 `url` 反查 |
| `playlist` | array | 否 | `[{url,title}]`；不传表示单集直投 |

**规则模式（`playlist` 里的 `url` 是空串）**：电脑端在"规则模式"下只能拿到剧集标题、
拿不到每一集的取流地址，于是 `playlist` 全是 `{"url":"","title":"第 3 集"}`，
而 `url` 字段给的是**当前这一集**的真实地址。接收端对此的处理是：

- `playlist` 里的项**照常保留**（选集列表要显示标题、并把当前集高亮）；
- 当前集会把主 `url` **补进去**，所以这一集照常能播；
- 其它项**点了也不会去请求空地址**：切集按钮（上一集/下一集）在没有可选目标时直接禁用，
  选集列表里那些项标成暗色 + "规则模式 · 请在电脑上切集"，点了弹一句同样的提示。
  电脑端换集后会重新投一次 `/play`，所以正确做法就是在电脑上切。
- 如果连主 `url` 都是空的，`/play` 直接回 **400** 而不是假装成功。

**`headers` 是"投屏后流畅"的关键**：接收端用
`DefaultHttpDataSource.Factory().setDefaultRequestProperties(map)` 把它们设成**默认请求头**，
于是 HLS 的**主列表、子列表、以及每一个分片**请求都会自动带上 `Referer` / `Cookie`。
这样设备是直连 CDN 拉流，电脑不需要做中转代理，画质和速度不受电脑上传带宽限制。
（实现见 `MediaSources.kt`；对应 `caps` 里承诺的 `headers`。）

透传时会被丢掉的请求头（都是"由连接层自己管、带上会坏事"的）：

| 丢弃的头 | 为什么 |
| --- | --- |
| `Range` | ExoPlayer 靠它做分片与 seek，客户端带了会让播放/拖动直接坏掉 |
| `Accept-Encoding` | 一旦手动设置，HttpURLConnection 就不再自动解压，而 ExoPlayer 不认 gzip 响应体，m3u8 会解析失败 |
| `Host` / `Connection` / `Content-Length` / `Transfer-Encoding` | 连接层自己决定，手设会冲突 |
| `UserAgent` / `User-Agent` | 走 `setUserAgent()` 单独设置，避免发出去的头名变成 `UserAgent:` |

另外 `UserAgent` 缺失时会用内置的浏览器 UA 兜底（不少 CDN 会拒绝空 UA）。

### 3.5 `POST /control`

```json
{"action":"seek","value":60000}
```

| `action` | `value` | 行为 |
| --- | --- | --- |
| `pause` | 忽略 | 暂停 |
| `resume` | 忽略 | 继续 |
| `toggle` | 忽略 | 正在播就暂停，否则继续 |
| `stop` | 忽略 | 停止播放并清空当前媒体（**保留列表和下标**，所以还能再 `select`/`next` 拉回来） |
| `next` | 忽略 | 下一集（到最后一集就停住，**不循环**） |
| `prev` | 忽略 | 上一集（到第一集就停住） |
| `seek` | 毫秒 | 定位；超出范围会被夹到 `[0, duration]` |
| `volume` | `0-100` | 设置音量，并**自动取消静音**（否则用户按了没反应会以为遥控坏了） |
| `mute` | `0`/`1` | 静音 / 取消静音（`1` 静音） |
| `select` | 下标 | 切到 `playlist` 的第 N 集；越界、或该项是规则模式下的空地址时回 400 |

动作名不认识、或参数不合法时，接收端**如实返回 400 + `{"ok":false,"error":"..."}`**，
并把播放器给出的"人话提示"（例如"「第 8 集」在规则模式下没有播放地址，请在电脑上切集"）
拼进错误信息，不会假装成功（否则电脑端以为切集成功了，实际上画面没变）。

> 电脑端的 `CastAction` 类型目前只有 `pause|resume|toggle|stop|seek|volume|mute`，
> 也就是说它**不会**发 `next/prev/select`；这三个主要给设备上的控制栏用，
> 接收端支持它们只是为了让协议完整。

### 3.6 双端同步（`syncUrl` 上的 /sync/* 端点）

`syncUrl` 是**电脑端随每次 `/play` 一起下发的自己的同步服务地址**（形如 `http://192.168.1.8:52890`）。
接收端把它记在内存与本地缓存里，后续同步都以它为准；**可能为空**
（用户选了"只用直连"或同步服务没起来），这时同步按钮会置灰并说明原因。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET` | `{syncUrl}/sync/ping` | — | `{"ok":true,"pc":"<电脑名>","version":"0.3.8"}` |
| `GET` | `{syncUrl}/sync/favorites` | — | `{"ok":true,"items":[{subjectId,name,nameCn,cover,rating,airDate,genres,eps}]}` |
| `GET` | `{syncUrl}/sync/history` | — | `{"ok":true,"items":[{id,subjectId,title,episode,position,duration,watchedAt}]}` |
| `POST` | `{syncUrl}/sync/history` | `{"items":[…同上…]}` | `{"ok":true,"merged":N}` |
| `POST` | `{syncUrl}/sync/command` | `{"action":"play-subject","subjectId":123,"episodeIndex":0}` | `{"ok":true,"message":"…","episodes":["第 1 集",…]}` |

**接收端这边的处理规则：**

- **收藏只读**：电脑端是权威来源，接收端只拉不写。
- **历史双向**：先 `GET` 拉回来和本地合并（同一部番同一集取"看得更晚"的那份），
  再把本地有变化的推回去（`POST`）；**有变化才推**（用"条数+最新时间+位置总和"算指纹），
  否则每次启动都全量写一遍电脑的库。
- **解析一律宽松**：`subjectId` 写成 `"456"`、`eps` 写成 `"12"`、`rating` 缺失、
  `genres` 缺失都能认；连名字都没有的脏条目才丢掉，不会因为一条坏数据让整份列表解析失败。
- **`episodeIndex` 可省略**：不给就是"从第 1 集/续播位置开始"，由电脑端决定。
- **`play-subject` 的语义**：接收端**不自己取流** —— 它只是让电脑去播这一部，
  电脑完成"选源 → 选集 → 嗅探直链 → 投屏到本机"，随后 `/play` 送上门，界面自动切进播放层。
  失败时把电脑返回的 `message` 原样显示（例如"这条番剧在已启用的规则里都搜不到"），
  而不是笼统地说"失败"。

**自动连接（不需要用户点任何按钮）**，三条路径任一走通就同步：

1. 收到 `/play`（里面有 `syncUrl`，最权威）；
2. 冷启动 / 回到前台：用上次记下的 `syncUrl` 直接试；
3. 看到电脑（它发搜索广播、或用户手填了地址）：按候选端口探测 `{ip}:52890/sync/ping`。

> 第 3 条要"猜端口"是没办法的事：还没投过屏时我们只知道电脑的 IP。
> `52890` 是电脑端同步服务与投屏中转共用的端口；一旦拿到过 `/play` 的 `syncUrl` 就永远以那个为准。

---

## 4. 代码结构

按"一件事一个类 / 一个文件"拆开，**33 个 Kotlin 文件全部 ≤300 行**（最长 294 行）：

**协议与传输**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Proto.kt` | 73 | 协议常量（端口、间隔、caps、state、报文字段名）。**改这里等于改协议** |
| `Json.kt` | 160 | 手写 JSON 的对外 API、序列化、字段取值辅助函数 |
| `JsonParser.kt` | 160 | 手写 JSON 的递归下降解析器（含局限说明） |
| `Http.kt` | 250 | 手写 HTTP **服务端**：请求读取与 JSON 响应写出（含 chunked） |
| `ControlServer.kt` | 193 | ServerSocket、端口顺延、路由分发、`Reply`（成功 200 / 失败 400） |
| `ControlApi.kt` | 182 | 把 HTTP 请求翻译成播放器调用 + 组装 `/info` JSON；负责切到主线程 |
| `PlayerGateway.kt` | 38 | 控制接口需要的播放动作（界面活着才注册，避免碰已释放的播放器） |
| `DiscoveryService.kt` | 285 | UDP 52888 的收发、广播、向手填地址主动宣告 |
| `WifiMulticastLock.kt` | 50 | MulticastLock 的薄封装（Wi-Fi 省电时不漏收广播） |
| `Lan.kt` | 201 | 列出网卡（含 Wi-Fi/USB/蓝牙/有线分类）、挑网卡、算广播目标 |

**播放**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `PlayerController.kt` | 294 | ExoPlayer 封装：播放列表、音量、规则模式的空地址防护 |
| `PlaylistNav.kt` | 36 | 播放列表切换目标的计算（跳过空地址、不循环）—— 纯逻辑，有单测 |
| `PlaybackState.kt` | 35 | 播放状态 -> 协议 `state` 枚举的映射 |
| `MediaSources.kt` | 109 | URL -> MediaSource：请求头透传、过滤，HLS/直链区分 |

**双端同步**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `SyncModels.kt` | 166 | 收藏/历史的数据模型 + 宽松 JSON 解析（类型串了也能认） |
| `HistoryMerge.kt` | 64 | 历史的合并去重与"要不要推"的指纹 —— 纯逻辑，有单测 |
| `SyncClient.kt` | 100 | 同步服务的 HTTP 客户端（`HttpURLConnection`，地址规范化） |
| `SyncStore.kt` | 147 | 收藏/历史的本地缓存与持久化、同步地址、上次同步时间 |
| `SyncManager.kt` | 261 | 同步调度：拉收藏/历史、推本地历史、play-subject 点播 |
| `SyncDiscovery.kt` | 84 | 找电脑的同步服务：候选端口探测、限流、自动重连 |
| `WatchRecorder.kt` | 107 | 本地观看历史的记录时机与限流、把播放认到某个条目上 |
| `CoverLoader.kt` | 172 | 极小的异步封面加载器（内存 + 磁盘两级缓存） |

**界面与运行时**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Settings.kt` | 131 | 用户设置（设备名/端口/网卡/主动连接/开关）的持久化 |
| `Receiver.kt` | 187 | 运行期外壳：控制服务 + 发现服务的启停、配置变更重启、连接统计 |
| `ReceiverApp.kt` | 22 | Application：初始化 Settings / 同步 / 封面缓存 |
| `MainActivity.kt` | 224 | 主界面接线、两个形态的切换、生命周期 |
| `PlaybackUi.kt` | 232 | 播放层：横屏全屏、系统栏、浮层控制栏与进度条 |
| `HeaderBinder.kt` | 100 | 顶部状态区（设备名/大字状态/副状态/地址/同步状态） |
| `HomeBinder.kt` | 83 | 收藏网格与观看历史列表、空态文案 |
| `ListAdapters.kt` | 108 | 收藏/历史两个 RecyclerView 适配器 |
| `UiHelpers.kt` | 281 | 状态文案、选集/详情/网卡弹窗、最近地址、剪贴板、时间格式化 |
| `SettingsActivity.kt` | 265 | 设置页 |
| `BootReceiver.kt` | 34 | 开机自启（见"已知限制"） |

界面资源：`activity_main.xml`（首页层 + 播放层）、`activity_settings.xml`（表单）、
`item_favorite.xml`（收藏一格）、`item_history.xml`（历史一张卡）、`item_episode.xml`、`item_recent_host.xml`、
`res/drawable/ic_*.xml` 共 11 个自己画的矢量图标、`res/color/icon_tint.xml`（禁用态自动变暗）。

### 关于手写 JSON 的局限

`Json.kt` + `JsonParser.kt` 只覆盖本协议用到的类型，**不要**拿它解析任意 JSON：

1. 一次性解析整段文本，不流式（本协议 body 只有几 KB）。
2. 整数走 `Long`，超出范围或带小数点/指数会退化为 `Double`，可能丢精度。
3. 重复键"后者覆盖前者"，不报错；不支持注释、尾随逗号、单引号、`NaN`/`Infinity`。
4. 嵌套深度上限 64；不校验 schema；解析失败统一返回 `null`。
5. 解析成功后**忽略**尾随的多余内容（故意的宽松）。

### 一些设计选择及原因

- **为什么用广播做发现**：电脑和设备的 IP 互相不知道，广播是唯一零配置（不用配对、不用填 IP）
  就能双向发现的办法。应答式和宣告式都做了，是为了让"谁先启动"不影响结果。
- **为什么还要"主动连电脑"（向手填地址单播）**：USB 网络共享、跨网段、开了 AP 隔离的 Wi-Fi
  这三种情况下，广播**根本出不了本网段**，再怎么调广播参数都没用。
  而"我知道你的 IP，直接单播给你"总是可行的 —— 这是那三种场景唯一的零配置之外的兜底，
  也是需求里"手机端支持有线链接播放"能真正跑通的关键。
- **为什么要让用户选网卡**：设备同时有 Wi-Fi(192.168.1.x) 和 USB 共享(192.168.42.x) 时，
  "电脑能到达哪一块"取决于用户在电脑上插了什么线，**代码判断不出来**。
  选错的表现是"界面显示 192.168.1.23，电脑却怎么都连不上"，所以把选择权交给用户，
  并把每块网卡的类型标出来。
- **为什么端口被占用要顺延而不是报错**：直接失败对用户来说就是"投屏成功但完全控制不了"，
  没有任何可操作的提示。顺延后真实端口通过 UDP 应答 + 界面显示两个渠道告诉电脑端，所以电脑端永远不用猜。
- **为什么 UDP 应答必须单播**：广播回复在各平台上都不可靠（客户端还得额外绑端口），
  而 UDP 报文的源地址里就带着电脑的地址和端口。
- **为什么同时往 `255.255.255.255` 和各接口定向广播地址各发一份**：设备同时有 Wi-Fi 和蜂窝网时，
  有限广播可能从"错误"的接口出去，那样电脑永远收不到；指定了网卡就只发那块网卡的。
- **为什么申请 MulticastLock**：Android 的 Wi-Fi 省电逻辑会过滤掉"目的地址不是本机单播地址"的帧，
  否则会出现"偶尔能发现、偶尔发现不了"。
- **为什么屏幕常亮用 window flag 而不是 WAKE_LOCK**：不需要权限，也不需要持有 CPU 锁。
  因此 Media3 清单里带的 `WAKE_LOCK` 被 `tools:node="remove"` 显式剔除了。
- **为什么横竖屏都不锁**（`fullSensor` + `configChanges`）：投屏内容基本是 16:9，横屏体验最好，
  但用户可能把设备竖着立在支架上；两种都支持，而且旋转时**不重建 Activity**，
  否则一转屏播放器就被拆掉重来、画面会中断。
- **为什么"全屏"是播放时按需进入，而不是整个 App 都用全屏主题**：首页现在是正常的应用界面
  （状态卡 + 收藏 + 历史），需要状态栏那点空间；播放时才调
  `WindowInsetsControllerCompat.hide(systemBars())` + 切横屏，退出播放就恢复
  `SCREEN_ORIENTATION_UNSPECIFIED` 并显示系统栏。
- **为什么首页和播放层做在同一个 Activity 的两层布局里**：切到播放只是改可见性，
  PlayerView 与 ExoPlayer 始终是同一个实例；换成两个 Activity 会在切换时重建播放器、画面会断。
- **为什么设置页用单独的主题**：它是表单、要输入文字（软键盘），
  单独一个主题也方便以后只调设置页样式而不影响首页。
- **为什么同步要"先缓存再刷新"**：用户点开 App 的那一刻，收藏/历史必须马上有东西可看 ——
  不能等网络、更不能因为电脑没开就是白屏。所以永远是"先读本地缓存立刻显示 → 后台同步回来再刷新"。
- **为什么本地历史"有变化才推"**：每次同步都全量 POST 一遍会让电脑端做无谓的写盘；
  用"条数 + 最新时间 + 位置总和"算个指纹，变了才推。
- **为什么封面要自己写加载器**：引 Glide/Coil 会带进一堆透明与注解处理器，
  而这里只需要"下载一次、缩放、显示、别串图"（靠 `view.tag` 校验迟到的结果），一百多行就够。
- **为什么 targetSdk 是 34 而不是 36**：从 targetSdk 35 起系统强制 edge-to-edge
  （内容铺到状态栏/导航栏底下）。本工程刻意不引 AppCompat/insets 那套，定 34 可以让界面
  在绝大多数设备上保持"内容区自动避开系统栏"，全屏则完全由我们按需控制。

---

## 5. 已知限制（请如实了解）

**功能上的**

- **只支持 HLS(m3u8) 与渐进式 mp4**。DASH/SmoothStreaming 没接（`caps` 里也没承诺）。
  判定方式是"URL 里是否含 `.m3u8`"，所以**不带扩展名的 HLS 地址会被当成直链**播不了。
- **加密 / DRM 流、需要客户端证书的流不支持**。
- **播放出错不会自动重试**：出错后 `state` 变回 `idle`，界面显示"播放失败：原因"，
  需要电脑端重新发 `/play`。接收端不擅自重连，是为了不把"地址已过期"变成无限重连。
- **没有字幕/音轨切换**，也不支持外挂字幕。
- **`playlist` 只透传 url 和标题**，时长/封面/简介之类不会显示。
- **规则模式下 playlist 只有标题**：接收端上"上一集/下一集"会禁用、选集里点了会提示
  "请在电脑上切集"。要换集必须由电脑端重新投一次（这是电脑端给的数据决定的，不是接收端偷懒）。
- **`next`/`prev` 到头就停住，不循环**。
- **静音是接收端自己实现的**（把播放器音量设 0 并记住原档位），ExoPlayer 没有静音开关。

**同步上的**

- **收藏只读、历史双向**：收藏是电脑端的权威来源，接收端不会改了推回去。
- **`syncUrl` 只存在"最近一次有效值"**：没投过屏（也没探测到）时它是空的，
  收藏/历史就只能看本机缓存，同步按钮会置灰说明原因。
- **自动连接的第 3 条路径要"猜端口"**（`{PC_IP}:52890/sync/ping`）：还没投过屏时我们只知道电脑 IP。
  如果电脑端的同步服务改用别的端口，这条路径就会失效 —— 那时**投屏一次**即可
  （`/play` 里带着真正的 `syncUrl`）。
- **`play-subject` 之后要等电脑把流投过来**才会开始播放，中间是电脑在选源/嗅探，
  接收端只能显示"正在解析播放源…"。电脑如果一直不投，界面会停在提示上（没有超时回滚）。
- **历史归属靠"猜"**：`/play` 里没有 `subjectId`，接收端用"刚点过 play-subject 的那个 id"
  （120 秒内有效）或"标题与收藏同名"来认；都认不出来时历史条目只有标题，
  合并时按"标题 + 集号"去重。
- **本地历史最多 500 条**（超出丢最旧的），免得 SharedPreferences 被撑大。

**蓝牙（本期不做）**

- 设置页的「关于」里写明了：**蓝牙连接暂未支持，请用同一局域网或 USB 网络共享**。
  没有放一个点不动的假按钮。原因：蓝牙那条路要电脑端额外的原生能力（蓝牙 PAN/RFCOMM），
  属于传输层，不在本接收端能单独解决的范围内。
- 需要注意的是**蓝牙音频输出**是另一回事：它由系统负责，接收端只控制 ExoPlayer 自己的音量、
  不碰系统媒体音量，所以用蓝牙音箱时如果把系统音量为 0 依然没声音 ——
  建议把设备系统音量调到中高档，再用遥控微调。

**网络与生命周期上的**

- **自动发现只在同一个广播域内有效**。以下情况广播到不了对端，需要走 2.2 节的兜底：
  - 路由器开了 AP 隔离 / 公共 Wi-Fi 限制广播；
  - 电脑和设备不在同一网段（电脑接有线、设备连别的路由）；
  - **USB 网络共享 / USB 以太网**：手机和电脑会形成一个私有网段（手机多出 `192.168.42.x`、
    电脑多出一块网卡）。广播**有时候能通、有时候被系统过滤**，所以务必用
    「主动连接电脑」或在电脑上手填手机地址这两条路，不要指望广播。
  - 设备有多块网卡时，**必须**在设置里把「首选网络接口」选成电脑能到达的那一块；
    界面顶部与「关于」里显示的就是当前选中的那块网卡与它的广播地址，方便核对。
- **没有前台 Service**：只有界面在前台时接收端才工作。切到别的 App 或锁屏后，
  系统可能回收进程，届时控制接口和发现服务都会停。按要求只用了
  `FLAG_KEEP_SCREEN_ON`（界面在前台时屏幕不会黑），没有申请 `WAKE_LOCK` 或 `FOREGROUND_SERVICE`。
- **开机自启开关不保证生效**：Android 10 起系统禁止应用在后台启动界面，
  `BootReceiver` 里的 `startActivity` 在大多数现代设备上会被静默拦下。
  设置页的说明里如实写了这一点；真正可靠的做法是把接收端做成前台服务（架构改动，本期没做）。
- **改名后最长 5 秒**电脑端才会看到（等下一次广播）。
- 如果设置的端口起连续 100 个端口都被占用，控制服务会启动失败，界面与「关于」会显示原因。

**关于权限**

安装时看到的是：`INTERNET`、`ACCESS_NETWORK_STATE`、`ACCESS_WIFI_STATE`、
`CHANGE_WIFI_MULTICAST_STATE`、`RECEIVE_BOOT_COMPLETED`（都是普通权限，不弹授权框），
以及一条 `app.sakana.receiver.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` ——
那是 androidx.core 自动生成的**自定义签名级权限**（用于 `registerReceiver(..., RECEIVER_NOT_EXPORTED)`），
不是系统权限。Media3 清单自带的 `WAKE_LOCK` 已被 `tools:node="remove"` 剔除。

**验证状态**

- 已经验证：编译通过、打包通过、协议层/网卡选择/播放列表导航/同步客户端与合并逻辑的自测（见下节）。
- **没有验证**：没有真机安装过；电脑端的投屏通道（`cast.ts`）是**读代码对齐**的，
  电脑端的**同步服务这一轮还没有代码**（协议是按需求里给的字段实现的），所以两边都没有真正联调过。
  下面这些都还没有实测：
  - UI 实际观感、**播放时横屏全屏**的实际效果（旋转后画面是否变形、控制栏位置、返回键顺序）；
  - 电视盒子遥控器的焦点行为；
  - 真实 CDN 的拉流表现、`headers` 是否被接受；
  - 同步端点的真实行为（端口是不是 52890、字段是否与我们解析的一致、`play-subject` 的返回）。
  第一次真机联调时请重点看这几点。

---

## 6. 验证记录（本机实际执行）

### 6.1 构建

```powershell
cd E:\sakana.app\android-receiver
$env:JAVA_HOME='E:\environment\jdk-21.0.2'
$env:ANDROID_HOME='E:\environment\Android SDK'
.\gradlew.bat clean assembleDebug assembleRelease --console=plain --offline --no-watch-fs --warning-mode all
```

结果：

```
BUILD SUCCESSFUL in 3m 34s
```

- `app\build\outputs\apk\debug\app-debug.apk` —— **5881 KB**
- `app\build\outputs\apk\release\app-release-unsigned.apk` —— **1135 KB**（R8 + 资源压缩，未签名）
- `--warning-mode all` 下**没有**任何废弃 API 警告，也没有 Kotlin 警告。
- 注意：本机**没有网络**，所以用的是 `--offline` + 本机已有的 Gradle/依赖缓存；
  另外按 1.4 节设置了 `GRADLE_USER_HOME` / `GRADLE_RO_DEP_CACHE` / `LOCALAPPDATA`。
  有网络的机器上不需要 `--offline`，也不需要那些变量。

`aapt2 dump badging` 复核（debug 包）：

```
package: name='app.sakana.receiver' versionCode='1' versionName='1.0.0' compileSdkVersion='36'
minSdkVersion:'24'
targetSdkVersion:'34'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.ACCESS_WIFI_STATE'
uses-permission: name='android.permission.CHANGE_WIFI_MULTICAST_STATE'
uses-permission: name='android.permission.RECEIVE_BOOT_COMPLETED'
uses-permission: name='app.sakana.receiver.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
launchable-activity: name='app.sakana.receiver.MainActivity'
leanback-launchable-activity: name='app.sakana.receiver.MainActivity'
```

（`WAKE_LOCK` 已按预期不在列表里。）

### 6.2 协议层自测

编译产物里的 `Json` / `JsonParser` / `Http` / `Proto` / `Lan` / `Reply` /
`SyncModels` / `HistoryMerge` / `SyncClient` / `PlaylistNav` 都是纯 JVM 代码
（`Lan` 只用到 `java.net`，`SyncClient` 只用到 `HttpURLConnection`），
所以可以在桌面上直接跑断言，不需要模拟器。
同步那部分还额外起了一个**本地的假 PC 同步服务端**（JDK 自带的 `HttpServer`）做真请求。
用一个临时 Java 测试类加载上面编译出的 class 后执行：

```
==== 135 passed, 0 failed ====
```

覆盖的点（都是两边对接最容易踩坑的地方）：

**投屏协议**

- 协议常量、`caps` 列表、`state` 枚举拼写；报文键名 `sakana|host|port|name|caps|v` 逐字一致。
- **接收端应答报文逐字节比对，且断言里面**有** `host`**：
  `{"sakana":"receiver","v":1,"host":"192.168.42.129","name":"Redmi Note 12","port":52889,"caps":[...]}`
  —— 这是电脑端能不能发现本机的关键（见 3.1 的警告）。
- 解析电脑端发来的 discover（带 `host`），以及**缺 `host` 的旧报文也不能崩**。
- 用**电脑端实际会发的形状**解析 `/play`：`url`/`title`/`startMs`/`index`/`headers` 三个键/`playlist` 每一项，
  以及本轮新增的 **`syncUrl`**（有值 / 空串 / 字段缺失三种都验证）。
- **规则模式**：`playlist` 里 `url` 全为空串、只有标题时，主 `url` 仍有效、标题仍能取到、
  `headers` 是空对象也解析得动。
- 10 个 `action` 全量解析；PC 实际会发的 `{"action":"pause"}`（没有 value）也不崩；
  字符串形式的数字（`"value":"88000"`）也认；非法 JSON 返回 `null` 而不是抛异常。
- 转义往返、13 位毫秒时间戳不丢精度、200 层嵌套被拒绝。
- HTTP（服务端侧）：`Content-Length` 的 POST、`chunked`（含 `;ext=1`）的 POST、
  带 query 的 `GET /info`、**裸 LF** 的头、头名大小写归一、响应头与 `Content-Length` 字节数。
- `Reply`：`ok()` = 200 + `{"ok":true}`；`bad()` = **400** + 合法 JSON（引号被转义）
  —— 直接验证了"失败必须非 2xx"这条对电脑端互操作至关重要的约定。
- **网卡选择**：自动挑偏 Wi-Fi、显式选 `rndis0` 生效、网卡拔掉回落到自动、
  `rndis0` 归类为 USB 共享、指定 USB 网卡时广播目标只发那块网段。

**双端同步（本轮新增）**

- `syncUrl` 规范化：标准地址 / 去尾斜杠 / 只给 `ip:port` 自动补 `http://` / 保留 https /
  空串与 `null` 与"只有端口"都返回 `null`。
- **收藏解析**：脏数据（`subjectId` 写成 `"456"`、`eps` 写成 `"12"`、`rating`/`genres` 缺失、
  `cover` 为空）都能认；**连名字都没有的条目被丢掉**，不会让整份列表失败；序列化再解析可往返。
- **历史合并去重**（`HistoryMerge`）：
  - 同一部番同一集只留一条；
  - 保留**看得更晚**的那份（反过来也验证一遍，确保不是碰巧）；
  - `watchedAt` 相同时取播放位置更靠后的（不把进度往回退）；
  - 没有 `subjectId` 时按"标题 + 集号"去重，**大小写与空格归一**（不会拆成两条）；
  - 结果按时间倒序；指纹对同一份数据稳定、内容变了就变、空列表是 `"0"`。
- **播放列表导航**（`PlaylistNav`，规则模式那条需求的核心）：
  下一集/上一集正常前进后退、**到头不循环**、规则模式下找不到可播目标（返回 -1）、
  **跳过中间的空地址**（两个方向都测）、`playableFlags` 正确、空列表返回 -1。
- **`SyncClient` 真请求**（对着本地假 PC 服务端）：
  - `/sync/ping` 拿到电脑名与版本；
  - `/sync/favorites`、`/sync/history` 的响应解析成模型；
  - `POST /sync/history` 的 body 形状是 `{"items":[…]}`，且**能被服务端再解析回来**（3 条、顺序对）；
  - `/sync/command` 能拿到 `message` 与 `episodes`；
  - **电脑拒绝时 `ok=false` 且 `message` 原样带回**（界面要显示原因，而不是"失败"两个字）；
  - 未知端点 → `ok=false` 且错误里带 `HTTP 404`；连不上的地址 → 干净失败，不抛异常。

> 这个自测脚本是临时文件，验证完已删除，没有留在仓库里。

**自测当场抓出的两个真问题（都已修）**：

1. 本机 Wi-Fi 网卡在 Java 里的名字是 `wireless_32768`（Android 上叫 `wlan0`），
   而最初的类型判定只认 `wlan`/`wifi`，于是它被归类成「其它」，
   自动挑选时会**输给虚拟网卡** —— 这正是"界面显示了一个电脑连不上的地址"那类故障。
   现在同时认 `wireless`，并加了针对虚拟网卡名的减分。
2. `activity_main.xml` 里用 `<!-- ---- 收藏 ---- -->` 这种分隔线注释会被 AAPT 直接拒掉
   （XML 注释里不允许出现 `--`），编译报的就是"ParseError"。

### 6.3 还没做的验证

- **没有真机安装与运行**（本机没有连接安卓设备），所以 UI 观感、遥控器焦点、
  **横屏全屏与旋转的实际表现**都只看过代码，没看过画面。
- **没有和电脑端真正联调**：
  - 投屏侧只能读 `cast.ts` / `castRelay.ts` 对齐；
  - **同步侧电脑端这一轮还没有代码**（`/sync/*` 是按需求里给的字段与响应形状实现的），
    所以端口 `52890`、字段名、`play-subject` 的返回都**没有被真实验证过**。
  下面这些仍需真机/真机联调确认：
  - 电脑端是否真的收到了接收端**主动宣告**（USB 共享网络场景的关键路径）；
  - 电脑端同步服务是否真的在 `52890`（否则自动连接的第 3 条路径失效，投屏一次即可恢复）；
  - `headers`（Referer/Cookie）是否被目标 CDN 接受、HLS 分片是否顺畅；
  - 规则模式下"电脑端换集后重新投屏"这条链路；
  - 点收藏后电脑"选源→嗅探→投回"整条链路，以及失败时 `message` 的显示；
  - 旋转后画面是否变形、控制栏位置、返回键两次的顺序。
- 按需求**没有**申请前台服务相关权限，所以"锁屏/切后台后接收端还活着"这件事**做不到**，
  这是刻意的取舍（见"已知限制"）。
