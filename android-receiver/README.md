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
- **播放时横屏全屏**：进播放自动转真全屏（edge-to-edge + 隐藏系统栏 + 刘海区域也能用满），
  控制栏是自己写的（挂在官方 `PlayerView` 的 `controller_layout_id` 上）、几秒自动淡出；
  支持双击两侧快进快退、左右半边滑音量/亮度、水平拖动定位、长按 2× 速。
- **自己的图标**：白底蓝色投屏符号，和电脑端应用的图标不是同一个。
- **设置页**：设备名、控制端口、首选网卡、主动连接、屏幕常亮、自动播放、铺满屏幕、开机自启、同步状态、下载说明、关于。
- **状态可见**：缓冲中 / 播放中 / 已暂停 / 播完 / 播放失败（带错误码、原因和「重试」），以及"已被谁连接"。
- **全部白底蓝主色**：所有颜色集中在 `colors.xml` / `themes.xml`，布局里不写死颜色。

体积（本机实测）：debug **5.78 MB**，release（R8 + 资源压缩）**1.14 MB**。

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

> ⚠️ **debug 包必须用同一把 keystore 签，否则设备上装不上（只能卸载重装）**
>
> 仓库里发布的那份 APK（`dist/SakanaReceiver-<版本>-debug.apk`，也就是电脑端设置页里下载的那个）
> 是用**本机的 `android-receiver/.android-home/debug.keystore`** 签的。如果你换一台机器、
> 或者让构建用了别的用户目录，Gradle 会生成**另一把** debug 密钥，装到已经有旧版本的手机上会报
> `INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`（应用数据也会一起丢）。
>
> 想让新包能**原地覆盖安装**（不卸载、不丢设置与缓存），构建时把用户目录指到仓库内那把密钥：
>
> ```powershell
> $env:ANDROID_USER_HOME='E:\sakana.app\android-receiver\.android-home'
> .\gradlew.bat assembleDebug --offline
> ```
>
> 核对签名是否一致（两条输出必须相同）：
>
> ```powershell
> & "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --print-certs `
>   app\build\outputs\apk\debug\app-debug.apk | Select-String 'SHA-256 digest'
> ```

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
  **全部收藏都在同一个列表里，可以一直往下滚**（见下面的"收藏翻不动"）。
- 观看历史：**竖排卡片**（封面缩略图 + 标题 + 「第 N 集」徽标 + 进度条 + 相对时间"3 小时前/昨天"）。
  点一下从那一集接着播，长按看详情 / 删掉这一条。
  为什么不做成横向长条：横向列表要么把最近几条藏在屏幕外、要么为了一屏塞下而砍掉标题和进度，
  而历史条目恰恰是"标题 + 第几集 + 看到哪了"三样都要看的东西；竖排卡片能一行给全，
  也和上面的收藏网格用同一条滚动轴。默认只显示最近 4 条，多出来的折成一行「查看全部」(N)，
  点开变成「收起」——这样历史很长时也不会把收藏挤到看不见。
- 底部：「立即同步」「设置」。
- 两个列表都有**空态文案**（"还没有从电脑同步收藏，连上电脑后会自动同步"之类），不会留白屏。

> **"收藏翻不动、看不到其它收藏"是怎么回事（已修）**
>
> 原来的首页是 `ScrollView` 里塞两个各自 `wrap_content` 的 `RecyclerView`。
> 嵌套滚动容器里的 `RecyclerView` 拿到的是 `AT_MOST` 高度约束，`LinearLayoutManager`
> 只按这个上限布局，**超出屏幕的条目根本不会被创建**，所以既滚不到、也不显示；
> 而且内外两层都能滚，手势还会互相抢，滑一下动一下又弹回去。
> 现在首页只留**一个** `RecyclerView`（`layout_height="0dp"` + `layout_weight="1"`，
> 父容器给的是精确高度），收藏、历史、分区标题、空态、"查看全部"全部作为不同的
> item 类型由 `HomeAdapter` 按 span size 拼在这一条滚动轴上；固定的状态卡和底栏放在
> 它外面，所以状态一直可见、底栏一直可点。见 `HomeRows.kt` / `HomeAdapter.kt` /
> `HomeBinder.kt`，以及 `activity_main.xml:147-160`。

**② 播放层**（有媒体时）

播放器用的是 Media3 官方的 `PlayerView`（`app:use_controller="true"`），但控制栏是**自己写的**
（`player_control_view.xml`，通过 `app:controller_layout_id` 挂上去，根节点必须是 `<merge>`）。
这样做的好处是进度条、按钮、配色、状态显示全在自己手里，也不用引第三方播放器库。

- 画面铺满整个窗口，自动切**横屏全屏**：`WindowCompat.setDecorFitsSystemWindows(window, false)`
  + `WindowInsetsControllerCompat.hide(systemBars())` + `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`
  （边缘上滑可临时唤出系统栏），主题里 `windowLayoutInDisplayCutoutMode=shortEdges`，
  刘海/挖孔区域也能用满（`FullscreenController.kt`）。
- **顶栏**：标题（第几集 / 文件名）+「选集」+「设置」+「退出全屏」。
- **底栏**：进度条（可拖，蓝色已播/缓冲色）+ 当前位置 / 总时长 + 上一集 / 后退 10 秒 /
  播放暂停 / 前进 10 秒 / 下一集 + 音量− / 音量+ + 倍速 + 锁定方向 / 解锁方向 + 「铺满」/「适应」。
- **手势**（`PlayerGestures.kt`）：
  - 单击画面：显示 / 隐藏控制栏；
  - 双击左半边 / 右半边：后退 / 前进 10 秒，连点会累加（每次 +10 秒，最多 ±60 秒），
    屏幕上给出提示气泡，停手后真正 seek 一次；
  - 右半边上下滑：音量；左半边上下滑：亮度；
  - 水平拖动：拖动即预览目标时间，松手才 seek（不会边拖边跳）；
  - 长按：2× 倍速，松手恢复。
- **状态**：缓冲中显示转圈；播完显示重播；**播放失败显示错误码 + 原因 + 「重试」按钮**
  （重试是重新加载当前这一集并从头开始）。播放中 4 秒无操作控制栏自动淡出，暂停时常显，
  拖动进度时不消失。
- **返回键**：先退出全屏（回到竖屏、恢复系统栏），再按一次才退出播放，**永远不会直接退出 App**。
- 退出播放（停止、或回到 idle）时恢复 `SCREEN_ORIENTATION_UNSPECIFIED` 和系统栏。
- 设置页里的「铺满」开关等价于底栏的「铺满」按钮：`resize_mode` 在 `fit`（保持比例留黑边）
  和 `fill`（裁掉多余部分填满屏幕）之间切，`onResume` 时会重新套用。

**配色**：全部白底 + 蓝主色，统一在 `colors.xml` / `themes.xml` 里，布局和 Kotlin 里都不再写死
颜色（背景 `#FFFFFF`、卡片 `#F5F8FF`、主色 `#2E6BE6`、主文字 `#101828`、次文字 `#667085`、
分割线 `#E4E7EC`）。播放层浮在画面上，所以底衬仍是半透明深色（否则白字看不清），
但按钮着色、进度条已播/缓冲色、提示气泡都换成了同一个蓝。

