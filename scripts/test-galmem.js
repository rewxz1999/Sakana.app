/*
 * galmem 只读内存识别验证脚本（koffi 后端，**不需要编译器**）：
 *
 *   node scripts/test-galmem.js
 *
 * 验证点：
 *   1) 起一个假进程（scripts/galmem-fixture.js，内存里有音频/脚本文件名），只读扫描它，
 *      断言能命中那些名字；
 *   2) 再对一个真实进程（本脚本自己这个 node.exe）扫一遍，确认不崩、不卡，打印耗时与读取字节数；
 *   3) 断言绑定的系统 API 白名单没有被放宽（只读红线是代码里可验证的事实，不只是注释）。
 *
 * 依赖 Node ≥ 22.18 / 24（原生 TypeScript 类型剥离），这样可以直接 require 主进程里的 .ts 源码，
 * 不需要先编译、也不需要 MSVC。
 *
 * ★ 只读：脚本只用 OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_INFORMATION) + ReadProcessMemory
 *   等只读 API，绝不写目标进程内存。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const WINMEM_TS = path.join(__dirname, '..', 'src', 'main', 'services', 'winMem.ts')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loadBackend() {
  try {
    return require(WINMEM_TS)
  } catch (e) {
    console.error('FAIL: 无法加载只读内存后端 src/main/services/winMem.ts:', e.message)
    console.error('      需要 Node ≥ 22.18 / 24（原生 TypeScript 类型剥离），当前 ' + process.version)
    process.exit(2)
  }
}

/** 1) 只读白名单断言 */
function checkBoundApis(winMem) {
  const expect = [
    'OpenProcess',
    'CloseHandle',
    'ReadProcessMemory',
    'VirtualQueryEx',
    'CreateToolhelp32Snapshot',
    'Process32FirstW',
    'Process32NextW',
    'Module32FirstW',
    'Module32NextW',
    'EnumWindows',
    'GetWindowThreadProcessId',
    'IsWindowVisible',
    'GetWindowTextW',
    'GetLastError'
  ].sort()
  const actual = [...winMem.BOUND_API_NAMES].sort()
  const same = actual.length === expect.length && actual.every((n, i) => n === expect[i])
  console.log('绑定的系统 API 白名单 =', JSON.stringify(actual))
  console.log('白名单与预期一致 =', same)
  return same
}

async function scanFixture(winMem) {
  const pidFile = path.join(os.tmpdir(), 'galmem-test.pid')
  try {
    fs.unlinkSync(pidFile)
  } catch {}

  const fixture = path.join(__dirname, 'galmem-fixture.js')
  const child = spawn(process.execPath, [fixture], { stdio: 'ignore' })
  child.on('error', (e) => {
    console.error('FAIL: 起假进程失败:', e.message)
    process.exit(2)
  })

  let pid = null
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    try {
      const s = fs.readFileSync(pidFile, 'utf8').trim()
      if (s) {
        pid = parseInt(s, 10)
        break
      }
    } catch {}
  }
  if (!pid) {
    console.error('FAIL: 假进程未就绪')
    try {
      child.kill()
    } catch {}
    process.exit(2)
  }
  console.log('\n=== 假进程 ===')
  console.log('假进程 pid =', pid)

  const r = winMem.scanProcessMemory(pid)
  console.log('scan ok =', r.ok, ' error =', r.error || '(无)')
  console.log('stats =', JSON.stringify(r.stats))
  console.log('audio 候选数 =', r.audio.length, '（前 10 条）', JSON.stringify(r.audio.slice(0, 10)))
  console.log('audioMusic（音乐类，已去掉语音/音效）前 10 条 =', JSON.stringify(r.audioMusic.slice(0, 10)))
  console.log('scripts 候选 =', JSON.stringify(r.scripts, null, 2))

  const expectAudio = ['bgm001.ogg', 'bgm_daily.mp3', 'battle01.wav', 'opening_theme.flac', 'voice_001.opus']
  const expectScript = ['chapter01.ks', 'scenario_02.txt']
  const hitAudio = expectAudio.filter((n) => r.audio.some((a) => a.toLowerCase().endsWith(n.toLowerCase())))
  const hitScript = expectScript.filter((n) => r.scripts.some((a) => a.toLowerCase().endsWith(n.toLowerCase())))
  console.log('命中目标音频 =', JSON.stringify(hitAudio), `(${hitAudio.length}/${expectAudio.length})`)
  console.log('命中目标脚本 =', JSON.stringify(hitScript), `(${hitScript.length}/${expectScript.length})`)

  /*
   * 语音淹没回归（v0.3.9 的真实故障）：假进程里有 600 条 sound\vo\ 语音名，
   * 旧实现共用 400 条额度 → 前 400 条全是语音 → BGM 一条都进不来。
   * 现在按类分桶，BGM 必须照样出现，且排在候选最前面、音乐类里不混语音。
   */
  const head = r.audio.slice(0, 5)
  const voiceInMusic = r.audioMusic.filter((a) => /[\\/]vo[\\/]/i.test(a))
  const voiceCandidates = r.audio.filter((a) => /[\\/]vo[\\/]/i.test(a))
  const voiceFloodOk =
    hitAudio.length === expectAudio.length && // BGM 没被语音挤出候选
    head.some((a) => /bgm/i.test(a)) && // BGM 排在候选最前面
    voiceInMusic.length === 0 && // 音乐类候选里不混语音
    voiceCandidates.length >= 50 // 语音确实在内存里（否则这条回归是空的，说明夹具没生效）
  console.log('候选前 5 条 =', JSON.stringify(head))
  console.log('候选里的语音条数 =', voiceCandidates.length, '（独立额度，不会挤掉 BGM）')
  console.log('音乐类候选里混入的语音条数 =', voiceInMusic.length, '（应为 0）')
  console.log('语音淹没回归 =', voiceFloodOk ? 'PASS' : 'FAIL')

  // 再扫一次：验证可重复调用、不崩
  const r2 = winMem.scanProcessMemory(pid)
  console.log('第二次 scan ok =', r2.ok, ' audio 数 =', r2.audio.length)

  try {
    child.kill()
  } catch {}
  try {
    fs.unlinkSync(pidFile)
  } catch {}

  return hitAudio.length === expectAudio.length && hitScript.length === expectScript.length && voiceFloodOk
}

