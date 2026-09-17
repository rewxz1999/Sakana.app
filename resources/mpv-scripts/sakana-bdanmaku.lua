--[[
Sakana B 站弹幕脚本（v0.2.8 附加七）

用途：把 B 站视频的弹幕抓下来、转成 ASS 并挂到 mpv 上显示。

为什么自带一份而不是直接用 bdanmaku：
  bdanmaku 依赖 biliass（Rust 可执行文件）与 yt-dlp，二者都需要从 GitHub Release 下载；
  本机网络到 github.com / objects.githubusercontent.com 不通，无法随包分发。
  所以这里内置一个**同管线**的实现（yt-dlp 取 danmaku 字幕 → biliass 转 ASS → sub-add），
  并在设置里允许指向你自己下载的 bdanmaku.lua（那时会优先用它）。

管线：
  1. 由宿主（Electron 主进程）通过 `script-message sakana-source <播放页地址>` 告知当前播放的页面；
  2. 只处理 bilibili 链接（BV/av/ep/ss）；
  3. yt-dlp --skip-download --write-subs --sub-langs danmaku --sub-format xml
     （同时用 --paths temp:<tmpdir> 把它的临时文件也压到 tmpdir）
  4. biliass --input <xml> --output <ass>（Windows 上 biliass 需要一个可写的 tmpdir，
     这里把子进程的 TMP/TEMP/TMPDIR 指向配置的 tmpdir —— 与 script-opts=tmpdir=… 同一个作用）
  5. mp.commandv('sub-add', <ass>, 'select')

无法在本机联网实测的部分都做了兜底（见注释 K1/K2/K3），失败原因一律写进日志。

配置（script-opts，主进程会自动拼好）：
  enabled=yes|no
  ytdlp=<yt-dlp 可执行文件路径>
  biliass=<biliass 可执行文件路径>
  tmpdir=<临时目录>
  log=<日志文件路径，默认 <tmpdir>/sakana-bdanmaku.log>
--]]

local mp = require 'mp'
local msg = require 'mp.msg'
local utils = require 'mp.utils'

local opts = {
  enabled = 'no',
  ytdlp = 'yt-dlp',
  biliass = 'biliass',
  tmpdir = '',
  log = ''
}

local isWindows = package.config:sub(1, 1) == '\\'

--[[ script-opts 的键有两套写法：裸键（tmpdir=…）与带脚本名前缀（sakana-bdanmaku-tmpdir=…）。
     bdanmaku 的文档用的是裸键，但 mpv 自身脚本（如 osc）习惯用前缀，
     这里两种都认，避免用户照抄某一份文档时静默失效。 ]]
local scriptName = 'sakana-bdanmaku'
if mp.get_script_name then
  local n = mp.get_script_name()
  if n and n ~= '' then scriptName = n end
end

local function opt(name)
  local v = mp.get_opt(name)
  if v == nil or v == '' then v = mp.get_opt(scriptName .. '-' .. name) end
  if v == nil or v == '' then return opts[name] end
  return v
end

local function logLine(line)
  local path = opt('log')
  if path == '' then
    local dir = opt('tmpdir')
    if dir == '' then return end
    path = utils.join_path(dir, 'sakana-bdanmaku.log')
  end
  local f = io.open(path, 'a')
  if not f then return end
  f:write(os.date('%Y-%m-%d %H:%M:%S ') .. tostring(line) .. '\n')
  f:close()
end

local function ensureDir(dir)
  if dir == '' then return end
  -- mpv 的 Lua 没有 mkdir；用系统命令建（主进程通常已经建好了，这里是兜底）
  local cmd
  if isWindows then
    cmd = { 'cmd', '/c', 'if not exist "' .. dir .. '" mkdir "' .. dir .. '"' }
  else
    cmd = { 'mkdir', '-p', dir }
  end
  mp.command_native({ name = 'subprocess', args = cmd, playback_only = false,
                     capture_stdout = true, capture_stderr = true })
end

local function isBili(url)
  if type(url) ~= 'string' then return false end
  if url:find('bilibili%.com') then return true end
  if url:find('b23%.tv') then return true end
  return url:find('BV[%w]+') ~= nil
end

--[[ K2：mpv 的 subprocess 参数表在不同版本上支持度不同（`env` 是较新版本才有的）。
     先按最完整的参数跑一次，若直接失败（连进程都没起来）就去掉 env 再试一次，
     免得因为一个可选字段让整条管线哑掉。 ]]
