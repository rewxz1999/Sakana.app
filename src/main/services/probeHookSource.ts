/**
 * 提前注入到播放页的「取流 Hook」源码（V2.0 提速 ①）。
 *
 * 为什么单独一个模块、只导出字符串：
 *   ① 它要在**页面主世界**执行（CDP `Page.addScriptToEvaluateOnNewDocument`），
 *      不是普通的主进程代码，混在 ruleProbe 里既不好读也不好测；
 *   ② 它是纯字符串，不含任何 electron / node 依赖 —— 因此可以在 Node 里用 `vm`
 *      直接跑一遍（伪造 XMLHttpRequest / fetch / console）来验证"真的两条都劫持了"，
 *      见 `.verify/rule-play-v2/hook-check.mjs`。
 *
 * 为什么用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 而不是 executeJavaScript：
 * `executeJavaScript` 在页面脚本开始执行之后才落地，而播放器可能在这之前就发出第一个请求
 * （SPA 直接 hydrate 的站点尤其明显）；`did-finish-load` 更晚。
 * `Page.addScriptToEvaluateOnNewDocument` 是浏览器保证「每个新文档、任何页面脚本之前」执行，
 * 与 contextIsolation 也不冲突（它在主世界执行，正是要包的那一层）。
 *
 * ## 与 webRequest / CDP 的关系：双保险，不是替代
 *
 * Hook 只上报**看起来像媒体**的地址（扩展名 / playlist 路径 / 签名图片扩展名），
 * 真正的判定仍在主进程（`isStreamCandidate` / 内容判定）。
 * webRequest 与 CDP 两条老路一条都不删：Hook 漏掉的（Service Worker 代理、WebSocket 推流）
 * 由它们兜底；反过来 Hook 能比它们更早拿到地址 —— 后者要等响应体落地。
 *
 * ## 上报为什么走 console.log
 *
 * 嗅探窗口没有 preload、也不该有（站点页面 + node 权限是明确的红线）。
 * `console-message` 是主进程**不用给页面任何权限**就能拿到的通道。
 * 为了不刷爆控制台，Hook 侧先做低成本过滤；主进程再做权威过滤。
 */

/** 上报前缀：主进程按它从页面的 console 输出里挑消息 */
export const PROBE_HOOK_MARK = 'SAKANA_HOOK:'

export const PROBE_HOOK_SOURCE = `(() => {
  if (window.__sakanaHookInstalled) return
  window.__sakanaHookInstalled = true
  var MARK = '${PROBE_HOOK_MARK}'
  var RE_EXT = /\\.(m3u8|mp4|flv|mkv|webm|ts|m4s|mov|mpd)(\\?|$)/i
  var RE_PATH = /\\/(listres|hls|playlist|m3u8|source|media|video)\\//i
  var RE_IMG = /\\.(webp|jpg|jpeg|png|gif)$/i
  var RE_SIG = /(sign|key|token|expire|auth)=/i
  function abs(u) {
    try { return new URL(String(u), location.href).href } catch (e) { return '' }
  }
  function report(u) {
    if (!u || typeof u !== 'string') return
    if (!/^https?:/i.test(u)) return
    var p = ''
    try { p = new URL(u).pathname } catch (e) { return }
    // 只上报"像媒体"的地址：站点每个 XHR 都 console.log 会把控制台与主进程都刷爆
    if (RE_EXT.test(p) || RE_PATH.test(p) || (RE_IMG.test(p) && RE_SIG.test(u))) {
      try { console.log(MARK + u) } catch (e) {}
    }
  }
  // ① XMLHttpRequest：open 记地址、send 时上报（send 才是真正发请求的时刻）
  try {
    var xhrOpen = XMLHttpRequest.prototype.open
    var xhrSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__sakanaUrl = abs(url) } catch (e) {}
      return xhrOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function () {
      try { if (this.__sakanaUrl) report(this.__sakanaUrl) } catch (e) {}
      return xhrSend.apply(this, arguments)
    }
  } catch (e) {}
  // ② fetch：Request 对象与字符串两种入参都要能取到地址
  try {
    var origFetch = window.fetch
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          var u = typeof input === 'string' ? input : (input && input.url) || ''
          report(abs(u))
        } catch (e) {}
        return origFetch.apply(this, arguments)
      }
    }
  } catch (e) {}
})()`
