# Sakana 🐟

番剧管理及播放桌面客户端。Electron + Vite + React + TypeScript。

## 功能

- **番剧表**：bangumi 数据源（默认 bangumi.pro 镜像，支持镜像降级 + 代理提示），周历切换、缓存优先、卡片快捷收藏、评分按需补全
- **仪表盘**：订阅/收藏/工具统计、更新动态、观看与订阅历史、下载任务、时间段分布与**收藏类型分布**圆环、**年度统计横向柱状图**、继续观看
- **订阅**：蜜柑计划 RSS 资源选择（字幕组/集数/大小/日期）、「下载」=订阅+下载 /「订阅」=仅追踪该字幕组、启动自动检测新资源（需确认后下载）、无订阅的已下载资源也显示卡片
- **下载**：内置 aria2（JSON-RPC）或外部 qBittorrent（Web API）；种子先下载再解析；完成后按 `番剧名 字幕组 第XX集.后缀` 重命名；并发数可配置；失败可重试；完成后进度条消失、可直接播放
- **收藏**：按年份分组、垂直年份条拖动定位、全源搜索（回车/按钮触发）、重点关心列表、**「已看完」标签**（观看记录覆盖全部集数自动判定 / 详情页手动标记并显示看完时间）、收藏时后台补全放送年份（修复当年番剧误判未知年份）
- **工具**：导入 Python 脚本（`--sakana-data` / `SAKANA_DATA` 数据接口）、界面内运行、一键导出开发要求文档（MD/TXT）、**内置统计工具 v0.1**（收藏番剧条目管理：序号 202601/个人评分与 bangumi 评分偏差/剧照 1-3/评价 1-3/看完时间）
- **在线播放规则**：Kazumi 风格规则引擎（XPath 栈 xpath-html / API 栈 JSONPath），独立规则配置页，内置 AGE、aafun、TvTFun、7sefun，**支持从 Kazumi 规则仓库导入**（gitcode 镜像优先、GitHub 兜底）；播放流程「规则搜索 → 选集 → 隐藏窗口加载播放页 → 嗅探捕获视频流 → libVLC 直连播放」，用户看不到网页，失败自动回退 iframe
- **播放器**：双播放内核，同一套控制栏，可在「设置 → 播放器设置」切换。**libmpv（默认，推荐）**：项目自带 N-API 原生插件（`native/mpv`）动态加载 `libmpv-2.dll`，在主窗口内创建 WS_CHILD 输出子窗口（含 z 序提升，否则画面会被页面内容盖住而黑屏），渲染层只上报视频区域矩形，因此控件/选集/字幕 UI 与 libVLC 完全一致；**libVLC**（electron-vlc-player）作为兼容性备选，libmpv 不可用时自动回退。**画面比例**支持适应 / 裁剪铺满 / 拉伸铺满三态（控制栏与设置页均可切换）；**全屏时画面铺满整屏，控制栏由独立透明悬浮窗叠加在画面上**（原生窗口无法被网页内容覆盖）。两者均支持 MKV / HEVC / 10bit / 杜比音轨 / 内封与外挂字幕，内建 zh-CN 控制条（音轨/字幕切换、进度、倍速）；内核全部不可用时回退 FFmpeg 转码管线 → HTML5；**控件 5 秒自动隐藏、按钮 pointerdown 加固、截屏移至右侧、详情面板布局同步、可自定义快捷键**（设置 → 播放器快捷键）
- **设置**：5 套主题配色、数据源独立配置页、代理/下载器/路径配置、错误日志（可复制）
- **系统托盘**：关闭时询问「最小化至托盘 / 直接退出 / 取消」；托盘悬浮显示小窗（下载任务可暂停/继续、统计、观看历史）；双击回主界面、右键退出
- **订阅检测**：已存在下载任务的资源不再重复提示；下载完成自动推进订阅的集数与资源日期；无新资源时订阅状态自动复位
- 全部数据本地 JSON 缓存（方案允许 SQLite/JSON，当前 JSON 原子写入），网络请求带超时

## 开发

