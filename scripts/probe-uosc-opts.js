/*
 * uosc 配置机制探针（v0.2.18「uosc 接管控制栏」用）
 *
 * 为什么需要它：uosc 读配置有两条路（`<config-dir>/script-opts/uosc.conf` 与 `--script-opts=uosc-<键>=<值>`），
 * 而本应用给 libmpv 设了 `config=no`（见 native/mpv/src/addon.cc 的默认选项），
 * 且 `controls` 这类选项的值**含逗号**（逗号是 `--script-opts` 的键值分隔符）。
 * 这两点决定了配置文件该怎么写，所以先用无窗口（vo=null）的 libmpv 实测一遍，不靠猜。
 *
 * 用法（每次运行都会重建实例，所以一项一项跑）：
 *   node scripts/probe-uosc-opts.js             # config=no（应用现状）+ 转义逗号
 *   node scripts/probe-uosc-opts.js --config    # config=yes：读 uosc.conf（关键一条）
 *   node scripts/probe-uosc-opts.js --config --shim   # 再加载 sakana-uosc-ctrl.lua，测动作回传通道
 *
 * 产出：.tmp-test/uosc-probe/report.json（探针 lua 写出的实测结果，目录已被 .gitignore 覆盖）
 */
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const napi = require(path.join(ROOT, 'native', 'mpv', 'build', 'Release', 'sakana_mpv.node'))
const DLL = path.join(ROOT, 'resources', 'libmpv', 'libmpv-2.dll')
const CFG = path.join(ROOT, 'resources', 'mpv-config')
const OUT = path.join(ROOT, '.tmp-test', 'uosc-probe')
fs.mkdirSync(OUT, { recursive: true })
const REPORT = path.join(OUT, 'report.json')
try {
  fs.unlinkSync(REPORT)
} catch {
  /* 首次运行没有旧文件 */
}

const wantConfig = process.argv.includes('--config')
const wantShim = process.argv.includes('--shim')
const slash = (p) => p.replace(/\\/g, '/')

/*
 * 探针 lua 用的是 uosc 内部**同一条**代码路径：mp.options.read_options(表, 'uosc')。
 * 默认值抄自 scripts/uosc/main.lua 的 defaults（类型必须一致，否则 mp.options 的行为不同）。
 */
const probeLua = path.join(OUT, 'probe.lua')
fs.writeFileSync(
  probeLua,
  `local mp = require 'mp'
local utils = require 'mp.utils'
local opts_mod = require 'mp.options'

local function safe(f)
  local ok, v = pcall(f)
  if ok then return v end
  return 'ERR:' .. tostring(v)
end

local out = {}
out.scenario = ${JSON.stringify(wantConfig ? 'config=yes' : 'config=no')}
out.find_config = safe(function() return mp.find_config_file('script-opts/uosc.conf') end)
out.expand_tilde = safe(function() return mp.command_native({'expand-path', '~~/script-opts/uosc.conf'}) end)
out.mpv_config_opt = safe(function() return mp.get_property_native('config') end)
out.load_scripts_opt = safe(function() return mp.get_property_native('load-scripts') end)
out.script_opts_map = safe(function() return mp.get_property_native('script-opts') end)

-- 与 uosc 完全一样：read_options(表, 'uosc')，默认值故意写成哨兵串
local t = {
  timeline_style = 'line', timeline_line_width = 2, timeline_size = 40, timeline_step = '5',
  timeline_cache = true, timeline_heatmap = 'overlay', timeline_persistency = '',
  progress = 'windowed', progress_size = 2, destination_time = 'playtime-remaining',
  time_precision = 0,
  controls = 'DEFAULT', controls_size = 32, controls_margin = 8, controls_spacing = 2,
  controls_persistency = '',
  volume = 'right', volume_size = 40, volume_step = 1,
  top_bar = 'no-border', top_bar_size = 40, top_bar_controls = 'right',
  top_bar_title = 'yes', top_bar_alt_title = '', top_bar_alt_title_place = 'below',
  top_bar_flash_on = 'video,audio',
  window_border_size = 1,
  proximity_in = 40, proximity_out = 120, border_radius = 4, animation_duration = 100,
  pause_indicator = 'flash', menu_item_height = 36, menu_min_width = 260,
  disable_elements = '', autohide = false,
  -- 只给探针自己用的哨兵键：用来观察 --script-opts 里「逗号转义」到底发生了什么
  probe_comma = 'DEFAULT',
}
local ok, err = pcall(function() opts_mod.read_options(t, 'uosc') end)
out.read_ok = ok
out.read_err = tostring(err)
-- 逐项把「值 + Lua 类型」写出来：类型很重要（'no' 字符串在 Lua 里是**真值**！）
local resolved = {}
for k, v in pairs(t) do resolved[k] = tostring(v) .. '  <' .. type(v) .. '>' end
out.resolved = resolved

-- user-data 通道：应用实例化后由探针自己写读一遍（动作回传要用它）
local function try(f) return safe(f) end
out.ud_set_nested = try(function() mp.set_property('user-data/sakana/subtitle', 'nested'); return mp.get_property('user-data/sakana/subtitle') end)
out.ud_set_flat = try(function() mp.set_property('user-data/sakana-subtitle', 'flat-中文'); return mp.get_property('user-data/sakana-subtitle') end)
out.ud_expand_nested = try(function() return mp.command_native({'expand-text', '\${user-data/sakana/subtitle}'}) end)
out.ud_expand_flat = try(function() return mp.command_native({'expand-text', '\${user-data/sakana-subtitle}'}) end)
out.ud_observe = 'pending'

-- 观察 user-data 子键是否可被 observe（uosc 顶栏 alt_title 就靠它）
local obs_events = {}
local function on_ud(name, value) obs_events[#obs_events + 1] = name .. '=' .. tostring(value) end
out.ud_observe_reg = try(function() mp.observe_property('user-data/sakana-subtitle', 'native', on_ud); return true end)
mp.add_timeout(0.4, function() mp.set_property('user-data/sakana-subtitle', 'changed-第二次') end)
mp.add_timeout(0.9, function() out.ud_observe = table.concat(obs_events, ' | ') end)

-- script-message 的参数是分开传还是拼成一个串？（按钮/菜单项都靠它传参）
local msg_seen = 'pending'
mp.register_script_message('probe-multi', function(...)
  local n = select('#', ...)
  local parts = {}
  for i = 1, n do parts[#parts + 1] = '[' .. tostring(select(i, ...)) .. ']' end
  msg_seen = n .. ' 个参数: ' .. table.concat(parts, ' ')
end)
mp.add_timeout(1.1, function() out.script_message_args = msg_seen end)

mp.add_timeout(1.4, function()
  local f = io.open(${JSON.stringify(slash(REPORT))}, 'w')
  f:write(utils.format_json(out))
  f:close()
end)
`,
  'utf8'
)

