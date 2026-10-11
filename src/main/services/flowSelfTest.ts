import { BrowserWindow } from 'electron'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../log'
import { getMainWindow } from '../window'
import { ruleEpisodes, rulePlay, ruleSearch } from './rules'
import { closeRuleWebview, openRuleWebview } from './ruleWebview'
import { setProbeHook } from './ruleProbe'
import * as engine from './playerEngine'
import {
  beginFlow,
  beginStage,
  endFlow,
  failStage,
  flowDetail,
  pushStep,
  snapshot as flowSnapshot,
  succeedStage
} from './playFlow'
import { probeStreamReachability } from './streamDiag'
import { runPlaySelfCheck } from './playSelfCheck'

/**
 * 播放链路自检脚本（v0.3.9，`SAKANA_FLOW_TEST=1` 时由 src/main/index.ts 调用）。
 *
 * 存在的理由：工单要求「验证要真跑」—— 三阶段的耗时、失败原因分析的两条分支
 * （网站问题 / 速度过慢）都必须用**真实输出**证明，而不是靠读代码推断。
 *
 * 这个脚本做三件事：
 *   ① 用真规则跑一遍完整流程，把三阶段的真实耗时打出来（含引擎出首帧的时刻）；
 *   ② 对**刚刚抓到的真实直链**做可达性取证，看真实的首字节/速率结论；
 *   ③ 故意用两类坏输入验证失败归因：
 *        · 不存在的域名 + 必然 404 的地址 → 必须判「网站问题/资源失效」；
 *        · 本机一个「慢慢吐字节」的服务器 → 必须判「资源获取速度过慢」且**不**判失败。
 *
 * ③ 的慢流为什么用本机服务器：公网上没有「稳定慢到某个阈值」的地址可依赖，
 * 拿一个偶尔慢的真站点做断言只会变成 flaky 测试。本机服务器吐字节的速度是确定的，
 * 正好用来验证阈值与「还有数据在动就不结束」这条规则本身。
 */