```bash
npm install          # 首次安装（自动编译 libVLC 原生模块，需 VS Build Tools + Python 3）
npm run dev          # 开发模式（HMR）
npm run typecheck    # 类型检查
npm run build        # 构建
npm run libvlc:fetch # 下载内置 libVLC 运行时（VLC 3.0.x）到 resources/libvlc/（libVLC 内核用）
npm run libmpv:fetch # 下载 libmpv-2.dll（mpv v0.41）到 resources/libmpv/（默认内核，推荐）
npm run mpv:build    # 编译 libmpv 原生插件 → native/mpv/build/Release/sakana_mpv.node（需 VS Build Tools）
npm run ffmpeg:fetch # 下载内置 FFmpeg 到 resources/ffmpeg/（转码回退方案用，可选）
npm run aria2:fetch  # 下载内置 aria2c.exe 到 resources/aria2/（可选）
```

> 注：
> - 本仓库使用 npmmirror 镜像源（`.npmrc`）。
> - **默认播放内核为 libmpv**：需要 `npm run libmpv:fetch`（libmpv-2.dll，约 115MB）与 `npm run mpv:build`（原生插件）；两者缺任一项时自动回退 libVLC。
> - **libVLC 内核（备选）**：运行 `npm run libvlc:fetch` 下载（约 40MB），或安装系统 VLC（自动探测 `C:\Program Files\VideoLAN\VLC`）。
> - `electron-vlc-player` 的原生模块（vlc_binding.node）在 `npm install` 时针对本机 Electron 版本编译，需要 Visual Studio Build Tools（C++ 桌面开发）与 Python 3。
> - 如未安装内置 aria2c，可在「设置 → 下载器配置」中指定 aria2c.exe 路径，或改用 qBittorrent。

## 目录结构

```
src/
├── main/            # Electron 主进程（窗口、存储、IPC、服务）
│   ├── services/    # bangumi / mikan / aria2 / qbit / 下载管理 / 媒体协议 / Python 工具
│   │                # vlc.ts（libVLC）、mpv.ts（libmpv）、playerEngine.ts（内核调度 + 自动回退）
│   └── lib/         # 标题解析、命名规则
├── preload/         # contextBridge 类型化桥接
├── shared/          # 主/渲染共用类型与 IPC 契约
└── renderer/        # React 界面（页面、组件、状态、主题）
native/
└── mpv/             # libmpv 原生插件（N-API，纯 C）：src/addon.cc + binding.gyp
resources/           # 内置运行时（libvlc / libmpv / ffmpeg / aria2，体积大不入库，见 fetch 脚本）
```

## 数据与缓存

- 应用数据：`%APPDATA%/sakana/data/*.json`（设置、收藏、订阅、历史、日志等）
- 网络缓存：`%APPDATA%/sakana/cache/`（番剧表 30 分钟、详情 7 天、图片磁盘缓存）
- 下载目录：设置中配置，自动按番剧名建子文件夹

## 数据源

| 用途 | 地址 | 状态 |
|------|------|------|
| 番组计划(伪) | https://bangumi.pro/ | ✅ 默认源（网页镜像，HTML 解析） |
| 备用镜像 | https://bangumi.lol | ⚠️ 当前不可用（候补） |
| bangumi 主站 API | https://api.bgm.tv/ | 需代理（设置中配置） |
| 蜜柑计划 | https://mikanani.kas.pub/ | RSS 订阅数据源 |

### 数据源实现说明

- **bangumi.pro 是 bgm.tv 网页的克隆站，不提供 JSON API**，且有 Cloudflare 防护（非浏览器 UA 会被 403）。因此应用使用**浏览器 UA + HTML 解析**：从 `/calendar`（番剧表）、`/subject/{id}`（详情）、`/subject_search/{kw}?cat=2`（搜索）页面提取结构化数据。
- 镜像列表**并行尝试**（首个成功者生效）；API 镜像（`api.` 开头）自动走 v0 JSON 通道，网页镜像走 HTML 解析。
- 番剧表 30 分钟 / 详情与评分 7 天磁盘缓存；日历页本身不含评分，进入某天时按需从详情页补全评分（并发 4、7 天缓存）。
- 图片经 `sakana-img://` 协议加载（磁盘缓存），图床域名 `lain.bangumi.pro`。
- 全部镜像失败时按方案 3.10 弹出「是否开启 VPN / 配置代理」提示。

## 文档

