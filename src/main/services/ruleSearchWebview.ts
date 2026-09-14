import { BrowserWindow } from 'electron'
import type { PlayRule, RuleEpisodeGroup, RuleSearchEntry } from '@shared/types'
import { log } from '../log'
import { BROWSER_UA } from '../net'
import { resolveUrl } from './rules'

/**
 * Kazumi 式「网页内搜索」：
 * 部分站点（baimao / mgnacg / mutefun 等）的搜索结果由 JS 渲染，
 * 纯 HTTP 抓 HTML 拿不到条目——Kazumi 之所以能用，是因为它在 webview 里搜索。
 * 这里同样用一个屏幕外可见的真实浏览器窗口加载搜索页，等 JS 渲染完成后
 * 直接在页面上下文里执行 XPath（document.evaluate），把条目抓回来。
 */

let win: BrowserWindow | null = null

/** 空闲关闭计时器：搜索结束后一段时间没有新搜索就关掉浏览器窗口，避免进程常驻 */
let idleTimer: NodeJS.Timeout | null = null

/**
 * 正在进行的网页内请求数。
 * 站点偶尔要 20 秒以上才把列表渲染好，若空闲计时器在这期间关窗，
 * 调用方会拿到 `Object has been destroyed` 并白白丢一次解析。
 */
let inFlight = 0

function beginFlight(): void {
  inFlight++
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function endFlight(): void {
  inFlight = Math.max(0, inFlight - 1)
  scheduleIdleClose()
}

function scheduleIdleClose(): void {
  if (inFlight > 0) return // 有请求在跑，等它结束再安排
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    closeSearchWindow()
  }, 20000)
}

/**
 * 加载页面并等待「加载结束或超时」。
 * 不能直接用 loadURL 的 promise：站点 302 跳转/页面内跳转会让它以 ERR_ABORTED 被 reject，
 * 但那其实是正常加载（ezdmw 就踩在这里），会让后面的 XPath 提取白白跳过。
 */
async function loadAndWait(
  w: BrowserWindow,
  url: string,
  userAgent?: string,
  timeoutMs = 20000
): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    const wc = w.webContents
    wc.once('did-finish-load', finish)
    wc.once('did-fail-load', (_e, code, desc) => {
      // -3 = ERR_ABORTED：多为跳转导致，不影响后续提取
      if (code !== -3) log.append('warn', 'rules', `页面加载失败 ${code} ${desc} (${url.slice(0, 80)})`)
      finish()
    })
    // 必须用浏览器 UA：默认的 Electron UA 会被部分站点直接挂起/拦截
    wc.loadURL(url, { userAgent: userAgent && userAgent.trim() ? userAgent : BROWSER_UA }).catch(() => finish())
    setTimeout(finish, timeoutMs)
  })
}

function ensureWindow(): BrowserWindow {  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: true,
    x: -4000,
    y: 0,
    width: 1280,
    height: 800,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.on('closed', () => {
    win = null
  })
  return win
}

export function closeSearchWindow(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.stop()
    } catch {
      /* ignore */
    }
    setImmediate(() => {
      try {
        if (!w.isDestroyed()) w.destroy()
      } catch {
        /* ignore */
      }
    })
  }
}

/** 在页面上下文里按 XPath 抓取搜索结果（相对条目求值，兼容 Kazumi 的 //xxx 写法） */
function extractorScript(listXPath: string, nameXPath: string, resultXPath: string): string {
  const jList = JSON.stringify(listXPath)
  const jName = JSON.stringify(nameXPath)
  const jResult = JSON.stringify(resultXPath)
  return `(() => {
    const ev = (expr, ctx) => {
      try {
        const r = document.evaluate(expr, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
        const out = []
        for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i))
        return out
      } catch (e) { return [] }
    }
    const txt = (n) => (n && (n.textContent || '')).replace(/\\s+/g, ' ').trim()
    const items = ev(${jList})
    const res = []
    for (const it of items) {
      const pick = (expr) => {
        if (!expr || !expr.trim() || expr.trim() === '//') return null
        // 先按「相对条目」求值，失败再按整页求值（与 Kazumi 的语义保持一致）
        const rel = ev(expr.startsWith('//') ? '.' + expr : expr, it)
        if (rel.length) return rel[0]
        const abs = ev(expr, document)
        return abs.length ? abs[0] : null
      }
      const nameNode = pick(${jName}) || pick(${jResult}) || it
      const linkNode = pick(${jResult}) || pick(${jName}) || it
      let href = (linkNode && linkNode.getAttribute && linkNode.getAttribute('href')) || ''
      if (!href && linkNode && linkNode.querySelector) {
        const a = linkNode.querySelector('a')
        if (a) href = a.getAttribute('href') || ''
      }
      if (!href && it.querySelector) {
        const a = it.querySelector('a')
        if (a) href = a.getAttribute('href') || ''
      }
      const name = txt(nameNode)
      if (name || href) res.push({ name, href })
    }
    return JSON.stringify(res)
  })()`
}