export async function runFlowSelfTest(): Promise<void> {
  const out = (s: string): void => console.log(`[flow-test] ${s}`)
  const failures: string[] = []
  const check = (ok: boolean, label: string, detail: string): void => {
    out(`${ok ? '✅' : '❌'} ${label}：${detail}`)
    if (!ok) failures.push(`${label}（${detail}）`)
  }

  /** 打一份过程进度快照：真实耗时、阶段状态、失败原因全在这里 */
  const dumpFlow = (tag: string): void => {
    const f = flowSnapshot()
    out(`—— ${tag} 过程进度快照（流程 #${f.id}，running=${f.running}，判定=${f.reason}）——`)
    for (const s of f.stages) {
      out(
        `   阶段 ${s.label}: ${s.status} 耗时=${(s.elapsedMs / 1000).toFixed(2)}s` +
          `${s.error ? ` 原因=${s.error}` : ''}` +
          `${s.detail ? ` 现状=${s.detail}` : ''}`
      )
    }
    out(`   结论：${f.summary}`)
    out(`   指标：${JSON.stringify(f.metrics)}`)
  }

  // ---------- ③a 坏地址：#1 域名解析不了 ----------
  {
    const r = await probeStreamReachability({ url: 'https://this-host-does-not-exist-sakana.invalid/x.m3u8' })
    check(
      r.reason === 'site',
      '坏地址（不存在域名）',
      `reason=${r.reason} verdict=${r.verdict}`
    )
    check(
      r.metrics.errorKind === 'dns' || r.metrics.errorKind === 'network',
      '坏地址（不存在域名）归因到网络层',
      `errorKind=${r.metrics.errorKind} lastError=${r.metrics.lastError}`
    )
  }

  // ---------- ③b 坏地址 #2：真实域名但必然 404 ----------
  {
    const r = await probeStreamReachability({
      url: 'https://httpbin.org/status/404',
      // 这个站点对非浏览器 UA 可能直接 403，两种都算「网站问题」
      onProgress: () => undefined
    })
    check(
      r.reason === 'site',
      '坏地址（HTTP 404/403）',
      `reason=${r.reason} status=${r.metrics.status} verdict=${r.verdict}`
    )
  }

  // ---------- ③c 慢流：本机慢慢吐字节的服务器 ----------
  {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      // 每 250ms 吐 2KB → 约 8 KB/s，低于 SLOW_STREAM_RATE_BPS(200KB/s)，会被判「过慢」
      const chunk = Buffer.alloc(2048, 0x47)
      let n = 0
      const timer = setInterval(() => {
        n++
        res.write(chunk)
        if (n > 400) {
          clearInterval(timer)
          res.end()
        }
      }, 250)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const started = Date.now()
    const r = await probeStreamReachability({
      url: `http://127.0.0.1:${port}/slow.ts`,
      onProgress: (m, note) => {
        // 采样够多之后打印一次，证明「实时速率」确实是活的
        if (m.bytes > 20 * 1024 && m.bytes < 24 * 1024) out(`   慢流实时速率采样：${note}`)
      }
    })
    const elapsed = Date.now() - started
    check(r.reason === 'slow', '慢流（约 8 KB/s）', `reason=${r.reason} verdict=${r.verdict}`)
    check(
      r.metrics.bytes > 0 && r.metrics.rateBps > 0,
      '慢流仍然拿到了数据（未判失败）',
      `bytes=${r.metrics.bytes} rate=${Math.round(r.metrics.rateBps / 1024)}KB/s 耗时=${(elapsed / 1000).toFixed(1)}s`
    )
    check(
      r.metrics.rateBps < 200 * 1024,
      '慢流速率确实低于阈值',
      `${Math.round(r.metrics.rateBps / 1024)} KB/s < 200 KB/s`
    )
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // ---------- ① 真规则跑一遍三阶段 ----------
  const rules = readEnabledRules()
  const keyword = process.env.SAKANA_FLOW_TEST_KEYWORD || '葬送的芙莉莲'
  const win: BrowserWindow | null = getMainWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (!win) {
    out('⚠ 没有可用窗口，跳过真规则链路（只完成了失败归因验证）')
  } else if (rules.length === 0) {
    out('⚠ store 里没有启用的规则，跳过真规则链路')
  } else {
    const maxRules = Number(process.env.SAKANA_FLOW_MAX_RULES ?? 3)
    let done = false
    for (const rule of rules.slice(0, Number.isFinite(maxRules) ? maxRules : 3)) {
      if (done) break
      out(`—— 规则「${rule.name}」：关键词「${keyword}」——`)
      beginFlow({ mode: 'rule', title: `${rule.name} · ${keyword}` })
      beginStage('locate', '自检：规则搜索 → 取集 → 解析播放页')
      const t0 = Date.now()
      try {
        const s = await ruleSearch(rule.id, keyword)
        if (s.items.length === 0) {
          failStage('locate', `搜索无结果${s.error ? `（${s.error}）` : ''}`, 'site')
          dumpFlow(`${rule.name} 搜索无结果`)
          continue
        }
        pushStep('locate', `搜索命中 ${s.items.length} 条，取第一条`)
        const ep = await ruleEpisodes(rule.id, s.items[0])
        const g = ep.groups[0]
        if (!g || g.episodes.length === 0) {
          failStage('locate', '未解析到剧集', 'site')
          dumpFlow(`${rule.name} 无剧集`)
          continue
        }
        const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, ep.vars)
        succeedStage('locate', `播放页地址已解析（${((Date.now() - t0) / 1000).toFixed(2)}s）`)
        out(`   locate 阶段耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s，播放页 ${play.url.slice(0, 90)}`)

        // --- acquire：真实嗅探 ---
        const tA = Date.now()
        const stream = await new Promise<{ url: string; referer?: string; cookies?: string } | null>(
          (resolve) => {
            const timer = setTimeout(() => resolve(null), 60_000)
            setProbeHook((payload) => {
              if (payload.type === 'found' && typeof payload.url === 'string') {
                clearTimeout(timer)
                resolve({
                  url: payload.url,
                  referer: typeof payload.referer === 'string' ? payload.referer : undefined,
                  cookies: typeof payload.cookies === 'string' ? payload.cookies : undefined
                })
              }
            })
            openRuleWebview(win, play.url, { x: 0, y: 60, width: 960, height: 480 }, rule.baseUrl)
          }
        )
        closeRuleWebview()
        setProbeHook(null)
        if (!stream) {
          failStage('acquire', '60 秒内未捕获到视频流', 'timeout')
          dumpFlow(`${rule.name} 未捕获到流`)
          continue
        }
        out(`   acquire 阶段耗时 ${((Date.now() - tA) / 1000).toFixed(2)}s，直链 ${stream.url.slice(0, 100)}`)

        // --- ② 对真实直链取证 ---
        const reach = await probeStreamReachability({
          url: stream.url,
          referer: stream.referer !== undefined ? stream.referer || undefined : rule.baseUrl,
          cookies: stream.cookies
        })
        out(
          `   真实直链取证：reason=${reach.reason} ttfb=${reach.metrics.ttfbMs}ms ` +
            `bytes=${reach.metrics.bytes} rate=${Math.round(reach.metrics.rateBps / 1024)}KB/s ` +
            `HTTP=${reach.metrics.status} 容器=${reach.container ?? '?'}`
        )
        out(`   取证结论：${reach.verdict}`)
        check(
          reach.reason === 'none' || reach.reason === 'slow',
          `真实直链可达（${rule.name}）`,
          `reason=${reach.reason} ttfb=${reach.metrics.ttfbMs}ms rate=${Math.round(reach.metrics.rateBps / 1024)}KB/s`
        )

        // --- inject：交给内核并等首帧 ---
        const tI = Date.now()
        const att = await engine.engineAttach(win, { x: 0, y: 60, width: 960, height: 480 })
        out(`   内核 attach：${JSON.stringify(att)}`)
        if (!att.ok) {
          failStage('inject', `内核挂载失败：${att.message}`, 'internal')
          dumpFlow(`${rule.name} 内核挂载失败`)
          continue
        }
        engine.enginePlay(
          stream.url,
          stream.referer !== undefined ? stream.referer || undefined : rule.baseUrl,
          stream.cookies
        )
        let firstFrameMs: number | null = null
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const st = engine.engineGetState()
          const f = flowSnapshot()
          const injectStage = f.stages.find((x) => x.key === 'inject')
          if (injectStage?.status === 'ok') {
            firstFrameMs = Date.now() - tI
            break
          }
          if (i % 5 === 4) {
            out(`   inject 等待中 ${i + 1}s：内核状态=${JSON.stringify(st)} 阶段=${injectStage?.status}`)
          }
        }
        if (firstFrameMs !== null) {
          out(`   inject 阶段耗时（到首帧）${(firstFrameMs / 1000).toFixed(2)}s`)
          check(true, `三阶段全部完成（${rule.name}）`, `inject=${(firstFrameMs / 1000).toFixed(2)}s`)
          done = true
        } else {
          failStage('inject', '60 秒内未解出首帧画面', 'format')
          check(false, `首帧未出现（${rule.name}）`, '见过程进度快照')
        }
        engine.engineDetach()
        dumpFlow(`${rule.name} 完整一轮`)
      } catch (err) {
        failStage('locate', String((err as Error)?.message ?? err).slice(0, 160), 'internal')
        out(`❌ 规则「${rule.name}」抛错：${String((err as Error)?.message ?? err)}`)
      }
    }
    endFlow({ ok: failures.length === 0, summary: failures.length === 0 ? '自检通过' : failures.join('；') })
  }

  // ---------- 自检程序本身 ----------
  {
    const r = runPlaySelfCheck({ reset: true })
    out(`—— 自检程序：problems=${r.problems} reset=${r.reset} needsReattach=${r.needsReattach} ——`)
    for (const f of r.findings) out(`   [${f.level}] ${f.title}：${f.detail}`)
    out(`   现场：${JSON.stringify({ probe: r.probe, webview: r.webview, engine: r.engine })}`)
  }

  out(failures.length === 0 ? '==== 全部通过 ====' : `==== 失败 ${failures.length} 项：${failures.join('；')} ====`)
  log.append(failures.length === 0 ? 'info' : 'warn', 'flow-test', `播放链路自检结束：${failures.length === 0 ? '全部通过' : failures.join('；')}`)
  if (process.env.SAKANA_FLOW_TEST_EXIT === '1') {
    setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 800)
  }
}

/** 读启用的规则（与 SAKANA_ONLINE_TEST 同一份 store 数据） */
function readEnabledRules(): import('@shared/types').PlayRule[] {
  // 延迟 require，避免与 store 的初始化顺序耦合
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { store } = require('../store') as typeof import('../store')
  return store
    .get<import('@shared/types').PlayRule[]>('rules', [])
    .filter((r) => r.enabled)
}

/** 供 index.ts 使用：把「自检用到的模块」一次性预热（可选，用于断言 import 关系） */
export function flowSelfTestModules(): string[] {
  return ['rules', 'ruleWebview', 'ruleProbe', 'playerEngine', 'playFlow', 'streamDiag', 'playSelfCheck']
}
