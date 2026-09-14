// libmpv 原生插件单元测试：加载 DLL → 创建实例 → 播放测试视频 → 读取状态
const path = require('node:path')
const fs = require('node:fs')

const napi = require(path.join(__dirname, '..', 'native', 'mpv', 'build', 'Release', 'sakana_mpv.node'))
const DLL = path.join(__dirname, '..', 'resources', 'libmpv', 'libmpv-2.dll')
const VIDEO = path.join(__dirname, '..', '.testmedia', 'sample.mp4')

console.log('插件导出:', Object.keys(napi).join(', '))
if (!fs.existsSync(DLL)) {
  console.error('缺少 libmpv-2.dll:', DLL)
  process.exit(2)
}

console.log('1) 加载 libmpv:', napi.load(DLL) ? '成功' : `失败 → ${napi.lastError()}`)
if (!napi.load(DLL)) process.exit(3)

// 无窗口解码（vo=null）验证解码与状态读取；正式播放时由应用传入父窗口 HWND
const created = napi.create({ x: 0, y: 0, width: 1280, height: 720, options: { vo: 'null', ao: 'null' } })
console.log('2) 创建实例:', created ? '成功' : `失败 → ${napi.lastError()}`)
if (!created) process.exit(4)

console.log('3) libmpv 版本:', napi.getProperty('mpv-version'), '| 客户端 API:', napi.getProperty('mpv-client-api-version'))

const ok = napi.command(['loadfile', VIDEO, 'replace'])
console.log('4) loadfile:', ok ? '已下发' : `失败 → ${napi.lastError()}`)

let tries = 0
const timer = setInterval(() => {
  tries++
  const st = napi.state()
  console.log(
    `   [${tries}] time=${(st.time / 1000).toFixed(2)}s length=${(st.length / 1000).toFixed(2)}s paused=${st.paused} eof=${st.eof} idle=${st.idle}`
  )
  if (st.length > 0 && st.time > 0) {
    console.log('5) ✅ libmpv 正在解码播放（时长/进度已可读）')
    // 测试暂停与跳转
    napi.setProperty('pause', true)
    const st2 = napi.state()
    console.log('6) 暂停生效:', st2.paused === true)
    napi.command(['seek', '3', 'absolute'])
    napi.setProperty('pause', false)
    setTimeout(() => {
      const st3 = napi.state()
      console.log(`7) seek 到 3s 后 time=${(st3.time / 1000).toFixed(2)}s`)
      napi.command(['stop'])
      napi.destroy()
      clearInterval(timer)
      console.log('8) 已销毁，测试结束')
      process.exit(0)
    }, 1500)
    return
  }
  if (tries > 20) {
    console.log('❌ 超时：未能读取到播放状态', napi.lastError())
    napi.destroy()
    clearInterval(timer)
    process.exit(5)
  }
}, 500)