**图标**：本 App 有自己的启动图标（白底蓝色投屏符号，`ic_launcher_foreground.xml` /
`ic_launcher_background.xml` / `mipmap-anydpi-v26/*`，含圆形 `ic_launcher_round`），
和电脑端应用的图标不是同一个。自适应图标的前景元素都收在 66×66dp 安全区内。

### 2.4 设置页

| 项 | 说明 |
| --- | --- |
| 设备名 | 电脑端发现列表里显示的名字，默认设备型号；改完最多 5 秒（下一次广播）电脑端可见 |
| 控制端口 | 默认 52889，改动后服务立即重启；被占用会自动顺延，真实端口见「关于」 |
| 首选网络接口 | Wi-Fi / USB 共享 / 有线 各自列出，指定"在哪块网卡上广播、把哪个地址报给电脑" |
| 主动连接电脑 | 填电脑 IP 后每 5 秒向它单播宣告（见 2.2） |
| 保持屏幕常亮 | 默认开；黑屏会连带 Wi-Fi 省电，发现与控制都可能不稳 |
| 收到投屏后自动播放 | 默认开；关掉时只加载不播放，等电脑端按播放 |
| 铺满屏幕 | 默认关；开 = 画面填满屏幕（可能裁掉一点边），关 = 保持比例、留黑边。等价于播放层底栏的「铺满」按钮 |
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
4. **断网也能看**：收藏与历史都在本机（`SharedPreferences`），冷启动**先读缓存立刻渲染**，
   一个网络请求都不等；同步失败也不会把旧数据清掉，状态行会写明
   「离线 · 缓存于 3 小时前 · 收藏 86 / 历史 14」。
5. **手动同步**：首页底部或设置页里的「立即同步」。没连过电脑时它会明确告诉你该怎么做，
   而不是假装同步了一下。

### 2.6 本地缓存（收藏数据 + 封面图片）

这一节是"为什么第二次打开不用重新加载"的全部答案。

**① 收藏 / 历史数据**

- 落盘在 `SharedPreferences`（`SyncStore`），每条数据都带**缓存时间戳**；
- 冷启动路径是「**先读缓存立刻渲染 → 后台连电脑 → 回来了再刷新**」，不是等网络；
- **同步失败保留旧数据**：状态行先给失败原因，再补一句
  「数据还在：本机缓存的 X 那份，稍后会自动重试」；
- **空列表不覆盖非空缓存**：`Favorite.listFromJson` 会丢掉没有名字的脏条目，
  万一电脑端改了字段名把整份列表解析成空，也能保住本地已有的收藏 ——
  宁可显示"同步可能有问题"，也不要让一次解析事故看起来像"收藏全没了"。

**② 封面图片：三级缓存**

| 级别 | 内容 | 说明 |
| --- | --- | --- |
| 内存 | `LruCache`，**按字节**限容 | 上限 = `min(32MB, 运行时堆的 1/8)`，不低于 2MB。按字节而不是按张数：一张 400px 的 JPEG 解出来约 0.6MB，原图缩下来的可能 4MB，同样"100 张"能差好几倍 |
| 磁盘 | `cacheDir/covers/` | 文件名 = `SHA-1(完整 URL) 前 16 字节的 hex`（32 字符）+ 扩展名。写盘前**先缩到 400px 宽**（`BitmapFactory.inSampleSize` 两遍解码）再按 JPEG 质量 85 存 |
| 网络 | 只有前两级都落空才走 | 只走 `HttpURLConnection`，连接/读取超时各 6 秒 |

> 扩展名跟着**实际写盘的编码格式**走，不跟 URL 走：源图是 PNG 就存 `.png`（PNG 可能有透明通道，
> 压成 JPEG 透明区会变黑块），其余一律 `.jpg`。内容是 JPEG 却叫 `.png`，以后谁来做清理/迁移都会被假名字坑。

关键行为（都是用户能直接感觉到的）：

- **缺什么补什么，磁盘命中绝不发请求** —— 这就是"不要每次打开都重新加载"的实现，
  也是"离线也有图"的实现。判据是纯函数 `decideCoverSource`，有单测；
- **磁盘上限 300MB + LRU 清理**：按"最后访问时间"删到上限的 80%。
  读缓存时会 `setLastModified(now)` 推一下访问时间，所以不用额外维护索引文件
  （索引也要落盘、也会损坏，而文件系统已经免费提供这个信息）。
  **启动时清一次**；写盘路径上只做一次计数判断、超过上限 1.2 倍才再扫一次目录 ——
  几千个文件每次写盘都 `stat` 一遍会直接把列表滚动拖卡；
- **升级不白费已有缓存**：0.3.8 之前缓存文件名是"完整 SHA-1 + `.img`"，
  现在是"前 16 字节 + 扩展名"。启动时会做一次**改名迁移**（截断哈希 + 改成 `.jpg`，
  内容本来就是 JPEG），所以升级后已经下过的封面**不会重下一遍** ——
  真机上有 82 张（约 10MB）就是这么保下来的。只有源图是 PNG 的少数几张会重下（见 `CoverDisk.migrateLegacyNames` 的说明）；
- **失败退避**：同一 URL 失败后 60 秒内不再重试，连续失败退避到 5 分钟 → 25 分钟 → 30 分钟封顶，
  **不会永久拉黑**（地址可能只是临时抽风）。没有这层的话，失效地址会在每次滚动时被重试一遍 ——
  用户说的"重复加载"就是这种刷屏式请求。判据是 `CoverRequests`，有单测；
- **同一 URL 并发合流**：同一封面会同时出现在收藏网格、观看历史、弹窗里，加上列表复用，
  可能同时有四五个 `ImageView` 要它。只有**第一个**调用者会真发请求，其余的登记成"等待者"，
  结果广播给所有还在等这个地址的 view —— 同一个 URL 全局只真发一次（`CoverRequests`，有单测）；
- **`view.tag` 校验迟到结果**：`setImageBitmap` 之前再比一次 `view.tag == url`，
  避免列表复用时"图串了"；预取拿到图时也会走同一条广播路径，
  免得"预取先抢到、用户正好滚到同一张"时那个 view 一直停在占位图上；
- **离线/失败绝不显示空图**：先摆占位图，命中缓存/后面拿到了就换上去；
- **同步完成后后台预取**：把收藏里**缺图**的封面按 **2 个并发**抓一遍（单轮上限 80 张），滚到就有。
  已有的缓存**一个都不重复抓**（在 `fetchIntoCache` 里查完内存/磁盘再决定，
  不存在"判断完到开抓之间"的窗口）。预取跑在自己的 2 线程池里、不占可见加载的 3 个线程，
  界面销毁时 `onDestroy` 会取消它。
  **计费网络（移动数据）下不自动预取** —— 预取是"为了体验提前下流量"，
  在用户按流量付费的网络上一口气抓几十张封面是花用户的钱，不能这么干；
  真滚到某张时照常按需加载（那是用户主动要看，不算浪费）；