/** 在页面里执行提取脚本：窗口若已销毁（空闲关闭/渲染进程结束）则重建一次再试 */
async function runInPage(w: BrowserWindow, script: string): Promise<string> {
  if (w.isDestroyed() || w.webContents.isDestroyed()) throw new Error('窗口已销毁')
  try {
    return (await w.webContents.executeJavaScript(script, true)) as string
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err)
    if (!/destroyed/i.test(msg)) throw err
    // 窗口在半途被销毁 → 换一个新窗口重试一次，避免整次解析失败
    const retry = ensureWindow()
    return (await retry.webContents.executeJavaScript(script, true)) as string
  }
}

/** 用真实浏览器窗口打开搜索页并解析条目（失败返回空数组，交由上层回退） */
export async function searchViaWebview(
  rule: PlayRule,
  keyword: string,
  waitMs = 3500
): Promise<RuleSearchEntry[]> {
  const searchDef = rule.search
  if (searchDef.type !== 'xpath') return []
  const listXPath = String(searchDef.listXPath ?? '').trim()
  if (!listXPath) return []
  const url = String(searchDef.url ?? '').replace('@keyword', encodeURIComponent(keyword))
  if (!url) return []

  const w = ensureWindow()
  beginFlight()
  try {
    const ua = (rule as unknown as { userAgent?: string }).userAgent
    await loadAndWait(w, url, ua)
    await new Promise((r) => setTimeout(r, waitMs))
    const raw = await runInPage(
      w,
      extractorScript(
        listXPath,
        String(searchDef.itemNameXPath ?? ''),
        String(searchDef.itemLinkXPath ?? '')
      )
    )
    const items = JSON.parse(raw) as { name: string; href: string }[]
    const entries: RuleSearchEntry[] = items
      .filter((it) => it && (it.href || it.name))
      .slice(0, 30)
      .map((it) => ({
        name: it.name || it.href,
        link: it.href,
        source: it.href
      }))
    if (entries.length > 0) {
      log.append('info', 'rules', `网页内搜索命中 ${entries.length} 条（${rule.name}）`)
    }
    return entries
  } catch (err) {
    log.append('warn', 'rules', `网页内搜索失败（${rule.name}）: ${String((err as { message?: string })?.message ?? err)}`)
    return []
  } finally {
    endFlight()
  }
}

/**
 * 在页面上下文里按 XPath 抓「线路 + 剧集」。
 * 与搜索同理：不少站点（AGE / aafun(moonci) / ezdmw / gugu3 等）的选集列表由 JS 渲染，
 * 纯 HTTP 抓 HTML 拿不到 → 过去表现为「搜到番剧但没有播放列表」。
 * 这里在真实浏览器里等待渲染完成后求值，并在页面内轮询重试（等 XHR 填充列表）。
 */