if (!fs.existsSync(DLL)) {
  console.error('缺少 libmpv-2.dll:', DLL)
  process.exit(2)
}
if (!napi.load(DLL)) {
  console.error('libmpv 加载失败:', napi.lastError())
  process.exit(3)
}

/*
 * controls 这类含逗号的值**绝不能**放 --script-opts：
 * 这里用探针自己的哨兵键 probe_comma 复现「`\,` 转义救不了」的现象，
 * 真正的布局配置全部走 script-opts/uosc.conf（下面 uosc 加载时会用 debug 日志把
 * 它实际读到的 options 打出来，用那一行来确认 conf 生效）。
 */
const scriptOpts = ['uosc-timeline_step=7', 'uosc-probe_comma=aaa\\,bbb\\,ccc'].join(',')

const options = {
  vo: 'null',
  ao: 'null',
  osc: 'no',
  'config-dir': slash(CFG),
  'script-opts': scriptOpts,
  /*
   * load-scripts=no 是**必须**的：libmpv 的默认值是 true（探针实测），
   * 配上 config=yes 后 mpv 会在 mpv_initialize 时自动加载 <config-dir>/scripts/*
   * （日志里能看到 `[uosc] Loading lua script ...` 出现在 create 之前），
   * 我们再显式 load-script 一次就会得到**两份 uosc**（画面里两套控制栏、两份弹幕）。
   * 这里关掉自动加载，脚本的加载顺序完全由 mpv.ts 掌握。
   */
  'load-scripts': 'no',
  terminal: 'yes',
  // uosc=debug：mp.options 会把读到的每个选项打出来 → 用来证明 uosc 确实拿到了 conf
  'msg-level': 'all=warn,uosc=debug'
}
if (wantConfig) options.config = 'yes'

console.log(`[probe] 场景=${wantConfig ? 'config=yes' : 'config=no'} shim=${wantShim} config-dir=${slash(CFG)}`)
const ok = napi.create({ x: 0, y: 0, width: 1280, height: 720, options })
console.log('[probe] create:', ok ? '成功' : `失败 → ${napi.lastError()}`)
if (!ok) process.exit(4)

napi.command(['load-script', slash(probeLua)])
setTimeout(() => napi.command(['script-message', 'probe-multi', 'a', 'b', 'c']), 300)
if (wantShim) {
  const shim = path.join(ROOT, 'resources', 'mpv-scripts', 'sakana-uosc-ctrl.lua')
  const loadedShim = napi.command(['load-script', slash(shim)])
  console.log('[probe] load-script shim:', loadedShim, shim)
}
// uosc 本体最后加载（与 mpv.ts 里的加载顺序一致）：有配置错误会打到 stderr
setTimeout(() => {
  const loadedUosc = napi.command(['load-script', slash(path.join(CFG, 'scripts', 'uosc'))])
  console.log('[probe] load-script uosc:', loadedUosc)
}, 100)