- **内存兜底**：`onTrimMemory` / `onLowMemory` 会把内存缓存整个丢掉
  （磁盘还在，下次从磁盘读回来，几十毫秒，用户几乎看不出来）；
  解码碰到 `OutOfMemoryError` 也会清空内存缓存，而不是让后续每次加载都继续失败。

**③ 可观测（设置页）**

设置页有独立的「图片缓存」区块：**封面缓存：N 张 · X MB · 缓存于 …**，外加一个「清理图片缓存」按钮。
数字是**真的去扫 `covers/` 目录算出来的**（在后台线程算，算完再回主线程填），没有任何写死的值
—— 所以它能用来做真机验证。清理**只删封面图**，收藏与观看历史不受影响
（确认框里也再写了一遍，因为"清理缓存"这个词在很多 App 里意味着清数据，用户会怕）。

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

按"一件事一个类 / 一个文件"拆开，**49 个 Kotlin 文件全部 ≤300 行**（最长 300 行）：

**协议与传输**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Proto.kt` | 55 | 协议常量（端口、间隔、caps、state、报文字段名）。**改这里等于改协议** |
| `Json.kt` | 133 | 手写 JSON 的对外 API、序列化、字段取值辅助函数 |
| `JsonParser.kt` | 153 | 手写 JSON 的递归下降解析器（含局限说明） |
| `Http.kt` | 213 | 手写 HTTP **服务端**：请求读取与 JSON 响应写出（含 chunked） |
| `ControlServer.kt` | 164 | ServerSocket、端口顺延、路由分发、`Reply`（成功 200 / 失败 400） |
| `ControlApi.kt` | 164 | 把 HTTP 请求翻译成播放器调用 + 组装 `/info` JSON；负责切到主线程 |
| `PlayerGateway.kt` | 30 | 控制接口需要的播放动作（界面活着才注册，避免碰已释放的播放器） |
| `DiscoveryService.kt` | 251 | UDP 52888 的收发、广播、向手填地址主动宣告 |
| `WifiMulticastLock.kt` | 43 | MulticastLock 的薄封装（Wi-Fi 省电时不漏收广播） |
| `Lan.kt` | 170 | 列出网卡（含 Wi-Fi/USB/蓝牙/有线分类）、挑网卡、算广播目标 |

**播放**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `PlayerController.kt` | 300 | ExoPlayer 封装：播放列表、音量、倍速、重试、规则模式的空地址防护 |
| `PlaybackEvents.kt` | 40 | `Player.Listener` 桥：只把"状态变了/出错了"两件事转出来给界面 |
| `PlayerGestures.kt` | 192 | 手势：单击/双击累加 seek/长按 2× 速/左右分别调亮度音量/水平拖动 seek |
| `PlaybackUi.kt` | 295 | 播放层接线：两个形态切换、横屏全屏、控制栏与手势的挂载点、两个出口 |
| `PlaybackControls.kt` | 156 | 控制栏显隐的**唯一**负责人（一个计时器）+ 关掉 Media3 自带那套 |
| `ControlsPolicy.kt` | 77 | **纯逻辑**：状态跃迁 -> 该不该动可见性（幂等，同状态一律 NONE）—— 有单测 |
| `PlayerActions.kt` | 157 | 播放层小动作：提示气泡、亮度、音量、铺满、进度条拖动计时 |
| `PlaylistNav.kt` | 32 | 播放列表切换目标的计算（跳过空地址、不循环）—— 纯逻辑，有单测 |
| `PlaybackState.kt` | 28 | 播放状态 -> 协议 `state` 枚举的映射 |
| `MediaSources.kt` | 82 | URL -> MediaSource：请求头透传、过滤，HLS/直链区分 |

**封面缓存（三级：内存 → 磁盘 → 网络）**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `CoverLoader.kt` | 269 | 门面：内存 LRU（按字节）、三级取图调度、等待者广播、`view.tag` 校验、OOM/低内存兜底、预取入口 |
| `CoverDisk.kt` | 192 | 磁盘缓存：读写（命中即推访问时间）、旧命名**迁移**、真实占用统计、启动 LRU 清理、清空 |
| `CoverPrefetch.kt` | 164 | 同步后的后台预取：2 并发、跳过已有、计费网络不预取、可取消、按原因记录每轮结果 |
| `CoverRequests.kt` | 116 | **纯逻辑**：取图来源决策 + 并发合流 + 失败退避 + 取图结果枚举 —— 有单测 |
| `CoverDownload.kt` | 88 | 下载与解码：超时、体积上限、两遍解码、明文 http 失败自动换 https |
| `CoverKeys.kt` | 69 | **纯逻辑**：URL→缓存键（SHA-1 前 16 字节 + 扩展名）、`inSampleSize` 计算 —— 有单测 |
| `CoverLru.kt` | 69 | **纯逻辑**：磁盘上限 300MB 与 LRU 淘汰计划 —— 有单测 |

**双端同步**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `SyncModels.kt` | 158 | 收藏/历史的数据模型 + 宽松 JSON 解析（类型串了也能认） |
| `HistoryMerge.kt` | 52 | 历史的合并去重与"要不要推"的指纹 —— 纯逻辑，有单测 |
| `SyncClient.kt` | 93 | 同步服务的 HTTP 客户端（`HttpURLConnection`，地址规范化） |
| `SyncStore.kt` | 204 | 收藏/历史的本地缓存与持久化、**缓存时间戳**、空列表保护、同步地址、上次同步时间 |
| `SyncManager.kt` | 265 | 同步调度：拉收藏/历史、推本地历史、`play-subject` 点播、同步完成后触发封面预取 |
| `SyncDiscovery.kt` | 80 | 找电脑的同步服务：候选端口探测、限流、自动重连 |
| `WatchRecorder.kt` | 95 | 本地观看历史的记录时机与限流、把播放认到某个条目上 |

**界面与运行时**

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Settings.kt` | 125 | 用户设置（设备名/端口/网卡/主动连接/铺满等开关）的持久化 |
| `Receiver.kt` | 176 | 运行期外壳：控制服务 + 发现服务的启停、配置变更重启、连接统计 |
| `ReceiverApp.kt` | 16 | Application：初始化 Settings / 同步 / 封面缓存（含启动清理） |
| `MainActivity.kt` | 273 | 主界面接线、两个形态的切换、返回键分级、生命周期、低内存兜底 |
| `PlaybackUi.kt` | 278 | 播放层：官方 `PlayerView` + 自写控制栏、手势、全屏、提示气泡 |
| `FullscreenController.kt` | 74 | 真全屏：edge-to-edge、系统栏隐藏/恢复、屏幕方向与"锁定方向" |
| `HeaderBinder.kt` | 119 | 顶部状态区（设备名/大字状态/副状态/地址/**同步状态行**） |
| `StatusText.kt` | 56 | 顶部那两行文字怎么拼（状态与副状态的优先级） |
| `TimeText.kt` | 55 | **时间文案**：`mm:ss` 与"刚刚 / N 小时前 / 昨天"（播放层、历史卡片、设置页共用） |
| `HomeBinder.kt` | 65 | 单一 RecyclerView 的接线、滑动位置保护、避免无谓重绘 |
| `HomeRows.kt` | 86 | 首页要显示哪些行（收藏全部 + 历史折叠）—— 纯逻辑，有单测 |
| `HomeAdapter.kt` | 185 | 首页多类型适配器（分区标题/空态/收藏格/历史卡/「查看全部」） |
| `UiHelpers.kt` | 262 | 同步状态文案（含离线"缓存于"）、选集/详情弹窗、相对时间、字节格式化、剪贴板 |
| `SettingsUi.kt` | 168 | 设置页里较独立的控件：网卡选择弹窗、最近地址、**图片缓存区块**、字节格式化 |
| `SettingsActivity.kt` | 278 | 设置页 |
| `BootReceiver.kt` | 29 | 开机自启（见"已知限制"） |

界面资源：`activity_main.xml`（首页层 + 播放层）、`activity_settings.xml`（表单 + 图片缓存区块）、
`player_control_view.xml`（自写的 Media3 控制栏，根节点 `<merge>`）、
`item_favorite.xml`（收藏一格）、`item_history.xml`（历史一张卡）、`item_section.xml`、
`item_empty.xml`、`item_action.xml`、`item_episode.xml`、`item_recent_host.xml`、
`res/drawable/ic_*.xml` 共 13 个自己画的矢量图标（含启动图标前景）、
`res/mipmap-anydpi-v26/`（自适应图标）、`res/color/icon_tint.xml`（禁用态自动变暗）。

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
- **播放出错不会自动重试**：出错后 `state` 变回 `idle`，界面显示"播放失败：错误码 + 原因"，
  并给一个「重试」按钮（重新加载**当前这一集**并从 0 开始）。电脑端也可以随时重发 `/play`。
  接收端不擅自重连，是为了不把"地址已过期"变成无限重连。
- **没有字幕/音轨切换**，也不支持外挂字幕。
- **有 9 张封面永远下不下来（电脑端的数据问题，不是缓存的问题）**：真机验证时发现，
  86 条收藏里有 9 条的封面地址是**直连 `http://lain.bgm.tv/...`**，而这台设备所在网络把
  `lain.bgm.tv` 解析成了 `31.13.68.169`（一个 Facebook 的 IP，典型的 DNS 污染），
  连接必然超时 —— 日志里能看到
  `SocketTimeoutException: failed to connect to lain.bgm.tv/31.13.68.169 (port 443)`。
  其余 77 条走的是电脑端自己的代理域名（`sankana-bangumi.de5.net`），都能正常缓存。
  **接收端这边已经做了能做的**：明文 http 失败会自动把同一个路径换成 https 再试一次
  （对某些网络有效），失败原因也会写进日志；但要真正修好，
  需要电脑端把那 9 条也走它自己的代理域名（接收端改不了电脑端给什么地址）。
  现在这 9 张会显示占位图，并且按 30 分钟退避重试，不会变成刷屏请求。
- **封面缓存上限 300MB**，超出后按"最久没访问过"自动清理。也就是说：
  如果你很久没打开某个番剧的缓存封面，它可能被清掉，下次显示时会重新下一张
  （这是缓存的正常语义，不是 bug）。想立刻腾干净可以在设置页点「清理图片缓存」。
- **封面缓存只缓存缩略图**：磁盘上存的是缩到 400px 宽、JPEG 质量 85 的版本，
  不是原图。所以它只适合列表里的小格子；如果以后要做"点开看大图"，那需要另存一份。
- **计费网络（移动数据）下不自动预取封面**：只在你真正滚到某张时才按需下载。
  这是刻意的取舍 —— 提前下载是花用户的流量钱。
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

- 已经验证：编译通过、打包通过、协议层/网卡选择/播放列表导航/首页行模型/同步客户端与合并逻辑的自测（见下节）。
- **没有验证**：**未上机**（没有真机，模拟器在本机沙箱里跑不起来，证据见 6.3）；
  电脑端的投屏通道（`cast.ts`）是**读代码对齐**的，
  电脑端的**同步服务这一轮还没有代码**（协议是按需求里给的字段实现的），所以两边都没有真正联调过。
  下面这些都还没有实测：
  - UI 实际观感、**真全屏与手势**的实际效果（刘海区域、边缘上滑唤出系统栏、返回键顺序）；
  - 新控制栏在真机上的排版与手感；
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
.\gradlew.bat clean assembleDebug assembleRelease --console=plain --offline --no-watch-fs
```

结果：

```
BUILD SUCCESSFUL in 3m 55s
78 actionable tasks: 49 executed, 28 from cache, 1 up-to-date
```

- `app\build\outputs\apk\debug\app-debug.apk` —— **5922 KB**
- `app\build\outputs\apk\release\app-release-unsigned.apk` —— **1164 KB**（R8 + 资源压缩，未签名）
- `dist\SakanaReceiver-0.3.8-debug.apk` —— 就是上面那个 debug 包（**文件名保持不变**，
  电脑端设置页里的下载地址指向它），SHA256 `0E8AEEEA1BE5569904324D9C5E96034443ABF5D4387E7A09615784359C479C16`。
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
application-label:'Sakana 投屏接收端'
application-icon-160:'res/mipmap-anydpi-v26/ic_launcher.xml'
launchable-activity: name='app.sakana.receiver.MainActivity'
leanback-launchable-activity: name='app.sakana.receiver.MainActivity'
```

（`WAKE_LOCK` 已按预期不在列表里。）

`aapt2 dump xmltree --file AndroidManifest.xml` 里关于图标与方向的几行：

```
android:icon      = @0x7f0a0000   (mipmap/ic_launcher)
android:roundIcon = @0x7f0a0001   (mipmap/ic_launcher_round)
android:screenOrientation = 10    (fullSensor)
android:configChanges     = 0x00000de0
```

`aapt2 dump resources` 里 `mipmap` 有 4 个条目，说明**旧版（`()`）与自适应（`anydpi-v26`）
两套图标都进了包**：

```
resource 0x7f0a0000 mipmap/ic_launcher
  ()            (file) res/mipmap/ic_launcher.xml
  (anydpi-v26)  (file) res/mipmap-anydpi-v26/ic_launcher.xml
resource 0x7f0a0001 mipmap/ic_launcher_round
  ()            (file) res/mipmap/ic_launcher_round.xml
  (anydpi-v26)  (file) res/mipmap-anydpi-v26/ic_launcher_round.xml
```

### 6.2 协议层自测

编译产物里的 `Json` / `JsonParser` / `Http` / `Proto` / `Lan` / `Reply` /
`SyncModels` / `HistoryMerge` / `SyncClient` / `PlaylistNav` / `HomeRows` /
`CoverKeys` / `CoverLru` / `CoverRequests` 都是纯 JVM 代码
（`Lan` 只用到 `java.net`，`SyncClient` 只用到 `HttpURLConnection`，
封面缓存的三个纯逻辑类只用到 `MessageDigest` 和集合），
所以可以在桌面上直接跑断言，不需要模拟器。
同步那部分还额外起了一个**本地的假 PC 同步服务端**（JDK 自带的 `HttpServer`）做真请求。
用一个临时 Java 测试类加载上面编译出的 class 后执行：

```
==== 121 passed, 0 failed ====    ← 协议 + 同步 + 首页行模型 + 封面缓存 + Activity 接线顺序
==== 71 passed, 0 failed ====     ← 收尾时又对着**最终那一版构建**单独跑了一遍封面缓存与接线部分
```

> 两次都是**对着 `clean` 之后重新编译出来的 class** 跑的，不是对着上一轮的旧产物。
> 第二次只覆盖本轮改过的那部分（缓存键/缩放/LRU/离线回退/退避/并发合流/接线扫描 + 首页与字节格式化），
> 因为收尾时又改了 IO 与界面层（https 重试、诊断日志、首页状态行接线）。
```

> 这是**对着 `clean` 之后重新编译出来的 class** 跑的，不是对着上一轮的旧产物。

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

**首页行模型（本轮新增 —— 对应"收藏翻不动、看不到其它收藏"）**

`HomeRows.build(收藏, 历史, 历史是否展开)` 是纯函数，它决定首页到底要显示哪些行。
断言直接钉住"一条都不能少"：

- **12 条收藏 → 12 个收藏行**；**20 条 → 20 个**；**8 条 → 8 个**
  （用户要求"喂 8 条以上假数据给那条路径"，这里跑了 8 / 12 / 20 三档）。
  这条断言如果有任何截断（比如又写成"只取前 N 条"）会立刻失败。
- 历史折叠时只出 4 个历史行 + 一个「查看全部」行，**收藏仍是 12 行**（历史长不会挤掉收藏）；
  展开后 9 个历史行全出 + 变成「收起」，收藏还是 12 行。
- 历史卡片的封面**按 `subjectId` 从收藏里匹配**（第 3 部 → `https://c/3.jpg`）。
- 空收藏 + 空历史时：两个分区标题都在，两个空态文案都在，收藏行 0 个（不会白屏）。

> 这条数据链路自测只能证明**数据层不丢条目**；真正"能不能滑到"是布局问题，
> 靠的是 `activity_main.xml` 里那个 `layout_height="0dp"` + `layout_weight="1"`
> 的单一 `RecyclerView`（精确高度约束），以及全 `res/layout/` 里除了设置页的
> `ScrollView` 之外**没有任何嵌套滚动容器**（已用检索确认）。这两点合起来才是完整的修复。

**封面缓存（本轮新增 —— 对应"不要每次打开都重新加载"）**

缓存键 / 缩放：

- **同一 URL 永远同一缓存键**，而且键 = **独立实现算出的 SHA-1 前 16 字节**（测试里自己再算一遍做交叉验证，
  不是拿实现去比实现）+ 扩展名；键只含 hex 与扩展名（36 字符）。
- 不同 URL → 不同键（`?v=2` 也算不同）；`.png`（含带 query 的 `xxx.png?imageView2/...`、大写 `.PNG`）
  认成 PNG 存 `.png`，`webp` / 无扩展名归到 `.jpg`。
- `inSampleSize`：800px→2、1000px→2、4000px→8、300px→1（不放大）、宽度非法→1。

容量与 LRU：

- 上限 300MB、清理目标 251,658,240 字节（80%）；**没超软上限（1.2 倍）时一个文件都不删**；
- 三个 40KB 文件、目标 80KB → 只删**最久没访问**的那个（`a.jpg`）；目标 40KB → 删两个；目标 0 → 全删；
- 访问时间撞车时按文件名排序 → **结果稳定**（同样输入两次跑出来一样，测试不会"偶尔失败"）；
- 1000 个 400KB（共 400MB）→ 删到 ≤ 251,658,240 字节，**仍保留 600+ 个**（不是一把全清空），
  删的确实是最旧的 `f0000.jpg`，最新的 `f0999.jpg` 绝不在名单里。

离线回退 / 失败退避 / 并发合流：

- `decideCoverSource`：内存命中 → `MEMORY`；**内存没有、磁盘有 → `DISK`（哪怕 `networkAllowed=false`，
  也就是离线时也拿磁盘的图，这就是"离线不显示空图"）**；两者都没有且不允许网络 → `NONE`（保持占位图）；
  只有都落空且允许网络才 `NETWORK`。
- `CoverRequests`：刚失败 → 60 秒内不发；59 秒仍不发；**满 60 秒又允许**（不会永久拉黑）；
  连续 2 次 → 5 分钟、3 次 → 25 分钟、很多次 → 30 分钟封顶；成功一次清空失败记录；
  不同 URL 互不影响。
- 并发合流：同一 URL 第 1 个调用者拿到发起权，**第 2、第 3 个拿不到**（只会真发一次请求）；
  结束时释放，之后可以重新发起；不同 URL 互不影响；结束后没有残留（不会有地址卡在"正在取"上）。

**Activity 接线顺序（本轮新增 —— 对应真机那次"一打开就闪退"）**

真机日志是 `lateinit property player has not been initialized`（`bindViews:121`），
根因是 `onCreate` 里 `bindViews()` 排在 `player = PlayerController(...)` 之前。
光看行号发现不了（真正用 `player` 的那一行在文件更下面），所以自测里做了一层静态分析：

1. 扫出 `MainActivity` 里所有 `lateinit var`；
2. 对每个函数算出 **needs**（调用它之前必须已赋值的字段 = 它在给自己赋值**之前**读到的那些）
   和 **post**（调用它之后就算就绪的字段），并递归处理它调用的函数；
3. 按行序模拟 `onCreate → onResume → onDestroy`：遇到赋值就记下，遇到"整行开头的函数调用"
   就检查被调函数的 needs 是否都已就绪，然后并入它的 post；
4. 额外显式断言：`player` 的赋值行必须**早于** `bindViews()` 的调用行。

**这条检查不是摆设** —— 把 `MainActivity.kt` 复制一份、把那两行调回错误顺序再跑，
它准确报出 3 个失败（`120 passed, 3 failed`）：

```
FAIL  接线顺序：onCreate() 的前置条件没满足：lateinit `player` 还没赋值
FAIL  接线顺序：onCreate 第 64 行调用 bindViews()，但它需要还没赋值的 lateinit `player`
      （真机上就是 UninitializedPropertyAccessException，v0.3.8 踩过一次）
FAIL  player 先建好、bindViews() 后调（v0.3.8 闪退那个顺序不能反）
```

错误的源码是临时副本，跑完就删了；仓库里留下的只有正确顺序。

> 这个自测脚本是临时文件，验证完已删除，没有留在仓库里。

**自测当场抓出的两个真问题（都已修）**：

1. 本机 Wi-Fi 网卡在 Java 里的名字是 `wireless_32768`（Android 上叫 `wlan0`），
   而最初的类型判定只认 `wlan`/`wifi`，于是它被归类成「其它」，
   自动挑选时会**输给虚拟网卡** —— 这正是"界面显示了一个电脑连不上的地址"那类故障。
   现在同时认 `wireless`，并加了针对虚拟网卡名的减分。
2. `activity_main.xml` 里用 `<!-- ---- 收藏 ---- -->` 这种分隔线注释会被 AAPT 直接拒掉
   （XML 注释里不允许出现 `--`），编译报的就是"ParseError"。

### 6.3 真机验证：本地缓存（vivo V2302A）

设备这次是通过 USB 连着的，所以**这一轮的缓存功能是真机验过的**，不是"只看过代码"。

**a. 安装与冷启动**

```
adb install -r app\build\outputs\apk\debug\app-debug.apk   → Success   （原地覆盖，没有签名冲突）
```

`apksigner verify --print-certs` 的结果与 `dist/` 里已发布包**完全一致**
（SHA-256 `cd9567a9…3a5f`），所以可以直接覆盖安装。
冷启动后 `logcat` 里没有 `FATAL` / `UninitializedPropertyAccessException`。

**b. 封面缓存真的会填、第二次不会再下**

```
I SakanaCoverPrefetch: 封面预取结束：新抓 24 张（已有 41 / 正在取 7 / 冷却中 0 / 失败 8），共 80 个候选
I SakanaCoverPrefetch: 封面预取结束：新抓 0 张（已有 70 / 正在取 2 / 冷却中 6 / 失败 2），共 80 个候选
```

第二轮 **新抓 0 张、已有 70 张** —— "已有的一个都不许重复抓"是真机验证过的，
`正在取 2` 还顺带证明了并发合流（预取与界面抢同一张时只有一边发请求）。

**c. 离线也走缓存、且一个新请求都不发**

断掉 Wi-Fi/数据（`ip addr` 无地址、ping 不通）后冷启动：

```
盘上文件数 = 71（启动前）→ 71（20 秒后），总字节 8808 KB → 8808 KB    ← 没有新增任何文件
I SakanaCover: 封面命中磁盘缓存：b14027bd7fb0515af0d669592dda1542.jpg
I SakanaCover: 封面命中磁盘缓存：e68bf0c3d837934bb2a5a797463f5705.jpg     （共 8 条命中）
I SakanaCover: 封面既无缓存也不允许请求（离线或失败冷却）：http://lain.bgm.tv/...
```

- 8 张**从磁盘命中**（这就是"离线也显示封面"的直接证据）；
- 2 张本来就没缓存，离线时**没有发请求**（`NONE` 分支），保持占位图；
- 全程 **0 个新文件**，证明"离线不会重新加载"。

截图对比（同一次安装、都离线）：空缓存时**两格封面区域的像素完全一致**
（均值 `[170,180,185]`、标准差 `106.3/94.2/88.7` 完全相同 → 都是同一张占位图），
热缓存时两格**明显不同**（`[225,229,234]` vs `[230,233,238]`，去重颜色 190 vs 430 → 两张不同的真封面）。
截图留在 `screenshots/`（`home-offline-warm-cache.png`、`cover-cache-settings.png`）。

**d. 设置页的数字是真的**

`uiautomator dump` 读到的原文：

```
封面缓存：77 张 · 8.4 MB · 缓存于 刚刚
收藏 86 条 · 历史 16 条
缓存于 01:28
```

同一时刻设备上 `ls -l cache/covers`：**77 个文件、8,844,695 字节 = 8.4 MB** —— 与界面完全对得上，
说明那两个数字是现扫目录算出来的，没有写死。

**e. 「清理图片缓存」只清图片**

点「清理图片缓存」→ 确认 → 磁盘 **77 → 0**，界面变成"封面缓存：还没有缓存"，
而 `shared_prefs/sakana-sync.xml` 里的 `favorites-json`（39 KB）与 `history-json` **原样保留**
—— 收藏和历史没被动过。

**f. 真机发现并修掉的两个问题**

1. **首页的同步状态行是"死"的**：`activity_main.xml` 里 `tv_sync_status` 写死了
   `android:text="未连接电脑 · …"`，而**没有任何代码去改它** —— 所以不管同步到没到、
   缓存了没有，首页永远显示"未连接电脑"。真机上对比设置页才发现（设置页那行是动态的）。
   现在 `HeaderBinder` 接上了 `syncStatusText`，首页与设置页共用同一份判断。
2. **9 张封面永远下不下来**：见"已知限制"里的 DNS 污染那一条。顺手把失败原因从 `Log.d`
   提到 `Log.i`（vivo 会把 DEBUG 日志丢掉），并把 http 失败自动换成 https 重试一次 ——
   没有这个日志，这个问题在真机上根本查不出来。

**g. 仍然没验到的**

- 内存 LRU 的字节上限（32MB / 1/8 堆）在真实压力下的表现 —— 需要看几百张图的滚动；
- 磁盘 300MB 上限触发清理 —— 真机缓存只有 8.4MB，没到过上限（淘汰逻辑只有纯逻辑断言 + 1000 文件模拟）；
- **计费网络下不预取**这条 —— 设备当时在 Wi-Fi 上，没有切到移动数据实测；
- 预取在界面销毁时被取消（`onDestroy`）—— 没有构造"正好在预取时退出"的场景。
  这三条目前只有代码与自测断言支撑，没有真机证据。

### 6.4 早先的构建环境记录（"当时为什么验不了"）

> **状态更新**：真机后来接上了（vivo V2302A），界面/播放那部分见 6.5 节、
> 本地缓存那部分见 6.3 节。本节保留的是更早一轮"模拟器跑不起来"的环境记录
> （沙箱只允许写工作区 + 没有硬件加速），对以后要在同样环境里跑的人还有用。

**当时的结论是：未上机验证**（下面附完整证据，不是"没试"）。

- **没有真机安装与运行**（本机没有连接安卓设备）。
- **模拟器也跑不起来**，试过两条路，都卡在同一处：
  1. 直接用已有的 AVD：
     ```
     ERROR | avdInfo_setLastRunQemuVersion: Could not write file:
             C:\Users\RE妄想症\.android\avd\..\avd\sakana.avd\qemu-version.txt
     ERROR | Unexpected error while creating:
             C:\Users\RE妄想症\.android\emu-last-feature-flags.protobuf.lock (error: 5)
     ```
     原因：本机沙箱只允许写 `E:\sakana.app` 下面，模拟器坚持要写用户目录，`error: 5` 就是拒绝访问。
  2. 把 `ANDROID_AVD_HOME` / `ANDROID_USER_HOME` / `LOCALAPPDATA` / `TEMP` 全重定向到
     工作区里，新建了一个小 AVD（2 核 / 2048 MB）后 `qemu-system-x86_64-headless` **确实起来了**
     （约 9 分钟 CPU 打满），但：
     - `adb devices` 里**始终不出现**这个设备；
     - `adb connect localhost:5555` → `cannot connect to 127.0.0.1:5555 ... (10061)`；
     - `emulator-check accel` → `Unable to open AEHD device: ERROR_ACCESS_DENIED (code 11)`，即没有可用的硬件加速；
     - 本机 SDK 里没有 `cmdline-tools` / `avdmanager`。
  所以**没有截图、没有看到过任何画面**。上面那些模拟器进程与临时目录都已清理。

- **因此下面这些只看过代码，没看过实际效果**（本轮改动集中在这里，请上机重点看）：
  - 自写控制栏在真机上的排版：进度条拖动、按钮在窄屏/刘海屏下是否挤在一起；
  - 手势：双击累加 seek 的手感与提示气泡、左右半边亮度/音量、水平拖动 seek 的跟手程度；
  - 真全屏：`shortEdges` 下刘海区域、边缘上滑唤出系统栏、返回键"先退全屏再退播放"的顺序；
  - 「铺满 / 适应」切换的实际画面差异；
  - 白蓝配色在深色模式系统下的观感（主题是 `Theme.Material.Light`，未做深色适配）；
  - 启动图标在桌面/抽屉里的实际显示（自适应图标的圆形裁切、圆形图标）；
  - 历史卡片的相对时间文案、长按详情/删除的交互。
- **没有和电脑端真正联调**：
  - 投屏侧只能读 `cast.ts` / `castRelay.ts` 对齐；
  - **同步侧电脑端这一轮还没有代码**（`/sync/*` 是按需求里给的字段与响应形状实现的），
    所以端口 `52890`、字段名、`play-subject` 的返回都**没有被真实验证过**。
  - 电脑端是否真的收到了接收端**主动宣告**（USB 共享网络场景的关键路径）；
  - 电脑端同步服务是否真的在 `52890`（否则自动连接的第 3 条路径失效，投屏一次即可恢复）；
  - `headers`（Referer/Cookie）是否被目标 CDN 接受、HLS 分片是否顺畅；
  - 规则模式下"电脑端换集后重新投屏"这条链路；
  - 点收藏后电脑"选源→嗅探→投回"整条链路，以及失败时 `message` 的显示。
- 按需求**没有**申请前台服务相关权限，所以"锁屏/切后台后接收端还活着"这件事**做不到**，
  这是刻意的取舍（见"已知限制"）。

### 6.5 真机验证：控制栏显隐与两个出口（vivo V2302A）

**0) 像素级验收（用户点名的那套方法，本机也跑了一遍）**

投一段**纯绿静态** HLS（`green.m3u8`，640×360，60 秒），全程**不做任何触摸**，
t≈2 秒与 t≈9 秒各截一张图，再用 `.e2e/png-count.mjs` / `png-diff.mjs` 数像素。
本机在**当前构建**上的结果：

| 场景 | 全屏"蓝色 UI 像素" | 工具结论 |
| --- | --- | --- |
| 投流后 2 秒 | **2359**（占 0.067%） | 控制栏可见 |
| 静置到 9 秒 | **0** | 控制栏不可见 |
| 静置 8 秒 | 0 | 控制栏不可见 |
| 点一下画面后 1 秒 | 6319 | 控制栏可见 |
| 之后再静置 6 秒 | 0 | 控制栏不可见 |

绿占比一直是 42%–80%（画面真的在播，横屏 2800×1260 全屏成立）。

> **关于"顶栏看不到"**：顶栏是**白字白图标 + 半透明黑底**（`player_bar #B3000000`），
> 里面**一个蓝色像素都没有**，所以"顶部没有蓝色"并不能说明顶栏不在。
> 换个量法（本机自检脚本 `bands.mjs`，按横条统计近白/近暗像素）就能看到它：
> 显示时顶部 16% 那条是 `avg=[4,42,4]`、近暗 98.1%、近白 1.53%（白字白图标）；
> 隐藏时同一区域是纯绿 `avg=[0,129,0]`、近白 0%。
> 也就是说：**控制栏显示的时候，顶栏（标题 + 退出全屏 + 退出播放）确实在屏幕上、点得到**；
> 它只是跟着整条控制栏一起在 4 秒后自动隐藏 —— 点一下画面就回来（见上表最后三行）。

**a)「控制栏永远不隐藏」的真因（两个，互相独立）**

真机日志 + 反编译 media3-ui 1.11.1 字节码一起定位到两条：

1. **每秒给 `controllerShowTimeoutMs` 赋值 = 每秒把 4 秒倒计时重置一次**（主因）：
   `PlayerView.setControllerShowTimeoutMs(t)` 内部是
   `if (controller.isFullyVisible()) showController()` → `PlayerControlView.setShowTimeoutMs(t)`
   → `if (isFullyVisible()) resetHideCallbacks()`，也就是取消并重新开始倒计时。
   而 `MainActivity` 的心跳（1 秒）每次都调 `setPlayerMode`，上一版就在它里面写这个字段 ——
   倒计时永远到不了 4 秒。
2. **Media3 自己的淡入动画状态机会卡住，卡住之后 `hide()` 只隐藏进度条**：
   `PlayerControlViewLayoutManager.hide()` 的分支是
   `uxState==3||==2 → return`；`!animationEnabled → 立即隐藏`；
   `uxState==1 → hideProgressBar()`（**只隐藏进度条，顶栏底栏留着**）；否则 `hideAllBars()`。
   `isFullyVisible()` 要求 `uxState == 0`，而 `show()` 先把 `uxState` 置 1、
   **等动画结束回调**再置回 0；进播放层时紧接着的横屏切换会打断这段淡入动画，
   回调不再执行 → `uxState` 停在 1 → 永远走 `hideProgressBar()`。
   修法：`playerView.setControllerAnimationEnabled(false)`。

**b) 现在的规矩：一个计时器 + 只在状态跃迁时动手**

`PlaybackControls`（唯一持有计时器）+ `ControlsPolicy`（纯逻辑 `controlsAction`）：
同一种状态重复出现一律 `NONE`，"每秒续命"在结构上不可能发生。
`logcat -s SakanaControls` 真机实测原文：

```
02:31:49.810  安排 4000ms 后隐藏控制栏          ← 进播放层
02:31:50.126  状态跃迁 playing -> AUTO_HIDE
02:31:54.126  控制栏隐藏（hideController 前 isFullyVisible=true）  ← 播放中静置 4 秒后真的消失了
02:31:57.950  状态跃迁 paused -> PIN                               ← 暂停 → 常显
（暂停后 9 秒内没有任何「控制栏隐藏」→ 一直可见）
02:32:07.108  状态跃迁 playing -> AUTO_HIDE
02:32:11.109  控制栏隐藏（isFullyVisible=true）                    ← 恢复播放后 4 秒隐藏
```

点一下画面 → `安排 4000ms…`（show 路径被调用），4 秒后又隐藏；
播完（`ended`）→ `PIN`，静置 9 秒仍可见；拖进度条 → `TimeBar.OnScrubListener` 每次回调都重新计时。

**c) 顺带修掉的两个「死代码」级问题**

- **手势层从来没收到过触摸**：`gesture_layer` 在布局里排在 `player_view` 前面，而 FrameLayout 里
  后声明的在上层，`player_view` 又是 clickable 的（dump 里 `clickable="true"`），
  它在 ACTION_DOWN 就把事件吃掉了 —— 双击快进、左右滑动调亮度/音量、水平拖动 seek、
  长按 2 倍速**全部**没生效过。现在手势同时挂到 `playerView.setOnTouchListener`
  （ViewGroup 派发时先给子 View，控制栏按钮照旧优先）。实测水平拖动把进度从前拉到后 **+17.5 秒**。
- **`durationMs` 无限递归**：`override val durationMs: Long get() = durationMs` 解析成它自己，
  一读就 `StackOverflowError`。因为手势从没被触发过，这个雷一直没炸 ——
  手势刚接通，真机一拖进度就崩（`-b crash` 里 12 层 `getDurationMs(PlaybackUi.kt:71)`）。
  改成 `this@PlaybackUi.durationMs`。

**d) 顶栏两个出口**

「退出全屏」（`btn_exit_fs`，只在全屏时显示）+「退出播放 ✕」（`btn_exit_play`），
都是图标 + 文字 + `contentDescription`。✕ 走 `MainActivity.exitPlayback()`，
**与返回键第二步是同一个方法**（`control("stop")` → 退全屏 → 回首页层，顺带收起控制栏与气泡）。
返回键顺序不变：先退全屏 → 再退出播放 → 最后才退应用。

**e) 仍然没验到的**

- **✕ 按钮的点击**没在真机上点过：`uiautomator dump` 在这个状态下读不到控制栏里的节点
  （同一段 dump 有时有、有时没有，不可靠），拿不到坐标去点。它的逻辑与返回键第二步
  共用同一个方法，静态断言（54 条）已覆盖。
- 「退出全屏」点击后的竖屏外观、以及返回键「先退全屏再退播放」的两段式，本轮没逐步验证。

---

### 6.6 真机验证：界面 / 播放 / 收藏滚动（v0.3.8 补充轮，vivo V2302A / 1260×2800）

设备通过 USB 连上后逐项验的，命令与证据都留在这里，便于复现。
**a. 发现并修掉一个致命回归：一打开就闪退**

```
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: Process: app.sakana.receiver
E AndroidRuntime: java.lang.RuntimeException: Unable to start activity
    ComponentInfo{app.sakana.receiver/app.sakana.receiver.MainActivity}:
    kotlin.UninitializedPropertyAccessException: lateinit property player has not been initialized
E AndroidRuntime: 	at app.sakana.receiver.MainActivity.bindViews(MainActivity.kt:121)
E AndroidRuntime: 	at app.sakana.receiver.MainActivity.onCreate(MainActivity.kt:56)
```

原因是 `bindViews()` 排在建 `PlayerController` 之前，而新的 `PlaybackUi` 构造要拿 `controller`。
修法是把 `playerView` / `player` 的创建提到 `bindViews()` 之前（见 `MainActivity.onCreate` 的注释）。
**这条也说明：离线断言（89 项）挡不住"Activity 接线顺序"这类错误，以后每次改完都必须真机冷启动一次。**

**b. 安装校验（同一把 keystore 才能原地覆盖）**

```powershell
adb -s <序列号> install -r app\build\outputs\apk\debug\app-debug.apk   # → Success
```

换错 keystore 时会得到 `INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`
（见 1.3 节那把仓库内密钥）。

**c. 冷启动不闪退 + 同步真的生效**

```
I ActivityTaskManager: Displayed app.sakana.receiver/.MainActivity for user 0: +580ms
```
设置页（`uiautomator dump` 读到的真实文案）：
`已连接 DESKTOP-IOV63P6 · 02:24 前同步 · 收藏 86 · 历史 14`、`同步地址：http://192.168.1.8:52890`、
`服务状态：运行中`、`当前监听端口：52889`、`当前网卡：wlan0 · 192.168.1.4（Wi-Fi）`。

**d. 收藏"翻不动"已修（用户报的原始问题）**

滑动前后各 `uiautomator dump` 一次，可见条目**完全不同**：

| | 可见收藏 |
|---|---|
| 滑动前 | Little Busters! / 〜Refrain〜 / EX / 败犬女主太多了！ |
| 向上滑两屏后 | 感谢对战。～大小姐才不玩格斗游戏～ / BanG Dream! YUME∞MITA / 超辉夜姬！ / 上伊那牡丹… |

说明列表真的在滚、86 条都能翻到（改前是 `ScrollView` 套 `wrap_content` 的 RecyclerView，
只创建"装得下"的那几条，永远翻不到后面）。

**e. 播放与真全屏（用本机测试源投给手机，不动电脑端会话）**

```powershell
# 本机起测试 HLS 源（.e2e/hls-test 下已有 test.m3u8 + 分片）
node .e2e/cast-src-server.js 8791
# 直接调接收端控制接口（curl --noproxy 绕过系统代理，否则会被代理拦成 502）
curl.exe --noproxy "*" -H "Content-Type: application/json" `
  --data-binary "@.e2e/play-test.json" http://192.168.1.4:52889/play       # → {"ok":true}
curl.exe --noproxy "*" http://192.168.1.4:52889/info
# → {"playing":true,"positionMs":5477,"durationMs":12000,"index":0,"total":2,
#    "titles":["第 1 集","第 2 集"],"state":"playing"}
curl.exe --noproxy "*" -H "Content-Type: application/json" -d '{"action":"stop"}' `
  http://192.168.1.4:52889/control                                          # → {"ok":true} → state:"idle"
```

播放中 `adb shell screencap -p /sdcard/p.png`（**别用 PowerShell 的 `>` 重定向，会把 PNG 写坏**）
再 `adb pull`，用自写的 PNG 读数器量像素：

- 截图 **2800×1260**（首页时是 1260×2800）→ **横屏全屏生效**；
- 画面中心平均色 `[128,128,127]`（测试图是灰阶）→ **视频真的在渲染**，不是黑屏；
- 左上角区域 `[25,9,9]`，没有状态栏白底 → **系统栏确实被藏起来了**。

**f. 仍然没验到的**

- 手势手感（双击累加、左右半边亮度/音量、横滑 seek）、控制栏在真机上的排版与刘海区表现；
- 「铺满 / 适应」的实际画面差异、深色系统下的观感、自适应图标在桌面的圆形裁切；
- **点收藏 → 电脑"选源 → 嗅探 → 投回"** 整条链路（要占用用户的电脑端会话，没在这次自检里跑）；
- 锁屏/切后台存活（按取舍没有前台服务，做不到）。
