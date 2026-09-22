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
    danmaku-json <json>             {"key":…,"value":…} → 应用的一条弹幕设置
    uosc-menu <search|total|style|delay|add>   打开 uosc_danmaku 插件自己的菜单
    open-danmaku-settings / reload-danmaku / detect-danmaku-alias
    toggle-info / snapshot / toggle-fullscreen / exit / escape

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

--- 应用推来的控制栏状态（结构见 src/shared/api.ts 的 UoscBarState）
local state = nil
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

--- 倍速显示成 1x / 1.5x / 2x（与旧控制栏一致）
local function fmt_speed(v)
  local n = tonumber(v) or 1
  if math.abs(n - math.floor(n)) < 0.001 then return string.format('%.1f', n) end
  return tostring(n)
end

local ASPECT_LABEL = { fit = '适应', cover = '裁剪铺满', stretch = '拉伸铺满' }

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

  -- 播放控制（上一集/下一集在不可用时直接隐藏，与旧控制栏的 canPrev/canNext 语义一致）
  ctrl_button {
    name = 'sakana-prev', icon = 'skip_previous', tooltip = '上一集',
    action = can_prev and { 'prev-episode' } or nil, hide = not can_prev,
  }
  ctrl_button {
    name = 'sakana-next', icon = 'skip_next', tooltip = '下一集',
    action = can_next and { 'next-episode' } or nil, hide = not can_next,
  }
  ctrl_button { name = 'sakana-back10', icon = 'replay_10', tooltip = '后退 10 秒', action = { 'back10' } }
  ctrl_button { name = 'sakana-forward10', icon = 'forward_10', tooltip = '前进 10 秒', action = { 'forward10' } }

  -- 选集 / 线路：没有剧集数据就隐藏（本地单文件播放本来就没有「集」可切）
  ctrl_button {
    name = 'sakana-episodes', icon = 'playlist_play', tooltip = '选集',
    action = has_episodes and { 'menu', 'episodes' } or nil, hide = not has_episodes,
  }
  ctrl_button {
    name = 'sakana-line', icon = 'hd', tooltip = '线路切换',
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
  ctrl_button { name = 'sakana-danmaku-settings', icon = 'tune', tooltip = '弹幕设置', action = { 'menu', 'danmaku' } }

  -- 详情 / 截图 / 全屏 / 退出
  ctrl_button { name = 'sakana-info', icon = 'info', tooltip = '番剧详情', action = { 'toggle-info' } }
  ctrl_button { name = 'sakana-snapshot', icon = 'photo_camera', tooltip = '截图', action = { 'snapshot' } }
  ctrl_button {
    name = 'sakana-fullscreen', icon = fullscreen and 'fullscreen_exit' or 'fullscreen',
    tooltip = fullscreen and '退出全屏' or '全屏播放', action = { 'toggle-fullscreen' }, active = fullscreen,
  }
  ctrl_button { name = 'sakana-exit', icon = 'exit_to_app', tooltip = '退出播放', action = { 'exit' } }
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
  local offset_ms = to_int(field(dm, 'offsetMs', 0), 0)
  local show_scroll = field(dm, 'showScroll', true)
  local show_top = field(dm, 'showTop', true)
  local show_bottom = field(dm, 'showBottom', true)
  local plugin = field(dm, 'pluginActive', false)
  local source = tostring(field(dm, 'source', ''))

  local area_items = {}
  for _, o in ipairs({ { 0.25, '1/4' }, { 0.5, '1/2' }, { 0.75, '3/4' }, { 1, '全屏' } }) do
    area_items[#area_items + 1] = item(o[2], dm_menu_value('area', o[1]), { active = math.abs(area - o[1]) < 0.01 })
  end

  local count_items = {}
  for _, n in ipairs({ 10, 20, 30, 50, 80 }) do
    count_items[#count_items + 1] = item(n .. ' 条', dm_menu_value('maxCount', n), { active = n == max_count })
  end

  -- 时间轴：+/- 0.5 秒，中间那行只显示当前值（不可选）
  local delay_items = {
    item('−0.5 秒', dm_menu_value('offsetMs', offset_ms - 500)),
    { title = '当前 ' .. string.format('%.1f', offset_ms / 1000) .. ' 秒', value = 'ignore', selectable = false, muted = true },
    item('+0.5 秒', dm_menu_value('offsetMs', offset_ms + 500)),
    item('重置为 0', dm_menu_value('offsetMs', 0), { active = offset_ms == 0 }),
  }

  local type_items = {
    item('滚动弹幕', dm_menu_value('showScroll', not show_scroll), { active = show_scroll }),
    item('顶部弹幕', dm_menu_value('showTop', not show_top), { active = show_top }),
    item('底部弹幕', dm_menu_value('showBottom', not show_bottom), { active = show_bottom }),
  }

  local items = {
    item(enabled and '关闭弹幕' or '打开弹幕', { 'toggle-danmaku' },
      { active = enabled, icon = enabled and 'comment' or 'comments_disabled' }),
    { title = '覆盖区域', hint = '屏幕的几分之一', items = area_items },
    { title = '弹幕数量', hint = '同屏最多几条', items = count_items },
    { title = '时间轴微调', hint = string.format('%.1f 秒', offset_ms / 1000), items = delay_items },
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
  items[#items + 1] = item('重新检测弹幕', { 'reload-danmaku' }, { icon = 'refresh' })
  items[#items + 1] = item('别名检测弹幕', { 'detect-danmaku-alias' }, { icon = 'search' })
  items[#items + 1] = item('更多设置…', { 'open-danmaku-settings' }, { icon = 'settings' })

  open_menu {
    type = 'sakana-danmaku',
    title = '弹幕设置',
    footnote = source ~= '' and ('当前来源：' .. source) or '未匹配到弹幕库条目',
    items = items,
  }
end

local MENUS = {
  episodes = menu_episodes,
  lines = menu_lines,
  subtitle = menu_subtitle,
  speed = menu_speed,
  aspect = menu_aspect,
  danmaku = menu_danmaku,
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
  uosc_seen = true
  force_all = true
  update_buttons(true)
  msg.info('uosc 已就绪（' .. tostring(version) .. '），控制栏按钮已重发')
end)

-- 兜底刷新：状态推送是「变化才推」，而切集/重挂载会重建 mpv 实例（本脚本随之重载）。
-- uosc 还没确认加载前每次强制重发（防止 set-button 打空），确认之后只发变化。
mp.add_periodic_timer(2, function()
  if state == nil then return end
  update_buttons(not uosc_seen)
end)

msg.info('sakana-uosc-ctrl 已加载（控制栏按钮 + 菜单 + 动作回传）')
