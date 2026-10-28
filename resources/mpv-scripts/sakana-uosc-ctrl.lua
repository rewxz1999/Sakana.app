--[[
Sakana · uosc 控制栏桥接脚本（v0.2.18「用 uosc 接管控制栏」）

作用：把 uosc 的按钮/菜单与 Electron 应用接起来。分成两个方向：

  应用 → mpv（状态下行）
      `script-message sakana-state <json>`
      应用把控制栏需要的状态（番剧名/副标题/当前集/线路/字幕表/倍速/比例/弹幕设置…）
      推给本脚本；脚本据此
        ① 更新按钮的图标/激活态/角标/是否可点（uosc `set-button`）
        ② 写 user-data/sakana-subtitle（uosc 顶栏第二行标题用它，uosc.conf 里配的
           `top_bar_alt_title=${user-data/sakana-subtitle}`）
      状态只在变化时下发，不是每帧推送，所以没有性能负担。

  mpv → 应用（动作上行）
      `script-message sakana-ctrl <动作> [参数…]`
      由 uosc 的按钮 / 菜单项 / input.conf 快捷键发出。脚本把它们写进
      mpv 属性 `user-data/sakana-ctrl`，Electron 主进程的 250ms 状态泵读到新值就
      转成应用的 OverlayAction 派发给播放页，然后清空。
      为什么用「属性 + 轮询」而不是 `--input-ipc-server`：
        - libmpv 里再开一条本机命名管道，等于多一条任何本机进程都能连的控制通道，
          而需求只是「点一下按钮要生效」，250ms 完全够用；
        - 属性通道不需要改原生插件、不需要新端口，随包分发零风险。
      （若将来要把延迟压到 0，换成 input-ipc-server 只需改 emit() 与主进程的读取处。）

  菜单
      `script-message sakana-menu <菜单名>`（按钮/快捷键也走 `sakana-ctrl menu <名字>`）
      脚本用 uosc 的 `open-menu` 接口现场生成菜单（绘制、搜索、键盘导航都由 uosc 负责）。
      菜单项的 value 是**一条 mpv 命令**（uosc 的 lib/menus.lua 用 mp.commandv 执行），
      所以每项都写成 `script-message sakana-ctrl <动作>`，与按钮完全同一条路。

动作约定（与 src/main/services/mpv.ts 的 uoscActionToOverlay 映射表一一对应）：
    play-pause / prev-episode / next-episode / back10 / forward10
    select-episode <line> <ep>      一次搞定切线路+切集（应用侧本来就是同一个入口）
    set-speed <数字>                0.25–4（走应用的变速逻辑：带 scaletempo2 不变调）
    set-aspect <fit|cover|stretch>
    set-subtitle <id|-1>            -1 = 关闭字幕
    toggle-danmaku
    volume-set <0-100>              直接设音量（uosc 音量菜单的 0/25/50/75/100% 快捷档）
    volume-delta <±N>               在当前音量上增减（菜单的 ±10%），目标值由应用计算
    danmaku-json <json>             {"key":…,"value":…} → 应用的一条弹幕设置
    uosc-menu <search|total|style|delay|add>   打开 uosc_danmaku 插件自己的菜单
    open-danmaku-settings / reload-danmaku / detect-danmaku-alias
    toggle-info / snapshot / toggle-fullscreen / exit / escape
    flow                            打开「播放流详情」面板（带宽/线路/嗅探结果，右上角角标用）
    open-danmaku-settings       打开应用的弹幕设置窗口（「弹幕设置」按钮直接走这条）
    menu status                 打开「播放状态」菜单（线路/分辨率/码率/缓冲/网络/丢帧/投屏）

状态数据（v1.1.4）：
    应用每秒推一次 `script-message sakana-playback-status <json>`，里面是主进程读到的
    播放时间、分辨率/编码/码率、缓冲、缓存速度、丢帧、音画同步、投屏与加速器状态。
    菜单里"取不到的项"显示「暂不可用」——**不编数字**；累计流量这类节点属性
    由本脚本用 `mp.get_property_native('demuxer-cache-state')` 现读（原生插件只暴露标量，
    主进程读不到节点，这部分只能由 mpv 侧补）。

踩过的坑（都是这次改造实测出来的）：
  1. 业务按钮必须用 `button:<名字>`（uosc 的受管按钮）+ `set-button` 动态下发，
     **不能**写死在 uosc.conf 的 controls 里 —— 图标/激活态/角标要跟着播放状态变。
  2. uosc 的 `open-menu` 只认 `items` 数组；菜单项 `value` 用**表**（JSON 数组）形式，
     uosc 会走 `mp.commandv(unpack(value))`，比拼字符串安全（不用管引号/空格转义）。
  3. `script-message` 的多个参数是**分开**送达的（实测 3 个参数 → 3 个 Lua 实参），
     但这里仍兼容「被上游拼成一整串」的情况，免得换 mpv 版本后静默失效。
  4. 本脚本要在 uosc **之前**加载（mpv.ts 里的加载顺序）：uosc 加载完才认识
     `set-button` / `open-menu`。先发出去也不会丢，但顺序对了更好排障。
--]]

local mp = require 'mp'
local msg = require 'mp.msg'
local utils = require 'mp.utils'

-- 回传通道用的属性名（主进程的 250ms 状态泵轮询它，读到就派发给播放页）
local CTRL_PROP = 'user-data/sakana-ctrl'
-- uosc 顶栏第二行用的副标题（top_bar=no，目前没有消费者；保留属性是为了将来打开顶栏时不用改协议）
local SUBTITLE_PROP = 'user-data/sakana-subtitle'

-- 自检/排障用的只读属性（v1.1.4）：uosc 的按钮画在 ASS 图层里，Electron 侧看不到 DOM，
-- 「控制栏到底有几个按钮、uosc 是什么版本」只能由本脚本写出来给主进程读。
local BUTTONS_PROP = 'user-data/sakana-uosc-buttons'
local STATS_PROP = 'user-data/sakana-uosc-stats'

--- 应用推来的控制栏状态（结构见 src/shared/api.ts 的 UoscBarState）
local state = nil
--- 应用每秒推来的播放状态（v1.1.4，结构见 mpv.ts 的 UoscPlaybackStatus）
local playback = nil
--- uosc 广播的版本号（`script-message uosc-version`）
local uosc_version = ''
--- set-button 真正执行（没命中内容缓存）的累计次数：自检证据的一部分
local set_button_calls = 0
--- 前向声明：消息处理器在文件末尾统一注册，这里先占位
local open_named_menu

--- 安全取表字段
local function field(t, name, default)
  if type(t) ~= 'table' then return default end
  local v = t[name]
  if v == nil then return default end
  return v
end

local function to_int(v, default)
  local n = tonumber(v)
  if not n then return default end
  return math.floor(n + 0.5)
end

-- ─────────────────────────── 动作上行 ───────────────────────────

