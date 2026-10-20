/*
 * require 钩子（计时脚本专用）：
 *
 * tsc 不会改写 import 路径，而业务代码里用的是 `@shared/*` 别名、真实包名 `electron`，
 * 以及 playerEngine 里的 `./mpv`（原生内核，脚本里跑不了）。
 * 这里在运行时把这三类映射到「桩 / 编译产物 / 假内核」，
 * 于是脚本跑的是**真实的业务代码**，只有 electron 与 libmpv 被替换掉。
 *
 * 环境变量：
 *   SAKANA_SPEED_OUT  编译产物目录（默认 <仓库>/.tmp-play-speed/out）
 */
const Module = require('module')
const path = require('path')

const OUT = process.env.SAKANA_SPEED_OUT || path.join(__dirname, '..', '..', '.tmp-play-speed', 'out')
const STUB = path.join(OUT, 'scripts', 'play-speed', 'electron-stub.js')
const FAKE_MPV = path.join(__dirname, 'fake-mpv.cjs')

const origResolve = Module._resolveFilename

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') return STUB
  if (typeof request === 'string' && request.startsWith('@shared/')) {
    return path.join(OUT, 'src', 'shared', request.slice('@shared/'.length) + '.js')
  }
  // 只看 playerEngine → ./mpv：其它模块（ruleProbe / ruleWebview）不依赖内核
  if (request === './mpv' && parent && /playerEngine\.js$/.test(parent.filename)) return FAKE_MPV
  return origResolve.call(this, request, parent, ...rest)
}