local function spawn(args, env, cb)
  local params = {
    name = 'subprocess',
    args = args,
    playback_only = false,
    capture_stdout = true,
    capture_stderr = true
  }
  if env then params.env = env end
  mp.command_native_async(params, function(success, res, err)
    if not success and env then
      logLine('带 env 的子进程启动失败，去掉 env 重试：' .. tostring(err))
      local retry = {
        name = 'subprocess',
        args = args,
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true
      }
      mp.command_native_async(retry, cb)
      return
    end
    cb(success, res, err)
  end)
end

local function clearRunDir(runDir)
  local files = utils.readdir(runDir, 'files') or {}
  for _, name in ipairs(files) do
    os.remove(utils.join_path(runDir, name))
  end
end

--[[ K1：每次运行固定使用 <tmpdir>/run 作为工作目录，并在开始前清空，
     避免上一集的 xml 被当成这一次的结果（曾考虑用时间戳目录，但会无限堆积）。 ]]
local function runPipeline(pageUrl)
  if opt('enabled') ~= 'yes' then
    logLine('未启用（enabled != yes），跳过：' .. tostring(pageUrl))
    return
  end
  if not isBili(pageUrl) then
    logLine('不是 B 站地址，跳过：' .. tostring(pageUrl))
    return
  end
  local tmpdir = opt('tmpdir')
  if tmpdir == '' then
    logLine('缺少 tmpdir，无法工作（biliass 在 Windows 上必须有一个可写的临时目录）')
    return
  end
  ensureDir(tmpdir)
  local runDir = utils.join_path(tmpdir, 'run')
  ensureDir(runDir)
  clearRunDir(runDir)
  logLine('开始处理：' .. pageUrl .. '（tmpdir=' .. tmpdir .. '）')

  local ytdlpArgs = {
    opt('ytdlp'),
    '--skip-download',
    '--no-playlist',
    '--write-subs',
    '--sub-langs', 'danmaku',
    '--sub-format', 'xml',
    '--paths', 'temp:' .. tmpdir,
    '-o', utils.join_path(runDir, '%(id)s'),
    pageUrl
  }
  local env = { TMP = tmpdir, TEMP = tmpdir, TMPDIR = tmpdir }

  spawn(ytdlpArgs, env, function(success, res, err)
    if not success or not res or res.status ~= 0 then
      logLine('yt-dlp 失败：' .. tostring(err or (res and res.stderr) or '未知原因'))
      return
    end
    local files = utils.readdir(runDir, 'files')
    if not files then
      logLine('读取工作目录失败：' .. runDir)
      return
    end
    local xml
    for _, name in ipairs(files) do
      if name:find('%.xml$') then xml = utils.join_path(runDir, name) end
    end
    if not xml then
      logLine('yt-dlp 成功但没有产出弹幕 xml（该视频可能没有弹幕，或该版本 yt-dlp 不支持 danmaku 字幕）')
      return
    end
    local ass = xml:gsub('%.xml$', '.ass')
    logLine('yt-dlp 完成：' .. xml)

    --[[ K3：biliass 的 CLI 参数形式按版本有 `--input/--output` 与 `-i/-o` 两种，
         先试长参数，失败再试短参数。 ]]
    local function convert(longForm)
      local args
      if longForm then
        args = { opt('biliass'), '--input', xml, '--output', ass }
      else
        args = { opt('biliass'), '-i', xml, '-o', ass }
      end
      spawn(args, env, function(ok2, res2, err2)
        if not ok2 or not res2 or res2.status ~= 0 then
          if longForm then
            logLine('biliass 长参数失败，改用 -i/-o 重试：' .. tostring(err2 or (res2 and res2.stderr) or ''))
            convert(false)
          else
            logLine('biliass 失败：' .. tostring(err2 or (res2 and res2.stderr) or '未知原因'))
          end
          return
        end
        logLine('biliass 完成，挂载字幕：' .. ass)
        mp.commandv('sub-add', ass, 'select')
      end)
    end
    convert(true)
  end)
end

local pending = nil

mp.register_script_message('sakana-source', function(url)
  -- 主进程可能连续发（切集/重挂载），后到的覆盖先到的
  pending = url
  mp.add_timeout(0.2, function()
    if pending == url then runPipeline(url) end
  end)
end)

mp.register_event('file-loaded', function()
  logLine('文件已加载（等待宿主通过 sakana-source 告知播放页地址）')
end)

logLine('脚本已加载：enabled=' .. opt('enabled') .. ' ytdlp=' .. opt('ytdlp') ..
        ' biliass=' .. opt('biliass') .. ' tmpdir=' .. opt('tmpdir'))
msg.info('Sakana B 站弹幕脚本已加载')