setTimeout(() => {
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
  } catch (err) {
    console.log('[probe] 读不到探针报告:', String(err && err.message))
  }
  console.log('[probe] 探针报告:', JSON.stringify(report, null, 2))

  if (wantShim) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const ctrlProp = () => napi.getProperty('user-data/sakana-ctrl')
    const clearCtrl = () => napi.command(['set', 'user-data/sakana-ctrl', ''])
    void (async () => {
      /*
       * 1) input.conf 是否被加载：用 mpv 的 keypress 模拟按键。
       *    n 绑的是 script-message sakana-ctrl next-episode，
       *    走完 ①input.conf → ②脚本消息 → ③shim 写属性 后应当读到 next-episode。
       *    注意必须放在「开菜单」之前测：uosc 的菜单会注册 forced 键位把按键吃掉
       *    （any_unicode 用于搜索输入），那样按键就进不到 input.conf 了。
       */
      napi.command(['keypress', 'n'])
      await wait(500)
      console.log('[probe] input.conf 按键 n →', JSON.stringify(ctrlProp()), '（期望 "next-episode"）')
      clearCtrl()
      napi.command(['keypress', 'f'])
      await wait(500)
      console.log('[probe] input.conf 按键 f →', JSON.stringify(ctrlProp()), '（期望 "toggle-fullscreen"）')
      clearCtrl()

      // 2) 状态下行：应用推状态 → shim 转成 set-button 下发给 uosc（不该产生动作）
      napi.command([
        'script-message',
        'sakana-state',
        JSON.stringify({
          title: '测试番剧',
          subtitle: '第 3 集 · 线路 1/2',
          playing: true,
          speed: 1.5,
          aspect: 'cover',
          fullscreen: false,
          canPrev: true,
          canNext: true,
          currentLine: 0,
          currentEp: 2,
          subId: 1,
          subs: [{ id: 1, label: '简体中文' }],
          lines: [
            { name: '线路 1', episodes: ['第 1 集', '第 2 集', '第 3 集'] },
            { name: '线路 2', episodes: ['第 1 集', '第 2 集'] }
          ],
          danmaku: { enabled: true, count: 128, area: 0.5, maxCount: 20, offsetMs: 0, showScroll: true, showTop: true, showBottom: true, pluginActive: false, source: '测试番剧 第03集' },
          status: { kind: 'playing', text: '播放中' }
        })
      ])
      await wait(500)
      console.log('[probe] 状态下行后 user-data/sakana-ctrl =', JSON.stringify(ctrlProp()), '（期望空：状态不该产生动作）')

      /*
       * 2.5) 逐个打开全部菜单：这一步验证六个菜单构造器里的 JSON 生成
       *      （嵌套子菜单、表格形式的 value、activate 标记…）不报 Lua 错误。
       *      有错的话 mpv 会把 `Lua error: ...` 打到 stderr，日志里能直接看到。
       */
      for (const menu of ['episodes', 'lines', 'subtitle', 'speed', 'aspect', 'danmaku']) {
        napi.command(['script-message', 'sakana-menu', menu])
        await wait(180)
      }
      console.log('[probe] 六个菜单已依次打开（请检查上面 stderr 有无 Lua error）')
      napi.command(['script-message-to', 'uosc', 'close-menu', 'sakana-danmaku'])
      await wait(200)

      // 3) 菜单动作必须被脚本自己吃掉（弹 uosc 菜单），不能回传给应用
      napi.command(['script-message', 'sakana-ctrl', 'menu', 'speed'])
      await wait(500)
      console.log('[probe] menu speed 后 user-data/sakana-ctrl =', JSON.stringify(ctrlProp()), '（期望空：菜单在 mpv 侧处理）')
      // 关掉菜单，并确认关闭消息可用（菜单会强制接管键盘，不关掉后面的按键测不了）
      napi.command(['script-message-to', 'uosc', 'close-menu', 'sakana-speed'])
      await wait(300)
      clearCtrl()
      napi.command(['keypress', 'd'])
      await wait(500)
      console.log('[probe] input.conf 按键 d →', JSON.stringify(ctrlProp()), '（期望空：d 是弹幕菜单，被拦在 mpv 侧）')
      napi.command(['script-message-to', 'uosc', 'close-menu', 'sakana-danmaku'])
      await wait(300)
      clearCtrl()

      // 4) 普通动作要回传：模拟「uosc 菜单项被点中」（菜单项 value 就是这条命令）
      napi.command(['script-message', 'sakana-ctrl', 'select-episode', '2', '7'])
      napi.command([
        'script-message-to',
        'uosc',
        'set-button',
        'sakana-danmaku',
        JSON.stringify({ icon: 'subtitles', command: 'script-message sakana-ctrl toggle-danmaku' })
      ])
      await wait(500)
      console.log('[probe] 菜单项动作回传 user-data/sakana-ctrl =', JSON.stringify(ctrlProp()), '（期望 "select-episode 2 7"）')

      napi.destroy()
      process.exit(0)
    })()
    return
  }
  napi.destroy()
  process.exit(0)
}, 1800)