/** 2) 真实进程：扫自己这个 node.exe */
function scanSelf(winMem) {
  console.log('\n=== 真实进程（本脚本自己） ===')
  const procs = winMem.listProcesses()
  const self = procs.find((p) => p.pid === process.pid)
  const mods = winMem.listModules(process.pid)
  console.log('进程枚举 =', procs.length, '条；自己是 =', JSON.stringify(self))
  console.log('模块枚举 =', mods.length, '个；第一个 =', JSON.stringify({ name: mods[0] && mods[0].name, size: mods[0] && mods[0].size }))

  const t0 = Date.now()
  const r = winMem.scanProcessMemory(process.pid)
  const wall = Date.now() - t0
  console.log('scan ok =', r.ok, ' error =', r.error || '(无)')
  console.log('墙钟耗时(ms) =', wall, ' 内部 elapsedMs =', r.stats.elapsedMs)
  console.log('区域数 =', r.stats.regions, ' 读取字节数 =', r.stats.readBytes, ' 截断 =', r.stats.truncated)
  console.log('audio 候选数 =', r.audio.length, ' scripts 候选数 =', r.scripts.length, ' 窗口标题 =', JSON.stringify(r.windowTitle))
  return r.ok
}

/** 3) 权限不足 / 不存在的进程：必须给出可读的错误码而不是崩 */
function checkErrorPaths(winMem) {
  console.log('\n=== 错误路径 ===')
  const bad = winMem.scanProcessMemory(0x7ffffffe)
  console.log('扫一个不存在的 pid -> ok =', bad.ok, ' error =', bad.error || '(无)')
  const invalid = winMem.scanProcessMemory(0)
  console.log('扫 pid=0 -> ok =', invalid.ok, ' error =', invalid.error || '(无)')
  // 系统进程（PPL，普通权限打不开）：应当返回 ACCESS_DENIED，而不是崩
  const sys = winMem.listProcesses().find((p) => p.name.toLowerCase() === 'system')
  let deniedOk = true
  if (sys) {
    const r = winMem.scanProcessMemory(sys.pid)
    console.log('扫 System(pid=' + sys.pid + ') -> ok =', r.ok, ' error =', r.error || '(无)')
    deniedOk = !r.ok && r.error === 'ACCESS_DENIED'
    console.log('是否如期返回权限错误 =', deniedOk)
  } else {
    console.log('未找到 System 进程，跳过权限用例')
  }
  return bad.ok === false && invalid.ok === false && deniedOk
}

async function main() {
  const winMem = loadBackend()
  const status = winMem.winMemStatus()
  console.log('后端状态 =', JSON.stringify(status))
  if (!status.available) {
    console.error('FAIL: 后端不可用：', status.reason)
    process.exit(2)
  }

  const apiOk = checkBoundApis(winMem)
  const fixtureOk = await scanFixture(winMem)
  const selfOk = scanSelf(winMem)
  const errOk = checkErrorPaths(winMem)

  console.log('\n=== 结论 ===')
  console.log('白名单 =', apiOk ? 'PASS' : 'FAIL')
  console.log('假进程命中 =', fixtureOk ? 'PASS' : 'FAIL')
  console.log('真实进程扫描 =', selfOk ? 'PASS' : 'FAIL')
  console.log('错误路径 =', errOk ? 'PASS' : 'FAIL')
  const all = apiOk && fixtureOk && selfOk && errOk
  console.log(all ? 'PASS' : 'FAIL')
  process.exit(all ? 0 : 1)
}

main()