function episodeExtractorScript(
  linesXPath: string,
  episodesXPath: string,
  lineNameXPath = ''
): string {
  const jLines = JSON.stringify(linesXPath)
  const jEps = JSON.stringify(episodesXPath)
  return `(async () => {
    const ev = (expr, ctx) => {
      try {
        const r = document.evaluate(expr, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
        const out = []
        for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i))
        return out
      } catch (e) { return [] }
    }
    const txt = (n) => (n && (n.textContent || '')).replace(/\\s+/g, ' ').trim()
    const rel = (expr, ctx) => {
      if (!expr || !expr.trim() || expr.trim() === '//') return []
      // 前导双斜杠 -> 点双斜杠；前导 /self:: 或 /a 等 -> 加点（否则会被当作绝对路径，恒为空）
      const single = expr.startsWith('//')
        ? '.' + expr
        : expr.startsWith('/') && !expr.startsWith('./')
          ? '.' + expr
          : expr
      const r1 = ev(single, ctx)
      if (r1.length) return r1
      return ev(expr, document)
    }
    const href = (n) => {
      if (!n) return ''
      if (n.getAttribute) {
        const h = n.getAttribute('href')
        if (h) return h
      }
      const a = n.querySelector ? n.querySelector('a') : null
      return a ? (a.getAttribute('href') || '') : ''
    }
    const peek = () => {
      const lines = ev(${jLines})
      if (!lines.length) return rel(${jEps}, document).length
      return lines.reduce((n, l) => n + rel(${jEps}, l).length, 0)
    }
    // 等 SPA / XHR 把列表填进来：最多等 8 秒
    for (let i = 0; i < 16; i++) {
      if (peek() > 0) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const linesXPath = ${jLines}
    const out = []
    if (!linesXPath || linesXPath.trim() === '//') {
      out.push({ line: null, eps: rel(${jEps}, document).map((a) => ({ name: txt(a), href: href(a) })) })
    } else {
      const lines = ev(linesXPath)
      lines.forEach((l, i) => {
        // {n} 占位：第 n 条线路的剧集容器（线路名标签与剧集盒子为兄弟节点时用）
        const usesIndex = ${jEps}.indexOf('{n}') >= 0
        const expr = usesIndex ? ${jEps}.replace(/\\{n\\}/g, String(i + 1)) : ${jEps}
        const nodes = usesIndex ? rel(expr, document) : rel(expr, l)
        const lineNameExpr = ${JSON.stringify(String(lineNameXPath ?? ''))}
        let lineName = ''
        if (lineNameExpr) {
          if (lineNameExpr.charAt(0) === '@') {
            lineName = (l.getAttribute && l.getAttribute(lineNameExpr.slice(1))) || ''
          } else {
            const picked = rel(lineNameExpr, l)
            lineName = picked.length ? txt(picked[0]) : ''
          }
        }
        out.push({
          line: (lineName || txt(l)).slice(0, 24) || '线路 ' + (i + 1),
          eps: nodes.map((a) => ({ name: txt(a), href: href(a) }))
        })
      })
    }
    return JSON.stringify(out)
  })()`
}

/** 用真实浏览器打开剧集页并解析播放列表（失败返回空数组，交由上层决定） */
export async function episodesViaWebview(
  rule: PlayRule,
  entry: RuleSearchEntry,
  waitMs = 1200
): Promise<RuleEpisodeGroup[]> {
  const def = rule.episodes
  if (def.type !== 'xpath') return []
  const episodesXPath = String(def.episodesXPath ?? '').trim()
  if (!episodesXPath) return []
  const primary = resolveUrl(rule.baseUrl, entry.link || entry.source)
  if (!primary) return []

  // 有些站点的搜索结果是绝对链接但指向另一个域名（例如移动站规则 baseUrl 是 m.ezdmw.org，
  // 条目却给出 www.ezdmw.org，加载会被中止）——失败时用 baseUrl 的域名再试一次。
  const candidates = [primary]
  try {
    const base = new URL(rule.baseUrl)
    const p = new URL(primary)
    if (p.host !== base.host) {
      candidates.push(`${base.protocol}//${base.host}${p.pathname}${p.search}`)
    }
  } catch {
    /* ignore */
  }

  const ua = (rule as unknown as { userAgent?: string }).userAgent
  beginFlight()
  try {
    for (const url of candidates) {
      const w = ensureWindow()
      try {
        await loadAndWait(w, url, ua)
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
        const raw = await runInPage(
          w,
          episodeExtractorScript(
            String(def.linesXPath ?? ''),
            episodesXPath,
            String(def.lineNameXPath ?? '')
          )
        )
        const parsed = JSON.parse(raw) as { line: string | null; eps: { name: string; href: string }[] }[]
        const groups: RuleEpisodeGroup[] = (Array.isArray(parsed) ? parsed : [])
          .map((g) => ({
            lineName: g.line ?? null,
            episodes: (g.eps ?? [])
              .filter((e) => e.name || e.href)
              .map((e) => ({ name: e.name || e.href, link: e.href }))
          }))
          .filter((g) => g.episodes.length > 0)
        if (groups.length > 0) {
          const total = groups.reduce((n, g) => n + g.episodes.length, 0)
          log.append('info', 'rules', `网页内选集命中 ${groups.length} 条线路 / ${total} 集（${rule.name}）`)
          return groups
        }
        log.append('info', 'rules', `网页内选集为空（${rule.name}）: ${url.slice(0, 100)}`)
      } catch (err) {
        log.append(
          'warn',
          'rules',
          `网页内选集失败（${rule.name}）: ${url.slice(0, 90)} → ${String((err as { message?: string })?.message ?? err).slice(0, 100)}`
        )
      }
    }
    return []
  } finally {
    endFlight()
  }
}