- `docs/项目说明书.md`：**逐文件夹、逐文件的详细项目说明书**（架构、播放子系统、规则引擎、数据存储、构建打包、`SAKANA_*` 自检开关全表、排障步骤、术语表）。
- `docs/代码审计.md`：全项目代码审计报告（高危/中危/轻微问题清单，均含 `文件:行号` 依据与建议修法）。

## 更新记录

### 0.2.3

- **在线播放捕获（本轮核心）**：akianime / baimao / sorani / 7sefun 这类「能搜到番剧、能解析剧集，却始终抓不到流」的站点已修好。两个根因：
  1. 嗅探宿主用的是 `WebContentsView`，在本项目里 **CDP 事件恒为 0**（日志里一直是 `累计 CDP 事件 0`）→ 换成独立的**屏幕外可见窗口**（`x:-4000`、`skipTaskbar`、`focusable:false`、`backgroundThrottling:false`）承载播放页，CDP 立刻恢复（实测单次捕获 121~490 条事件）；
  2. CDP 的 `Network.enable` 握手会一直不返回，把页面加载整个卡死 → 改成 **1.5s 超时竞速**，握手慢也照常加载。
- **播放器外壳解包**：baimao 捕获到的其实是**播放器页面地址**（`…/player/artplayer/index.html?url=<真实 m3u8>`），把 HTML 交给内核当然播不了。现在自动从 `url / v / video / src / file` 查询参数里取出内层媒体地址再播放。
- **主进程崩溃修复**：规则嗅探 / 播放内核发事件时会读 `undefined.isDestroyed()`（窗口已销毁或尚未挂载时），抛出未捕获异常，**整个应用直接退出**；实测在 ezdmw 的网页渲染回退处必崩、在 tvtfun 播放页也触发过。`ruleProbe` / `vlc` / `mpv` 三处事件发送统一补判空。
- **XPath 引擎两处通用修正**（ezdmw 暴露）：
  - 联合表达式 `A | B | C` 现在**逐分支**转相对路径（此前只有第一分支被处理，其余仍是绝对路径，相对条目求值恒为空）；
  - 轴步里的标签名也加 x: 命名空间（`following-sibling::a` 此前保持无命名空间，而文档元素都在 `x:` 下 → 恒为空）。
  - 另加站点定点修复：ezdmw 的 `//section[@class='anthology'][1]/div[…]` 在 XPath 1.0 里是「父节点下第一个 section」而非「结果集第一个」，命中的是另一处 section → 线路恒为 0 条；改按线路按钮类名直取，并剔除空线路（该站首个 `line_button` 是隐藏占位符）。**实测 4 条线路 / 48 集解析成功**、能正常走到播放页；但该站播放页的流仍然嗅探不到，**这是本轮未解决的遗留项**。
- **7sefun 规则修正**：搜索卡片标题改取 `div.video-by`（原先取空锚文本 → 列表没有标题）；剧集容器与线路标签是兄弟节点，改用 `{n}` 位置配对，服务端 HTML 即可解析。另外确认「败犬女主太多了 搜索无结果」是该站**确实没有这部番**（《从零开始的异世界生活》同站点返回 9 条），不是规则问题。
- **自检增强**：`SAKANA_ONLINE_TEST` 支持逗号分隔的多个关键词，一次运行覆盖多部番剧。
- 实测（0.2.3，libmpv 内核、直连）：
  - 《败犬女主太多了》→ baimao 1471s、akianime 1440s、sorani 1440s **全部「搜索→剧集→播放页→捕获→播放成功」**；
  - 《从零开始的异世界生活》→ baimao 1757s、akianime 1420s；
  - 樱之空 1465s（8 线路 / 96 集）；
  - 仍不可用的为站点侧问题，非规则错误：AGE 的剧集源站 `23.224.60.155/156:80` 在本机网络不可达（ETIMEDOUT）；DM84 源站返回 522；dalvdm 搜索跳首页；gugu3 / mgnacg 偶发「安全验证」拦截页；mikan 偶发 15s 超时。

### 0.2.2

