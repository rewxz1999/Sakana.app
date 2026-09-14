/**
 * 镜像站「真实浏览器取数」自检（v0.2.5）
 *
 * 背景：bangumi.vip（与 bangumi.pro 同款）前面挂了一个 JS 机器人校验页
 * （直连只拿到 14KB 的「正在确认你是不是机器人！」），主进程 axios 拿不到真正的 HTML。
 * 这个脚本用离屏真实浏览器窗口打开镜像站，等校验自动通过后，在页面上下文里取页面与接口，
 * 用来确认：
 *   1. 校验能不能自动过（不弹验证码）；
 *   2. 过校验后拿到的是不是服务端渲染的 HTML（含现有解析器期待的 coverList / infobox 等标记）；
 *   3. 顺带看看有没有可直接用的 JSON 接口。
 *
 * 用法：node_modules\.bin\electron scripts\diag-mirror-webview.cjs [镜像地址，默认 https://bangumi.vip]
 */
const { app, BrowserWindow } = require('electron')

const BASE = process.argv[2] || 'https://bangumi.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function inPage(wc, url) {
  const script = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9' } })
      const text = await res.text()
      return JSON.stringify({ status: res.status, text })
    } catch (e) { return JSON.stringify({ status: -1, text: String(e && e.message ? e.message : e) }) }
  })()`
  return JSON.parse(await wc.executeJavaScript(script, true))
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    x: -4000,
    y: 0,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  })
  const wc = win.webContents
  wc.setUserAgent(UA)

  console.log(`[mirror] 打开 ${BASE}/calendar 等待机器人校验自动通过…`)
  let loaded = false
  wc.once('did-finish-load', () => (loaded = true))
  try {
    await wc.loadURL(`${BASE}/calendar`, { userAgent: UA })
  } catch (err) {
    console.log('  首次加载失败:', String(err).slice(0, 120))
  }
  // 校验页通常会自己跳转，最多等 20 秒
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const title = await wc.executeJavaScript('document.title', true).catch(() => '')
    const html = await wc.executeJavaScript('document.documentElement.outerHTML.length', true).catch(() => 0)
    const done = !/机器人|Just a moment|确认你/.test(String(title))
    if (done && loaded) {
      console.log(`  ✅ 第 ${i + 1}s 校验通过：标题=${String(title).slice(0, 60)} 页面 ${html} 字节`)
      break
    }
    if (i === 19) console.log(`  ⚠️ 20 秒后仍在校验页：标题=${String(title).slice(0, 60)}`)
  }

  // 页面内取三个关键页面，检查现有解析器的标记
  for (const [label, url, marks] of [
    ['每日放送', `${BASE}/calendar`, ['coverList', 'week', '<dt class=']],
    ['条目详情', `${BASE}/subject/400602`, ['id="infobox"', 'nameSingle', 'v:average']],
    ['搜索', `${BASE}/search?q=%E8%B4%A5%E7%8A%AC`, ['browserItemList', 'class="item']]
  ]) {
    const r = await inPage(wc, url)
    const hit = marks.filter((m) => String(r.text).includes(m))
    console.log(
      `\n[${label}] ${url}\n  HTTP ${r.status} ${String(r.text).length} 字节  标记命中: ${hit.join(', ') || '（无）'}`
    )
    console.log('  ' + String(r.text).replace(/\s+/g, ' ').slice(0, 220))
  }

  // 探测是否存在 JSON 接口（有的话比解析 HTML 稳）
  for (const p of ['/calendar', '/api/calendar', '/anime/1/calendar', '/json/calendar']) {
    const r = await inPage(wc, `${BASE}${p}`)
    const isJson = String(r.text).trim().startsWith('{') || String(r.text).trim().startsWith('[')
    console.log(`\n[json?] ${p} → ${r.status} ${isJson ? 'JSON' : 'HTML'} ${String(r.text).length}B`)
  }

  app.quit()
})
