/*
 * galmem 测试用「假进程」：在内存里塞入若干音频/脚本文件名（null 分隔的 ASCII），
 * 并把自身 PID 写到临时文件后常驻，供 scripts/test-galmem.js 用只读扫描验证。
 *
 * 只用 Buffer（连续原生内存）承载字符串，保证只读扫描能扫到这些 run。
 *
 * v0.3.9 加了「语音淹没」场景：真机上语音文件名（sound\vo\...）数量是 BGM 的几十倍，
 * 共用一份候选额度时 BGM 一条都进不来 —— 这正是「BGM 识别没生效」的根因，
 * 所以这里刻意塞 600 条语音名，逼出「BGM 必须能挤进来」这个回归点。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const pidFile = path.join(os.tmpdir(), 'galmem-test.pid')
fs.writeFileSync(pidFile, String(process.pid))

const names = [
  'bgm001.ogg',
  'bgm_daily.mp3',
  'battle01.wav',
  'opening_theme.flac',
  'voice_001.opus',
  'bgm/bgm002.ogg', // 带路径的也应当能识别出 basename
  'sound\\bgm\\bgm10_a.ogg', // 真机风格：bgm 目录下的 BGM
  'sound\\bgm\\bgm11_b.ogg',
  'chapter01.ks',
  'scenario_02.txt'
]
// 语音淹没：600 条，数量远超旧实现共享的 400 条候选额度
for (let i = 0; i < 600; i++) {
  names.push(`sound\\vo\\ame\\fem_ame_${String(i).padStart(5, '0')}.ogg`)
}

// 连续 Buffer，目标文件名之间用 \u0000 分隔（成为独立的可打印 run）
const buf = Buffer.alloc(256 * 1024)
let off = 0
for (const n of names) {
  buf.write(n, off, 'ascii')
  off += n.length + 1
}
global.__hold = buf

// 常驻：等父进程扫完把它杀掉
setInterval(() => {}, 1000)