- **在线播放规则大面积修复**：
  - 剧集列表增加「网页渲染解析」回退：AGE / aafun / moonci / ezdmw / gugu3 这类站点的选集由 JS 渲染，纯 HTTP 抓不到 → 现在用真实浏览器窗口渲染后再求值（并在页面内轮询等待 XHR 填充）。
  - 相对 XPath 求值修正：支持 `/self::*[...]/following-sibling::a` 这类「单斜杠相对表达式」（ezdmw 风格），此前会被当作绝对路径，结果恒为空。
  - 搜索增加一次 HTTP 重试（部分站点会偶发返回"加载中/安全验证"拦截页），并修正网页内搜索未带浏览器 UA 的问题。
  - 播放页支持 MacCMS `player_aaaa` 的 **encrypt:2（base64 + 百分号编码）** 直出解码——樱之空等站点此前必须依赖网页播放器。
  - 线路名配对：新增可选 `lineNameXPath` 与 `episodesXPath` 的 `{n}` 占位，解决「线路名标签与剧集盒子是兄弟节点」时线路名取到站点提示语的问题。
  - 规则仓库全量同步（16 条）到最新定义；镜像链改为 jsDelivr 优先的并发竞速。
- **新增内置规则「樱之空」**（`skr.skrcc.cc:666`），实测搜索 → 8 条线路/96 集 → 捕获 m3u8 → 播放 1465s 全链路成功。
- **MXdm 贴片广告自动剔除**：实测该类流把广告作为**独立分片拼进 m3u8**（用 `#EXT-X-DISCONTINUITY` 标出，中插 16.5s + 尾部 17.7s，且所有集数完全相同）。新增本机播放列表改写代理（`hlsAdFilterCore.ts` / `adFilter.ts`），只改写播放列表、分片仍直连 CDN，保守闸门（仅 VOD、4~30s 区段、删除量 ≤10% 且 ≤120s、至少留 120s 正片）保证「宁可放过不误删」；可通过设置项 `hlsAdFilter` 或 `SAKANA_AD_FILTER=0` 关闭。实测：跳过 9 片/34.1s，时长由 1476s 变为 1442s，播放正常。

### 0.2.1

- **订阅即时生效**：订阅数据改由主进程作为唯一写入方，任何变更（新建订阅、集数推进、删除、改目录）都会广播给所有窗口；修复「订阅后卡片要重启应用才出现」。
- **下载可见性**：内置 aria2 增加公共 tracker 与 DHT/PEX/LPD 参数；复用残留实例时同步关键参数；卡片在「已连上但还没有做种者」时明确提示而不是干等 0%；aria2 错误码一并展示。
- **规则仓库导入**：镜像链改为并发竞速（jsDelivr / ghproxy / GitHub / gitcode）并校验返回确实是 JSON；实测 jsDelivr 最快可用，gitcode 已不再提供 raw 文件（返回 HTML，现自动跳过）。
- **播放列表健壮性**：跳过 0 字节与 `.part/.aria2/.!qb` 未完成文件，避免播放器去播未下载完的文件。
- 审计问题修复：原生插件 UTF-8 路径转换（中文安装目录下 libmpv 现在可加载）与字符串越界写；内核回退后不再错配调用；下载完成与订阅状态的同步顺序；webRequest 嗅探监听改为共享单实例（两套嗅探不再互相覆盖）；`store.get()` 返回副本（防缓存被原地污染）；下载轮询加互斥；自定义协议限制在白名单目录内读取；统计导出画布高度上限；qBittorrent 并发添加任务错配。
- 版本号统一：设置页/关于页改为从主进程读取 `package.json` 版本，不再各自硬编码。

### 0.2.0

- 画面比例三态（适应 / 裁剪铺满 / 拉伸铺满），双内核均支持。
- 全屏时画面铺满整屏，控制栏改由独立透明悬浮窗叠加在画面上。
- 副窗口空白加固：加载失败/渲染进程崩溃自动重载或重建，路由兜底页，启动异常可见化。
- 应用图标更换；新增 `docs/` 说明书与审计报告。

## 路线图（已预留）

- 弹幕（播放器按钮已预留）
- 应用版本自动更新检查（设置项已预留）
- 多语言（中/英）
- 收藏的并发写入收敛（订阅已完成；收藏仍为多窗口整数组回写）
- 中转流的自动续接（FFmpeg 转完后从断点接力，避免长视频播到缓冲尽头即止）