--- 把动作写进 user-data 属性：主进程轮询到新值 → 派发给播放页 → 清空。
local function emit(...)
  local n = select('#', ...)
  local parts = {}
  if n == 1 and type(select(1, ...)) == 'string' and select(1, ...):find(' ') then
    -- 兼容「被拼成一整串」的情况
    for word in select(1, ...):gmatch('%S+') do parts[#parts + 1] = word end
  else
    for i = 1, n do
      local v = select(i, ...)
      if v ~= nil then parts[#parts + 1] = tostring(v) end
    end
  end
  local text = table.concat(parts, ' ')
  if text == '' then return end
  mp.set_property(CTRL_PROP, text)
  msg.verbose('sakana-ctrl → ' .. text)
end

-- ─────────────────────────── 按钮状态下发 ───────────────────────────

--- 上一次下发的 JSON：内容没变就不再发（否则 2 秒一次的兜底刷新会刷屏）
local last_button_json = {}
--- uosc 是否已经加载过（它加载时会广播 uosc-version）；没确认之前每次刷新都强制重发
local uosc_seen = false
--- 本轮 update_buttons 是否强制重发（uosc 刚加载时用）
local force_all = false

--- @param force boolean 忽略「内容没变」的缓存，强制重发（uosc 刚加载时用）
local function set_button(name, data, force)
  local json = utils.format_json(data)
  if not force and last_button_json[name] == json then return end
  last_button_json[name] = json
  set_button_calls = set_button_calls + 1
  mp.commandv('script-message-to', 'uosc', 'set-button', name, json)
end

--- 生成一个「点击执行 script-message」的受管按钮。
--- 注意 uosc 的 Button 用 `is_clickable = command ~= nil` 判断能不能点，
--- 所以「当前不可用」就直接不给 command（图标/角标照常显示）。
local function ctrl_button(opts, force)
  local data = { icon = opts.icon, tooltip = opts.tooltip }
  if opts.action then
    data.command = { 'script-message', 'sakana-ctrl', unpack(opts.action) }
  end
  if opts.active ~= nil then data.active = opts.active end
  if opts.badge ~= nil and opts.badge ~= '' then data.badge = tostring(opts.badge) end
  if opts.hide then data.hide = true end
  set_button(opts.name, data, force or force_all)
end

--- 把「uosc 版本 + 按钮清单 + set-button 次数」写成只读属性。
--- 注意用 `mp.set_property` 写字符串（不是 native 表）：Electron 侧的 getProperty 只暴露
--- double/flag/string 三种格式，写表会被转成不可读的节点。
local function publish_stats()
  local names = {}
  for name in pairs(last_button_json) do names[#names + 1] = name end
  table.sort(names)
  mp.set_property(BUTTONS_PROP, table.concat(names, ','))
  mp.set_property(STATS_PROP, string.format(
    'version=%s buttons=%d sets=%d', uosc_version ~= '' and uosc_version or 'unknown', #names, set_button_calls))
end

--- 倍速显示成 1x / 1.5x / 2x（与旧控制栏一致）
local function fmt_speed(v)
  local n = tonumber(v) or 1
  if math.abs(n - math.floor(n)) < 0.001 then return string.format('%.1f', n) end
  return tostring(n)
end

local ASPECT_LABEL = { fit = '适应', cover = '裁剪铺满', stretch = '拉伸铺满' }

--- Anime4K 模式的短名（角标用）：与 settings 里存的 id 一一对应（见 @shared/anime4k）
local A4K_SHORT = { A = 'A', B = 'B', C = 'C', AA = 'A+A', BB = 'B+B', CA = 'C+A', custom = '自定义' }
--- 菜单里的模式清单：id → 说明（说明文字与设置页保持一致，避免两处说法不一）
local A4K_MENU = {
  { 'off', '关闭超分', '按原画播放，不做任何处理' },
  { 'A', '模式 A', '1080p 通用；模糊/压缩痕迹重时最明显' },
  { 'B', '模式 B', '多数 720p；锯齿、振铃明显时更合适' },
  { 'C', '模式 C', '低码率 / 噪点多；PSNR 最高' },
  { 'AA', '模式 A+A', '画质优先（更慢，放大 ≥2 倍时再考虑）' },
  { 'BB', '模式 B+B', '画质优先（更慢）' },
  { 'CA', '模式 C+A', '画质优先（更慢）' },
}

--- 按最新状态刷新全部按钮
--- @param force boolean|nil 忽略内容缓存强制重发（uosc 刚加载、或状态刚回来时用）
local function update_buttons(force)
  force_all = force and true or false
  local has = state ~= nil
  local speed = has and tonumber(field(state, 'speed', 1)) or 1
  local aspect = has and tostring(field(state, 'aspect', 'fit')) or 'fit'
  local fullscreen = has and field(state, 'fullscreen', false) or false
  local danmaku = has and field(state, 'danmaku', nil) or nil
  local dm_ok = type(danmaku) == 'table'
  local dm_on = dm_ok and field(danmaku, 'enabled', true) or false
  local dm_count = dm_ok and to_int(field(danmaku, 'count', 0), 0) or 0
  local dm_source = dm_ok and tostring(field(danmaku, 'source', '')) or ''
  local dm_plugin = dm_ok and field(danmaku, 'pluginActive', false) or false
  local can_prev = has and field(state, 'canPrev', true) or true
  local can_next = has and field(state, 'canNext', true) or true
  local lines = has and field(state, 'lines', {}) or {}
  local has_episodes = type(lines) == 'table' and #lines > 0
  local subs = has and field(state, 'subs', {}) or {}
  local sub_count = type(subs) == 'table' and #subs or 0
  local sub_id = to_int(field(state, 'subId', -1), -1)

  -- 播放控制（v1.1.4：上一集/下一集**始终保留**，不可用时只置灰、不隐藏 ——
  -- 用户点名的按钮清单里包含它们，隐藏会让人以为控制栏缺按钮）
  ctrl_button {
    name = 'sakana-prev', icon = 'skip_previous',
    tooltip = can_prev and '上一集' or '上一集（已经是第一集）',
    action = can_prev and { 'prev-episode' } or nil,
  }
  ctrl_button {
    name = 'sakana-next', icon = 'skip_next',
    tooltip = can_next and '下一集' or '下一集（已经是最后一集）',
    action = can_next and { 'next-episode' } or nil,
  }
  ctrl_button { name = 'sakana-back10', icon = 'replay_10', tooltip = '后退 10 秒', action = { 'back10' } }
  ctrl_button { name = 'sakana-forward10', icon = 'forward_10', tooltip = '前进 10 秒', action = { 'forward10' } }

  -- 音量按钮（用户要求：音量单独做成按钮放进底部控制栏，不再用右边的竖排滑杆）。
  -- 图标按当前状态变化：静音或 0 → volume_off；<50 → volume_down；否则 volume_up。
  --
  -- v1.1.6：点击**不再只发 toggle-mute**。旧行为点一下只能在"静音/恢复"之间跳，
  -- 用户反馈「音量按钮无法调音量」。现在点开 menu_volume：-10 / +10 / 静音 / 0-100 快捷档。
  -- 所有写入都通过 `sakana-ctrl` 回主进程执行 —— 音量的真源是应用状态与内核，
  -- 本脚本只**读** volume/mute 来画图标和提示，绝不 set_property，否则两套音量会互相打架。
  local vol = tonumber(mp.get_property_number('volume')) or 100
  local muted = mp.get_property_native('mute') == true or vol <= 0
  ctrl_button {
    name = 'sakana-volume',
    icon = muted and 'volume_off' or (vol < 50 and 'volume_down' or 'volume_up'),
    tooltip = muted and '已静音（点击调音量）' or string.format('音量 %d%%（点击调音量）', math.floor(vol)),
    action = { 'menu', 'volume' },
    active = not muted,
  }

  -- 选集 / 线路：没有剧集数据就隐藏（本地单文件播放本来就没有「集」可切）
  --
  -- V1.5.1 图标整理（用户反馈「控制按钮图标不够美观，看看有没有认可度高的图标」）：
  -- 全部换成 **Material Symbols 官方图标名**（uosc 自带的就是这套字体，已确认字形都存在），
  -- 并用"语义更直白"的换掉了几个容易看错的：
  --   playlist_play → video_library（片库/选集，比一个播放三角更直观）
  --   hd → swap_horiz（线路"切换"）
  --   auto_awesome/movie_filter → hdr_on/hdr_off（画质档位，与"超分/高清"语义一致）
  --   photo_camera → screenshot_monitor（截图，屏幕+快门，比单个相机清楚）
  --   exit_to_app → logout（退出播放）
  ctrl_button {
    name = 'sakana-episodes', icon = 'video_library', tooltip = '选集',
    action = has_episodes and { 'menu', 'episodes' } or nil, hide = not has_episodes,
  }
  ctrl_button {
    name = 'sakana-line', icon = 'swap_horiz', tooltip = '线路切换',
    action = #lines > 1 and { 'menu', 'lines' } or nil, hide = #lines < 2,
  }

  -- 字幕：角标显示轨道数
  ctrl_button {
    name = 'sakana-subtitle', icon = 'subtitles', tooltip = '字幕选择',
    action = { 'menu', 'subtitle' }, badge = sub_count > 0 and sub_count or nil,
    active = sub_id >= 0,
  }

  -- 倍速：角标就是当前档位（旧控制栏把档位写在按钮上，这里用 uosc 的 badge 还原）
  ctrl_button {
    name = 'sakana-speed', icon = 'speed', tooltip = '播放倍速：' .. fmt_speed(speed) .. 'x（点击选择）',
    action = { 'menu', 'speed' }, badge = fmt_speed(speed) .. 'x',
    active = math.abs(speed - 1) > 0.001,
  }

  ctrl_button {
    name = 'sakana-aspect', icon = 'aspect_ratio',
    tooltip = '画面比例：' .. (ASPECT_LABEL[aspect] or aspect), action = { 'menu', 'aspect' },
    active = aspect ~= 'fit',
  }

  -- 弹幕开关：开/关两套图标，插件渲染时用另一个图标区分
  local dm_tip
  if dm_on then
    dm_tip = '关闭弹幕' .. (dm_count > 0 and ('（' .. dm_count .. ' 条）') or '')
  elseif dm_source ~= '' then
    dm_tip = '打开弹幕（' .. dm_source .. '）'
  else
    dm_tip = '打开弹幕'
  end
  ctrl_button {
    name = 'sakana-danmaku',
    icon = dm_on and (dm_plugin and 'comment' or 'subtitles') or 'comments_disabled',
    tooltip = dm_tip, action = { 'toggle-danmaku' }, active = dm_on,
  }
  -- 弹幕设置：用户明确要求这个按钮 = 打开应用的「弹幕设置」窗口（不是再弹一层 uosc 菜单）。
  -- 区域/数量/时间轴这些仍可从「弹幕」按钮的菜单里改；完整设置（数据源、本地库…）在窗口里。
  ctrl_button {
    name = 'sakana-danmaku-settings', icon = 'tune', tooltip = '弹幕设置（打开设置窗口）',
    action = { 'open-danmaku-settings' },
  }

  -- 画质（Anime4K 超分，v0.3.3）：角标显示当前模式，点亮表示超分开着。
  -- 用户反馈「控制栏里没有超分辨率按钮」—— 以前只能进设置页改，播放中没法切，这里补上。
  local a4k = has and field(state, 'anime4k', nil) or nil
  local a4k_on = type(a4k) == 'table' and field(a4k, 'enabled', false) == true or false
  local a4k_mode = type(a4k) == 'table' and tostring(field(a4k, 'mode', 'A')) or 'A'
  local a4k_short = A4K_SHORT[a4k_mode] or a4k_mode
  ctrl_button {
    name = 'sakana-a4k',
    icon = a4k_on and 'hdr_on' or 'hdr_off',
    tooltip = '画质（Anime4K 超分）：' .. (a4k_on and ('模式 ' .. a4k_short) or '已关闭'),
    action = { 'menu', 'quality' },
    badge = a4k_on and a4k_short or '关',
    active = a4k_on,
  }

  -- 详情 / 播放状态 / 截图 / 全屏 / 退出
  ctrl_button { name = 'sakana-info', icon = 'info', tooltip = '番剧详情', action = { 'toggle-info' } }
  -- v1.1.5「播放流详情」（右上角角标）：打开应用已有的流详情面板（StreamInfoModal），
  -- 面板里是嗅探到的媒体地址、带宽/线路读数与播放流程，**不是**番剧详情（sakana-info）。
  -- 动作名 flow 由主进程 mpv.ts 的 uoscActionToOverlay 映射成 toggleStreamInfo，
  -- 渲染层再切 PlayerPage 里已有的 showStreamInfo —— 这里不新造 UI，只补一个入口。
  ctrl_button { name = 'sakana-flow', icon = 'network_check', tooltip = '播放流详情', action = { 'flow' } }
  -- v1.1.4「播放状态」：线路/集、分辨率与编码、码率、缓冲、网络、丢帧/音画、投屏。
  -- 菜单内容是只读读数（不可点选），只有底部「刷新读数」会重新构造一次。
  -- v1.1.6：底部栏不再放这个按钮（用户要求删掉），只由右上角角标使用 —— 定义必须保留。
  ctrl_button {
    name = 'sakana-status', icon = 'monitor_heart',
    tooltip = '播放状态（线路 / 画质 / 缓冲 / 网络 / 丢帧 / 投屏）',
    action = { 'menu', 'status' },
  }
  ctrl_button { name = 'sakana-snapshot', icon = 'screenshot_monitor', tooltip = '截图', action = { 'snapshot' } }
  ctrl_button {
    name = 'sakana-fullscreen', icon = fullscreen and 'fullscreen_exit' or 'fullscreen',
    tooltip = fullscreen and '退出全屏' or '全屏播放', action = { 'toggle-fullscreen' }, active = fullscreen,
  }
  ctrl_button { name = 'sakana-exit', icon = 'logout', tooltip = '退出播放', action = { 'exit' } }

  -- 按钮清单/版本写成只读属性（主进程日志与 API 自检读它）
  publish_stats()
end

--- 顶栏第二行 = 线路/集名（+ 非播放中的状态文案）。
--- 旧的顶部状态药丸就搬到了这里（标题行由 uosc 的 top_bar 绘制）。
local function update_subtitle()
  local sub = state and tostring(field(state, 'subtitle', '')) or ''
  local status = state and field(state, 'status', nil) or nil
  local text = type(status) == 'table' and tostring(field(status, 'text', '')) or ''
  if text ~= '' and text ~= '播放中' then
    sub = sub ~= '' and (sub .. ' · ' .. text) or text
  end
  mp.set_property(SUBTITLE_PROP, sub)
end

-- ─────────────────────────── 菜单 ───────────────────────────

--- 菜单项：点一下就把动作回传给应用。
--- value 用表形式 → uosc 走 mp.commandv，参数不会被当字符串再拆一次。
local function item(title, action, opts)
  opts = opts or {}
  local entry = {
    title = title,
    value = { 'script-message', 'sakana-ctrl', unpack(action) },
    active = opts.active and true or false,
  }
  if opts.hint then entry.hint = opts.hint end
  if opts.icon then entry.icon = opts.icon end
  if opts.muted then entry.muted = true end
  if opts.selectable == false then entry.selectable = false end
  return entry
end

local function open_menu(cfg)
  -- 自检用：记录"最近一次真的构造/打开了哪个菜单、几项"。
  -- uosc 的菜单画在 ASS 图层上，Electron 侧看不到 DOM，headless 自检只能靠这个属性判断
  -- 「点 sakana-status 时菜单确实被构造出来了」——没有它就只能靠截图。
  local titles = {}
  for _, it in ipairs((cfg and cfg.items) or {}) do
    if type(it) == 'table' and it.title and it.title ~= '' then titles[#titles + 1] = tostring(it.title) end
  end
  mp.set_property('user-data/sakana-uosc-last-menu',
    tostring(cfg.type or '?') .. ':' .. tostring(#(cfg.items or {})))
  mp.set_property('user-data/sakana-uosc-last-menu-titles', table.concat(titles, ' | '))
  mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(cfg))
end

local function need_state()
  if state == nil then
    mp.commandv('show-text', '控制栏数据还没就绪，稍后再试', 2000)
    return false
  end
  return true
end

--- 选集：单线路时平铺；多线路时每条线路一个子菜单，当前集高亮
local function menu_episodes()
  if not need_state() then return end
  local lines = field(state, 'lines', {})
  local cur_line = to_int(field(state, 'currentLine', 0), 0)
  local cur_ep = to_int(field(state, 'currentEp', 0), 0)
  local items = {}

  if #lines <= 1 then
    for i, name in ipairs(field(lines[1], 'episodes', {})) do
      items[#items + 1] = item(tostring(name), { 'select-episode', 0, i - 1 }, { active = (i - 1) == cur_ep })
    end
  else
    for li, line in ipairs(lines) do
      local eps = field(line, 'episodes', {})
      local sub = {}
      for i, name in ipairs(eps) do
        sub[#sub + 1] = item(tostring(name), { 'select-episode', li - 1, i - 1 },
          { active = (li - 1) == cur_line and (i - 1) == cur_ep })
      end
      items[#items + 1] = {
        title = tostring(field(line, 'name', '线路 ' .. li)),
        hint = #sub .. ' 集',
        items = sub,
        active = (li - 1) == cur_line,
      }
    end
  end

  open_menu {
    type = 'sakana-episodes',
    title = '选集',
    footnote = '↑↓ 选择 · Enter 确认 · → 进入线路 · 直接在键盘上打字可搜索',
    items = items,
  }
end

--- 线路切换：保持当前集号，目标线路不够长时收敛到它最后一集
local function menu_lines()
  if not need_state() then return end
  local lines = field(state, 'lines', {})
  local cur_line = to_int(field(state, 'currentLine', 0), 0)
  local cur_ep = to_int(field(state, 'currentEp', 0), 0)
  local items = {}
  for li, line in ipairs(lines) do
    local eps = field(line, 'episodes', {})
    local target = math.min(cur_ep, math.max(0, #eps - 1))
    local label = tostring(field(line, 'name', '线路 ' .. li))
    if target ~= cur_ep then label = label .. '（第 ' .. (target + 1) .. ' 集）' end
    items[#items + 1] = item(label, { 'select-episode', li - 1, target }, {
      hint = #eps .. ' 集',
      active = (li - 1) == cur_line,
      icon = (li - 1) == cur_line and 'check' or nil,
    })
  end
  open_menu { type = 'sakana-lines', title = '线路切换', items = items }
end

--- 字幕：mpv 的字幕轨（数据由应用推来），带「关闭字幕」
local function menu_subtitle()
  if not need_state() then return end
  local subs = field(state, 'subs', {})
  local cur = to_int(field(state, 'subId', -1), -1)
  local items = { item('关闭字幕', { 'set-subtitle', -1 }, { active = cur < 0, icon = 'subtitles_off' }) }
  for _, s in ipairs(subs) do
    local id = to_int(field(s, 'id', -1), -1)
    if id >= 0 then
      items[#items + 1] = item(tostring(field(s, 'label', '字幕 ' .. id)), { 'set-subtitle', id }, { active = id == cur })
    end
  end
  if #subs == 0 then
    items[#items + 1] = { title = '当前视频没有字幕轨', value = 'ignore', selectable = false, muted = true }
  end
  open_menu { type = 'sakana-subtitle', title = '字幕选择', items = items }
end

--- 倍速档位与旧控制栏一致（0.5x–3x）；交给应用的 mpvSetSpeed（带 scaletempo2，变速不变调）
local SPEEDS = { 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3 }

local function menu_speed()
  if not need_state() then return end
  local cur = tonumber(field(state, 'speed', 1)) or 1
  local items = {}
  for _, s in ipairs(SPEEDS) do
    local on = math.abs(s - cur) < 0.001
    items[#items + 1] = item(fmt_speed(s) .. 'x', { 'set-speed', s }, { active = on, icon = on and 'check' or nil })
  end
  open_menu { type = 'sakana-speed', title = '播放倍速', footnote = '变速不变调（scaletempo2）', items = items }
end

--- 音量菜单（v1.1.6）。
---
--- 为什么要有它：sakana-volume 以前只发 toggle-mute，点一下只能静音/恢复，
--- 用户要的是"能调大小"（uosc 右侧竖排滑杆已被 volume=no 关掉，没有别的入口）。
--- 菜单只负责发动作，写入统一回主进程执行：
---   · 应用里 playerVolume 才是界面状态的来源，主进程还做了上限与削波保护（VOLUME_MAX=200）；
---   · Lua 直接 set volume 会绕开那条链，按钮图标、菜单读数与应用的音量状态各算各的，
---     下一次状态同步又被拉回去 —— 所以这里只读不写。
local VOLUME_PRESETS = { 0, 25, 50, 75, 100 }

local function menu_volume()
  -- 只读取当前值用来显示与高亮；读失败就当 100%（mpv 默认值），不编造其它数字。
  local vol = math.max(0, math.floor((mp.get_property_number('volume') or 100) + 0.5))
  -- 注意区分「mute 标记」与「音量为 0」：两者都听不见，但只有前者能被 toggle-mute 恢复。
  -- 若把 0% 也当成已静音，菜单会在未静音时显示「恢复声音」，点下去反而把 mute 打开。
  local mute_flag = mp.get_property_native('mute') == true
  local silent = mute_flag or vol <= 0
  local items = {
    {
      title = string.format('当前音量 %d%%', vol),
      hint = silent and '已静音' or '正常',
      value = 'ignore',
      selectable = false,
    },
    item('音量 −10%', { 'volume-delta', -10 }, { icon = 'volume_down' }),
    item('音量 +10%', { 'volume-delta', 10 }, { icon = 'volume_up' }),
    item(mute_flag and '恢复声音' or '静音', { 'toggle-mute' }, {
      active = mute_flag,
      icon = mute_flag and 'volume_up' or 'volume_off',
    }),
    { title = '', separator = true, value = 'ignore', selectable = false },
  }
  for _, p in ipairs(VOLUME_PRESETS) do
    local on = vol == p
    items[#items + 1] = item(p .. '%', { 'volume-set', p }, {
      active = on,
      icon = on and 'check' or nil,
    })
  end
  open_menu {
    type = 'sakana-volume',
    title = '音量',
    footnote = '写入由应用执行（与 ↑/↓ 键同一个 volume 属性）；菜单只发动作',
    items = items,
  }
  -- 自检证据：uosc 菜单画在 ASS 图层，Electron 侧看不到 DOM；
  -- headless 验证只能靠这条 info 日志 + user-data/sakana-uosc-last-menu-titles 判断
  -- 「点音量按钮确实构造出了预期的菜单项」。
  msg.info(string.format('音量菜单已构造：%d 项，当前 %d%% mute=%s', #items, vol, tostring(mute_flag)))
end

--- 画面比例：走应用的 changeAspect（同时写回设置、下次播放沿用）
local function menu_aspect()
  if not need_state() then return end
  local cur = tostring(field(state, 'aspect', 'fit'))
  local items = {}
  for _, mode in ipairs({ 'fit', 'cover', 'stretch' }) do
    items[#items + 1] = item(ASPECT_LABEL[mode] .. '（' .. mode .. '）', { 'set-aspect', mode },
      { active = mode == cur, icon = mode == cur and 'check' or nil })
  end
  open_menu { type = 'sakana-aspect', title = '画面比例', items = items }
end

--- 弹幕设置：开关 + 区域/数量/时间轴/类型 + 插件菜单入口，
--- 与旧悬浮窗那块「弹幕设置」面板一一对应（改的是同一份设置）。
local function dm_menu_value(key, value)
  return { 'danmaku-json', utils.format_json({ key = key, value = value }) }
end

local function menu_danmaku()
  if not need_state() then return end
  local dm = field(state, 'danmaku', {}) or {}
  local enabled = field(dm, 'enabled', true)
  local area = tonumber(field(dm, 'area', 0.5)) or 0.5
  local max_count = to_int(field(dm, 'maxCount', 20), 20)
  local font_size = to_int(field(dm, 'fontSize', 22), 22)
  local offset_ms = to_int(field(dm, 'offsetMs', 0), 0)
  local show_scroll = field(dm, 'showScroll', true)
  local show_top = field(dm, 'showTop', true)
  local show_bottom = field(dm, 'showBottom', true)
  local plugin = field(dm, 'pluginActive', false)
  local source = tostring(field(dm, 'source', ''))

  local area_items = {}
  for _, o in ipairs({ { 0.25, '1/4' }, { 0.5, '1/2' }, { 0.75, '3/4' }, { 1, '全屏' } }) do
    -- v1.1.4：弹幕动作改用播放页约定的短名（danmakuArea <比例>），
    -- 旧 `danmaku-json` 仍然保留在 mpv.ts 的映射表里，历史 input.conf 不会失效。
    area_items[#area_items + 1] = item(o[2], { 'danmakuArea', o[1] }, { active = math.abs(area - o[1]) < 0.01 })
  end

  local count_items = {}
  for _, n in ipairs({ 10, 20, 30, 50, 80 }) do
    count_items[#count_items + 1] = item(n .. ' 条', dm_menu_value('maxCount', n), { active = n == max_count })
  end

  -- 字体大小：与播放页设置里的 fontSize 是同一个值（CSS px）
  local font_items = {}
  for _, n in ipairs({ 16, 18, 20, 22, 26, 30, 36 }) do
    font_items[#font_items + 1] = item(n .. ' px', { 'danmakuFontSize', n }, {
      active = n == font_size, icon = n == font_size and 'check' or nil,
    })
  end

  -- 时间轴：+/- 0.5 秒，中间那行只显示当前值（不可选）
  local delay_items = {
    item('−0.5 秒', { 'danmakuOffset', offset_ms - 500 }),
    { title = '当前 ' .. string.format('%.1f', offset_ms / 1000) .. ' 秒', value = 'ignore', selectable = false, muted = true },
    item('+0.5 秒', { 'danmakuOffset', offset_ms + 500 }),
    item('重置为 0', { 'danmakuOffset', 0 }, { active = offset_ms == 0 }),
  }

  local type_items = {
    item('滚动弹幕', dm_menu_value('showScroll', not show_scroll), { active = show_scroll }),
    item('顶部弹幕', dm_menu_value('showTop', not show_top), { active = show_top }),
    item('底部弹幕', dm_menu_value('showBottom', not show_bottom), { active = show_bottom }),
  }

  local items = {
    item(enabled and '关闭弹幕' or '打开弹幕', { 'toggle-danmaku' },
      { active = enabled, icon = enabled and 'comment' or 'comments_disabled' }),
    { title = '播放区域', hint = '屏幕的几分之一', items = area_items },
    { title = '字体大小', hint = string.format('%d px', font_size), items = font_items },
    { title = '弹幕数量', hint = '同屏最多几条', items = count_items },
    { title = '时间轴偏移', hint = string.format('%.1f 秒', offset_ms / 1000), items = delay_items },
    { title = '显示类型', hint = '滚动 / 顶部 / 底部', items = type_items },
  }
  if plugin then
    items[#items + 1] = {
      title = '插件菜单（uosc_danmaku）',
      hint = '搜索 / 样式 / 源延迟',
      items = {
        item('搜索弹幕', { 'uosc-menu', 'search' }, { icon = 'search' }),
        item('弹幕样式', { 'uosc-menu', 'style' }, { icon = 'palette' }),
        item('源延迟', { 'uosc-menu', 'delay' }, { icon = 'more_time' }),
        item('总菜单（源/渲染/更新）', { 'uosc-menu', 'total' }, { icon = 'grid_view' }),
      },
    }
  end
  -- v1.1.4：下面的动作名是弹幕线约定好的（danmakuReload / danmakuAliasSearch），
  -- 由 mpv.ts 映射成 OverlayAction；旧的 reload-danmaku / detect-danmaku-alias 仍兼容。
  items[#items + 1] = item('重新检测弹幕', { 'danmakuReload' }, { icon = 'refresh' })
  items[#items + 1] = item('输入别名搜索弹幕…', { 'danmakuAliasSearch' }, { icon = 'search' })
  items[#items + 1] = item('更多设置…', { 'open-danmaku-settings' }, { icon = 'settings' })

  open_menu {
    type = 'sakana-danmaku',
    title = '弹幕设置',
    footnote = source ~= '' and ('当前来源：' .. source) or '未匹配到弹幕库条目',
    items = items,
  }
end

--- 画质 / Anime4K 超分（v0.3.3）。
---
--- 用户要求：控制栏里要有超分辨率按钮。这里给一个模式清单 + 档位切换 + 进完整设置的入口。
--- 所有动作都通过 `sakana-ctrl a4k-*` 回传主进程执行（设置存在主进程的 store 里，
--- 改完立刻用 change-list 重挂着色器链，所以是**播放中即时生效**）。
--- 菜单项 highlight 由 `state.anime4k` 决定，按钮角标显示当前模式（关 / A / B / …）。
---
--- ⚠️ 这里以前误用了 JSDoc 风格的 `/** */`，Lua 只认 `--` / `--[[ ]]` ——
--- 结果是**整个桥接脚本加载后立刻报语法错误退出**（日志里 `Lua error: … unexpected symbol near '/'`），
--- 表现就是按钮/菜单/诊断全部失灵。Lua 文件里不要再出现 `/*`。
local function menu_quality()
  local a4k = state and field(state, 'anime4k', nil) or nil
  local enabled = type(a4k) == 'table' and field(a4k, 'enabled', false) == true or false
  local mode = type(a4k) == 'table' and tostring(field(a4k, 'mode', 'A')) or 'A'
  local tier = type(a4k) == 'table' and tostring(field(a4k, 'tier', 'fast')) or 'fast'

  local mode_items = {}
  for _, o in ipairs(A4K_MENU) do
    local id, title, hint = o[1], o[2], o[3]
    local is_current = (id == 'off' and not enabled) or (id ~= 'off' and enabled and mode == id)
    mode_items[#mode_items + 1] = item(title, { 'a4k-set', id }, {
      hint = hint,
      active = is_current,
      icon = is_current and 'check' or nil,
    })
  end

  local tier_items = {
    item('流畅优先', { 'a4k-tier', 'fast' }, {
      hint = '官方 Low-end 模板（S/M 变体）',
      active = tier == 'fast',
      icon = tier == 'fast' and 'check' or nil,
    }),
    item('画质优先', { 'a4k-tier', 'quality' }, {
      hint = '官方 High-end 模板（VL/M 变体）',
      active = tier == 'quality',
      icon = tier == 'quality' and 'check' or nil,
    }),
  }

  local items = {
    { title = '模式', hint = enabled and (A4K_SHORT[mode] or mode) or '已关闭', items = mode_items },
    { title = '显卡档位', hint = tier == 'quality' and '画质优先' or '流畅优先', items = tier_items },
    item(enabled and '关闭超分' or '开启超分（模式 A）', { 'a4k-toggle' },
      { icon = enabled and 'movie_filter' or 'auto_awesome' }),
    item('完整画质设置…', { 'open-quality-settings' }, { icon = 'settings' }),
  }

  open_menu {
    type = 'sakana-quality',
    title = '画质（Anime4K 超分）',
    footnote = enabled
      and ('当前：模式 ' .. (A4K_SHORT[mode] or mode) .. ' · ' .. (tier == 'quality' and '画质优先' or '流畅优先') .. '（改完立刻生效）')
      or '当前：已关闭。超分需要 libmpv 内核，着色器随包内置',
    items = items,
  }
  -- 打一行日志：自检靠它确认「菜单确实被构造出来了、而且拿到的是最新状态」
  msg.info(string.format('画质菜单已构造：%d 项，enabled=%s mode=%s tier=%s', #items, tostring(enabled), mode, tier))
end

-- ─────────────────────── 播放状态菜单（v1.1.4） ───────────────────────
--
-- 数据分两路，**都不猜**：
--   ① 主进程每秒推来的 `sakana-playback-status`：线路/集、时间、分辨率/编码/码率（标量属性）、
--      缓冲、缓存速度、丢帧、音画同步、投屏、加速器、播放流程；
--   ② 本脚本现读的节点属性：`demuxer-cache-state` 的 `total-bytes` / `raw-input-rate`
--      （原生插件只暴露 double/flag/string，主进程拿不到节点，这部分只能在这里补）。
-- 任何一项取不到就写「暂不可用」——显示一个编的 0 比不显示更糟。

local function fmt_bytes(n)
  n = tonumber(n)
  if not n or n <= 0 then return nil end
  local units = { 'B', 'KB', 'MB', 'GB', 'TB' }
  local i = 1
  while n >= 1024 and i < #units do
    n = n / 1024
    i = i + 1
  end
  if i == 1 then return string.format('%.0f %s', n, units[i]) end
  return string.format('%.1f %s', n, units[i])
end

local function fmt_rate(n)
  local b = fmt_bytes(n)
  return b and (b .. '/s') or nil
end

local function fmt_seconds(sec)
  sec = tonumber(sec)
  if not sec or sec < 0 then return nil end
  if sec < 60 then return string.format('%.1f 秒', sec) end
  local m = math.floor(sec / 60)
  local s = math.floor(sec % 60)
  return string.format('%d 分 %02d 秒', m, s)
end

local function fmt_bitrate(bps)
  local n = tonumber(bps)
  if not n or n <= 0 then return nil end
  if n >= 1000000 then return string.format('%.2f Mbps', n / 1000000) end
  return string.format('%.0f kbps', n / 1000)
end

--- 读一个**正数**属性（0 / nil 都当"没有"）
local function read_positive(name)
  local ok, v = pcall(mp.get_property_number, name)
  if ok and type(v) == 'number' and v > 0 then return v end
  return nil
end

--- 读一个可为 0 / 负数的属性（avsync、丢帧计数）
local function read_number(name)
  local ok, v = pcall(mp.get_property_number, name)
  if ok and type(v) == 'number' then return v end
  return nil
end

local function read_text(name)
  local ok, v = pcall(mp.get_property_string, name)
  if ok and type(v) == 'string' and v ~= '' and v ~= 'no' then return v end
  return nil
end

--- 只读信息行：不可点选，value 用 'ignore'（不执行任何命令）
local function info_line(title, hint)
  return { title = title, hint = hint or '暂不可用', value = 'ignore', selectable = false }
end

local function menu_status()
  local pb = type(playback) == 'table' and playback or {}
  local st = type(state) == 'table' and state or {}
  local lines = field(st, 'lines', {})
  local line = tonumber(pb.line) or to_int(field(st, 'currentLine', 0), 0)
  local ep = tonumber(pb.ep) or to_int(field(st, 'currentEp', 0), 0)
  local line_name = tostring(pb.lineName or '')
  local ep_name = tostring(pb.epName or '')
  if line_name == '' and type(lines) == 'table' and type(lines[line + 1]) == 'table' then
    line_name = tostring(field(lines[line + 1], 'name', ''))
  end
  if ep_name == '' and type(lines) == 'table' and type(lines[line + 1]) == 'table' then
    local eps = field(lines[line + 1], 'episodes', {})
    if type(eps) == 'table' and eps[ep + 1] ~= nil then ep_name = tostring(eps[ep + 1]) end
  end

  local title = tostring(pb.title or field(st, 'title', ''))
  local status = field(st, 'status', nil)
  local status_text = type(status) == 'table' and tostring(field(status, 'text', '')) or ''
  if status_text == '' then status_text = tostring(pb.statusText or '') end

  -- 线路 / 集：规则播放是「线路 · 集名」，本地播放是「本地文件 · 文件名」
  local ep_text
  if type(lines) == 'table' and #lines > 0 then
    ep_text = (line_name ~= '' and line_name or ('线路 ' .. (line + 1))) ..
      ' · ' .. (ep_name ~= '' and ep_name or ('第 ' .. (ep + 1) .. ' 集'))
  else
    ep_text = tostring(pb.subtitle or field(st, 'subtitle', ''))
    if ep_text == '' then ep_text = '暂不可用' end
  end

  -- 播放进度 / 时间
  local time_ms = tonumber(pb.timeMs) or 0
  local length_ms = tonumber(pb.lengthMs) or 0
  local progress
  if length_ms > 0 then
    progress = (fmt_seconds(time_ms / 1000) or '暂不可用') .. ' / ' .. (fmt_seconds(length_ms / 1000) or '暂不可用')
  else
    progress = fmt_seconds(time_ms / 1000) or '暂不可用'
  end

  -- 分辨率 / 编码
  local w = tonumber(pb.width) or read_positive('width') or 0
  local h = tonumber(pb.height) or read_positive('height') or 0
  local vcodec = tostring(pb.videoCodec or '')
  if vcodec == '' then vcodec = read_text('video-codec') or '' end
  local acodec = tostring(pb.audioCodec or '')
  if acodec == '' then acodec = read_text('audio-codec') or '' end
  local res_text = (w > 0 and h > 0) and (string.format('%d×%d', w, h)) or '暂不可用'
  local codec_text = vcodec ~= '' and vcodec or '暂不可用'
  if acodec ~= '' then codec_text = codec_text .. ' / ' .. acodec end

  -- 码率：优先 mpv 的 video/audio-bitrate（bits/s）；没有再按「文件大小 ÷ 时长」算平均并标注"平均"
  local vbps = tonumber(pb.videoBitrate) or read_positive('video-bitrate')
  local abps = tonumber(pb.audioBitrate) or read_positive('audio-bitrate')
  local bitrate_text
  if fmt_bitrate(vbps) or fmt_bitrate(abps) then
    local parts = {}
    if fmt_bitrate(vbps) then parts[#parts + 1] = '视频 ' .. fmt_bitrate(vbps) end
    if fmt_bitrate(abps) then parts[#parts + 1] = '音频 ' .. fmt_bitrate(abps) end
    bitrate_text = table.concat(parts, ' / ')
  else
    local file_size = tonumber(pb.fileSize) or read_positive('file-size')
    if file_size and length_ms > 0 then
      bitrate_text = '平均 ' .. (fmt_bitrate(file_size * 8 / (length_ms / 1000)) or '暂不可用')
    else
      bitrate_text = '暂不可用'
    end
  end

  -- 缓存节点：累计读取流量 / 实时输入速率 / 缓冲时长
  local cache_state = nil
  do
    local ok, cs = pcall(mp.get_property_native, 'demuxer-cache-state')
    if ok and type(cs) == 'table' then cache_state = cs end
  end
  local cache_sec = tonumber(pb.cacheDurationSec) or read_positive('demuxer-cache-duration')
  if not cache_sec and cache_state then cache_sec = tonumber(cache_state['cache-duration']) end
  local buffered = fmt_seconds(cache_sec) or '暂不可用'
  if cache_state and cache_state['underrun'] == true then buffered = buffered .. '（正在卡顿）' end

  local boost = type(pb.boost) == 'table' and pb.boost or {}
  local rate = tonumber(pb.cacheSpeedBps) or read_positive('cache-speed')
  if not rate and cache_state then rate = tonumber(cache_state['raw-input-rate']) end
  local total = cache_state and tonumber(cache_state['total-bytes']) or nil
  -- 本机中转加速时，加速器自己记的 bytes 才是真正的累计流量（mpv 看到的只是本地回环）
  if boost.active == true and tonumber(boost.bytes) then total = tonumber(boost.bytes) end
  local net_text = '实时 ' .. (fmt_rate(rate) or '暂不可用') ..
    ' · 累计 ' .. (fmt_bytes(total) or '暂不可用')
  if boost.active == true then net_text = net_text .. '（本机加速器）' end

  -- 丢帧 / 音画同步
  local fd = tonumber(pb.frameDropCount)
  local dd = tonumber(pb.decoderDropCount)
  if fd == nil then fd = read_number('frame-drop-count') end
  if dd == nil then dd = read_number('decoder-frame-drop-count') end
  local drop_text = (fd ~= nil or dd ~= nil) and (tostring((fd or 0) + (dd or 0)) .. ' 帧') or '暂不可用'
  local avsync = tonumber(pb.avsync)
  if avsync == nil then avsync = read_number('avsync') end
  local av_text = avsync ~= nil and string.format('音画 %+.3f 秒', avsync) or '音画 暂不可用'

  -- 投屏
  local cast = type(pb.cast) == 'table' and pb.cast or {}
  local cast_text
  if cast.active == true then
    local name = tostring(cast.deviceName or '')
    local id = tostring(cast.deviceId or '')
    cast_text = '投屏中'
    if name ~= '' then
      cast_text = cast_text .. '（' .. name .. '）'
    elseif id ~= '' then
      cast_text = cast_text .. '（设备 ' .. id:sub(1, 8) .. '…）'
    end
  else
    cast_text = '未投屏'
  end

  -- 播放加速器（只有真的在供流时才显示"加速中"，档位不等于状态）
  local boost_text
  if boost.active == true then
    boost_text = string.format('%s · %s · %d 并发',
      tostring(boost.kind or 'none'), tostring(boost.mode or 'auto'), tonumber(boost.parallel) or 0)
  else
    boost_text = '未加速（' .. tostring(boost.mode or 'auto') .. '）'
  end

  local items = {
    { title = title ~= '' and title or '未在播放', hint = status_text, value = 'ignore', selectable = false, bold = true },
    info_line('线路 / 集', ep_text),
    info_line('播放进度', progress),
    info_line('分辨率', res_text),
    info_line('编码', codec_text),
    info_line('码率', bitrate_text),
    info_line('已缓冲', buffered),
    info_line('网络', net_text),
    info_line('丢帧 / 音画', drop_text .. ' · ' .. av_text),
    info_line('投屏状态', cast_text),
    info_line('播放加速', boost_text),
  }
  -- 播放流程只在真的在跑（或失败）时出现，免得菜单里永远挂一行"未开始"
  local flow = type(pb.flow) == 'table' and pb.flow or {}
  if flow.running == true then
    items[#items + 1] = info_line('播放流程', tostring(flow.summary or '进行中'))
  elseif flow.reason ~= nil and flow.reason ~= 'none' then
    items[#items + 1] = info_line('播放流程', tostring(flow.summary or flow.reason))
  end
  items[#items + 1] = { title = '', separator = true, value = 'ignore', selectable = false }
  items[#items + 1] = item('刷新读数', { 'menu', 'status' }, {
    icon = 'refresh', hint = '重新读取 mpv 实时属性',
  })

  open_menu {
    type = 'sakana-status',
    title = '播放状态',
    footnote = '只读读数 · 来自 mpv 属性与主进程播放状态；取不到的项写「暂不可用」',
    items = items,
  }
  -- 自检证据：菜单确实构造出来了，且拿到的是哪一版 uosc
  msg.info(string.format('播放状态菜单已构造：%d 项（uosc=%s，线路=%d 集=%d）',
    #items, uosc_version ~= '' and uosc_version or 'unknown', line, ep))
end

local MENUS = {
  episodes = menu_episodes,
  lines = menu_lines,
  subtitle = menu_subtitle,
  speed = menu_speed,
  volume = menu_volume,
  aspect = menu_aspect,
  danmaku = menu_danmaku,
  quality = menu_quality,
  -- v1.1.4：「播放状态」按钮打开的就是这一项
  status = menu_status,
}

open_named_menu = function(name)
  local fn = MENUS[tostring(name or '')]
  if not fn then
    msg.error('未知菜单：' .. tostring(name))
    return
  end
  local ok, err = pcall(fn)
  if not ok then msg.error('打开菜单失败：' .. tostring(err)) end
end

-- ─────────────────────────── 消息注册 ───────────────────────────

mp.register_script_message('sakana-state', function(json)
  local data = utils.parse_json(json)
  if type(data) ~= 'table' then
    msg.error('sakana-state：收到的不是合法 JSON 表')
    return
  end
  state = data
  update_buttons(true)
  update_subtitle()
end)

--- v1.1.4：主进程每秒推来的播放状态（`sakana-status` 菜单的读数源）。
--- 只缓存、不立即刷新菜单：uosc 菜单是"打开那一刻构造一次"的模型，
--- 菜单开着时重新构造会把用户的选择位置打乱；要刷新就点菜单底部的「刷新读数」。
mp.register_script_message('sakana-playback-status', function(json)
  local data = utils.parse_json(json)
  if type(data) ~= 'table' then
    msg.error('sakana-playback-status：收到的不是合法 JSON 表')
    return
  end
  playback = data
end)

--- 按钮 / 菜单项 / input.conf 快捷键都发到这里。
--- `menu <名字>` 是本脚本自己处理的（弹 uosc 菜单），其余一律回传给应用。
mp.register_script_message('sakana-ctrl', function(action, ...)
  local name = tostring(action or '')
  if name == 'menu' then
    open_named_menu((...))
    return
  end
  emit(action, ...)
end)

-- 允许直接请求菜单：`script-message sakana-menu episodes`
mp.register_script_message('sakana-menu', function(name) open_named_menu(name) end)

-- ─────────────────────────── 初始化 ───────────────────────────

-- 按钮先给一份「占位态」：状态还没下来时按钮不是空的
update_buttons(true)

-- uosc 加载完会广播 `script-message uosc-version <版本>`（main.lua 第一行）。
-- 本脚本比 uosc 先加载，所以最初的 set-button 会打空 —— 收到这条广播后强制重发一次。
-- （uosc_danmaku 也监听这条消息；主进程另外还会补发一次作为兜底。）
mp.register_script_message('uosc-version', function(version)
  uosc_version = tostring(version or '')
  uosc_seen = true
  force_all = true
  update_buttons(true)
  -- 这一行是"控制栏真的由 uosc 接管、且按钮真的下发了"的直接证据。
  -- 主进程还会把同一份统计（user-data/sakana-uosc-stats）读出来写进应用日志。
  local names = {}
  for name in pairs(last_button_json) do names[#names + 1] = name end
  table.sort(names)
  msg.info(string.format('[sakana-uosc] uosc 已就绪 version=%s，已下发 %d 个按钮 / %d 次 set-button：[%s]',
    uosc_version, #names, set_button_calls, table.concat(names, ',')))
end)

-- 兜底刷新：状态推送是「变化才推」，而切集/重挂载会重建 mpv 实例（本脚本随之重载）。
-- uosc 还没确认加载前每次强制重发（防止 set-button 打空），确认之后只发变化。
mp.add_periodic_timer(2, function()
  if state == nil then return end
  update_buttons(not uosc_seen)
end)

-- ─────────────────────── 鼠标命中诊断（仅自检，v0.3.2） ───────────────────────
--
-- 排查「uosc 控制栏呼不出来」时，最关键的问题是：**mpv 窗口到底收不收得到鼠标事件**。
-- 光看窗口类名和 z 序只能推测，这里让 mpv 自己说话：`mouse-pos` 是 mpv 对每个鼠标事件的
-- 记录，把它写成可读属性（`user-data/sakana-mouse`），Electron 侧读一下就知道有没有。
--
-- 只在环境变量 SAKANA_UOSC_TEST 存在时启用 → 正常播放时这个定时器根本不会创建，
-- 不产生任何开销、也不污染 mpv 的属性空间。
if os.getenv('SAKANA_UOSC_TEST') then
  mp.add_periodic_timer(0.5, function()
    local pos = mp.get_property_native('mouse-pos')
    if type(pos) ~= 'table' then
      mp.set_property('user-data/sakana-mouse', 'hover=0 x=- y=-')
      return
    end
    local hover = pos.hover and 1 or 0
    mp.set_property('user-data/sakana-mouse',
      string.format('hover=%d x=%d y=%d', hover, math.floor(pos.x or -1), math.floor(pos.y or -1)))
  end)
  msg.info('鼠标命中诊断已启用（user-data/sakana-mouse）')
end

-- ─────────────────────── 存活标记（v0.3.3） ───────────────────────
--
-- 脚本跑到这里才算真的活着。Electron 侧会在加载后等一会儿读这个属性：
-- 读不到就说明脚本在运行时报错退出了（`load-script` 对这种情况依然返回成功），
-- 那时控制栏会一个按钮都没有 —— 应用会据此回落到自己的悬浮窗控制栏，并写一条错误日志。
--
-- ⚠️ 改动本文件后请务必确认这条属性真的写出来了：Lua 的语法错误会让整个脚本静默退出。
local SCRIPT_VERSION = '2026-10-uosc-ctrl-v4'
mp.set_property('user-data/sakana-ctrl-ready', SCRIPT_VERSION)

msg.info('sakana-uosc-ctrl 已加载（控制栏按钮 + 菜单 + 动作回传，版本 ' .. SCRIPT_VERSION .. '）')
