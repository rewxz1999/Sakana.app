import { app, BrowserWindow, desktopCapturer, screen, session } from 'electron'
import { join } from 'node:path'
import { log } from './log'
import { registerIpc } from './ipc'
import { store } from './store'
import { bangumi } from './services/bangumi'
import { mikan } from './services/mikan'
import { downloadManager } from './services/downloader/manager'
import { registerMediaProtocols } from './services/media'
import { ensureDefaultRules } from './services/rules'
import { createTray, destroyTray, markQuitting } from './tray'
import { createMainWindow } from './window'
import { ruleEpisodes, ruleSearch } from './services/rules'
import { convertSubtitleToVtt, listVideos } from './services/media'
import { initLiveServer, stopAllLive } from './services/transcode'
import { maybeShowIntro } from './services/onboarding'
import { applySessionProxy } from './net'
import axios from 'axios'

/** 自检用：Node 侧抓取文本（与 Chromium 栈对比） */
async function axiosGet(url: string): Promise<{ status: number; body: string }> {
  const res = await axios.get<string>(url, {
    timeout: 20000,
    responseType: 'text',
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    }
  })
  return { status: res.status, body: String(res.data ?? '') }
}
import { DEFAULT_RULES } from '@shared/types'

/*
 * 关于 libmpv 画面显示（踩坑记录，勿删）：
 * libmpv 的视频输出是原生子窗口，Chromium 的页面内容同样以原生窗口呈现。
 * 实测结论（可复现，用「屏幕抓取」而非窗口抓取判定，窗口抓取不含原生子窗口）：
 *  1) 视频窗口必须显式提升 z 序（SetWindowPos(HWND_TOP)）：不做提升时画面完全不可见，
 *     表现为「有声音、一片黑屏」——这正是 0.1.6 的问题，已 1:1 复现（屏幕抓取亮度 0.0，
 *     同时 mpv 自身截图有正常画面 124.6）；提升后同一位置亮度 109.3（画面可见）。
 *     与 electron-vlc-player 的 RaiseAboveWebContent 完全同理。
 *  2) webContents 的 'paint' 事件在非离屏渲染下不触发，不能依赖它做提升时机；
 *     因此用「首帧后立即提升 + 400ms 定时自愈」。
 *  3) 把视频窗口挂进页面渲染窗口（Chrome_RenderWidgetHostHWND）内部也能显示，
 *     但实测与同级子窗口+提升等价，故仅作为诊断备选（SAKANA_MPV_PARENT_WIDGET=1）。
 * 实现见 native/mpv/src/addon.cc（RaiseChild / EnsureAttached）
 * 与 src/main/services/mpv.ts（首帧后 settle + 定时提升）。
 * 无需关闭 Chromium 的 DirectComposition（已实测保留该项同样正常）。
 */

/**
 * 自检用：直接抓取屏幕区域（用户实际所见，包含原生视频窗口），
 * 统计亮度与「接近纯黑」占比 —— 用于判断画面是否真的铺满。
 */
async function measureScreenRegion(
  win: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
  label: string
): Promise<void> {
  try {
    const disp = screen.getDisplayMatching(win.getBounds())
    const sf = disp.scaleFactor || 1
    const wb = win.getBounds()
    const shots = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(disp.size.width * sf),
        height: Math.round(disp.size.height * sf)
      }
    })
    const img = (shots.find((s) => String(s.display_id) === String(disp.id)) ?? shots[0]).thumbnail
    const size = img.getSize()
    const bmp = img.getBitmap() as unknown as Buffer
    const rx = Math.round((wb.x - disp.bounds.x + bounds.x) * sf)
    const ry = Math.round((wb.y - disp.bounds.y + bounds.y) * sf)
    const rw = Math.round(bounds.width * sf)
    const rh = Math.round(bounds.height * sf)
    let sum = 0
    let black = 0
    let n = 0
    for (let y = ry + 4; y < Math.min(ry + rh - 4, size.height); y += 4) {
      for (let x = rx + 4; x < Math.min(rx + rw - 4, size.width); x += 4) {
        const i = (y * size.width + x) * 4
        const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
        sum += l
        if (l < 16) black++
        n++
      }
    }
    console.log(
      `[screen] 【${label}】区域(${rx},${ry},${rw},${rh}) 平均亮度 ${(sum / Math.max(1, n)).toFixed(1)}，近黑占比 ${((black / Math.max(1, n)) * 100).toFixed(1)}%`
    )
  } catch (err) {
    console.log(`[screen] 【${label}】失败: ${String(err).slice(0, 110)}`)
  }
}

/**
 * 自检用：测量窗口内某矩形区域的亮度（判断原生视频窗口是否真的画出来了）。
 * 按窗口采集（Windows Graphics Capture），裁剪到目标矩形后统计。
 */
async function measureWindowRegion(
  win: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
  label: string
): Promise<void> {
  try {
    const disp = screen.getDisplayMatching(win.getBounds())
    const sf = disp.scaleFactor || 1
    const wb = win.getBounds()
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 4096, height: 4096 }
    })
    const src = sources.find((s) => s.name === win.getTitle()) ?? sources[0]
    const img = src.thumbnail
    const size = img.getSize()
    const bmp = img.getBitmap() as unknown as Buffer
    const kx = size.width / Math.max(1, Math.round(wb.width * sf))
    const ky = size.height / Math.max(1, Math.round(wb.height * sf))
    const sx = bounds.x * sf * kx
    const sy = bounds.y * sf * ky
    const sw = bounds.width * sf * kx
    const sh = bounds.height * sf * ky
    let sum = 0
    let n = 0
    let minL = 255
    let maxL = 0
    for (let y = Math.round(sy) + 4; y < Math.min(Math.round(sy + sh) - 4, size.height); y += 3) {
      for (let x = Math.round(sx) + 4; x < Math.min(Math.round(sx + sw) - 4, size.width); x += 3) {
        const i = (y * size.width + x) * 4
        const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
        sum += l
        if (l < minL) minL = l
        if (l > maxL) maxL = l
        n++
      }
    }
    const mean = sum / Math.max(1, n)
    console.log(
      `[pixel] 【${label}】窗口源「${src.name}」区域亮度 ${mean.toFixed(1)} 最暗 ${minL.toFixed(0)} 最亮 ${maxL.toFixed(0)} → ${maxL - minL > 30 ? '有画面' : '近似纯色（可能未显示）'}`
    )
  } catch (err) {
    console.log(`[pixel] 【${label}】测量失败: ${String(err).slice(0, 120)}`)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(() => {
    store.init()
    log.init()
    log.append('info', 'app', `Sakana v${app.getVersion()} 启动`)
    bangumi.init()
    ensureDefaultRules()
    registerMediaProtocols()
    registerIpc()
    createMainWindow()
    createTray()
    downloadManager.start()
    // 中转流用本机 HTTP 提供（libVLC / libmpv / 渲染层 <video> 三方都能播）
    void initLiveServer()
    // 网页视图 / 嗅探窗口 / 图片协议同样走应用代理（否则部分站点只有 HTTP 能访问）
    applySessionProxy(session.defaultSession)

    // 首次启动提示数据保存位置（只显示一次，自检/冒烟模式下自动跳过）
    setTimeout(() => maybeShowIntro(), 3000)

    // 方案 4.2：应用启动时自动检测订阅更新（延迟 4s，避免抢占启动网络），需用户确认后下载
    setTimeout(() => {
      mikan
        .checkAllSubscriptions()
        .then((updates) => {
          if (updates.length > 0) {
            for (const w of BrowserWindow.getAllWindows()) {
              w.webContents.send('ev:sub-updates', updates)
            }
          }
        })
        .catch((err) => log.append('warn', 'subs', `启动更新检测失败: ${String(err)}`))
    }, 4000)

    // 番剧表：应用打开时联网更新一次（此后本会话不再自动访问数据源，除非手动刷新）
    setTimeout(() => {
      void bangumi.calendar(false).then((r) => {
        if (r.days.length > 0) log.append('info', 'bangumi', `番剧表已更新（${r.days.length} 天${r.fromCache ? '，来自缓存' : ''}）`)
      })
    }, 6000)

    // v0.2.4：启动时自动检查 git 仓库是否有新版本（延迟 8 秒；结果写日志，设置页可见并可跳转下载）
    void import('./services/updater').then((m) => m.scheduleAutoCheck())

    app.on('second-instance', () => {
      const wins = BrowserWindow.getAllWindows()
      const main = wins.find((w) => !w.webContents.getURL().includes('#/tray'))
      if (main) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })

    // 在线播放端到端自检（SAKANA_ONLINE_TEST=关键词）：规则搜索 → 剧集 → 播放页 → 流嗅探
    if (process.env.SAKANA_ONLINE_TEST) {
      setTimeout(() => {
        void (async () => {
          // 支持逗号分隔的多个关键词（一次运行覆盖多部番剧，减少重复启动）
          const kws = process.env
            .SAKANA_ONLINE_TEST!.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          const { ruleSearch, ruleEpisodes, rulePlay } = await import('./services/rules')
          const { startRuleProbe, stopRuleProbe, setProbeHook } = await import('./services/ruleProbe')
          const filterEnv = process.env.SAKANA_ONLINE_TEST_IDS
          const wanted = filterEnv
            ? filterEnv
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean)
            : []
          const rules = store
            .get<import('@shared/types').PlayRule[]>('rules', [])
            .filter((r) => r.enabled)
            .filter((r) =>
              wanted.length === 0
                ? true
                : wanted.some(
                    (w) => r.id.toLowerCase().includes(w) || r.name.toLowerCase().includes(w)
                  )
            )
          const win = BrowserWindow.getAllWindows()[0]
          let ok = 0
          let fail = 0
          const ruleLimit = Number(process.env.SAKANA_ONLINE_MAX_RULES ?? 5)
          for (const kw of kws) {
          console.log(`[online-test] 关键词「${kw}」，启用规则 ${rules.length} 条`)
          for (const rule of rules.slice(0, Number.isFinite(ruleLimit) ? ruleLimit : 5)) {
            if (!win) break
            try {
              const s = await ruleSearch(rule.id, kw)
              if (!s.items.length) {
                console.log(`[online-test] ${rule.name}: ⚠ 搜索无结果${s.error ? `（${s.error}）` : ''}`)
                fail++
              } else {
                const ep = await ruleEpisodes(rule.id, s.items[0])
                const g = ep.groups[0]
                if (!g || g.episodes.length === 0) {
                  console.log(`[online-test] ${rule.name}: ⚠ 未解析到剧集${ep.error ? `（${ep.error}）` : ''}`)
                  fail++
                } else {
                  const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, ep.vars)
                  console.log(`[online-test] ${rule.name}: 播放页 ${play.url.slice(0, 100)}`)
                  // Kazumi 式：可见网页视图嗅探（视口取窗口内一块区域）
                  const { openRuleWebview, closeRuleWebview } = await import('./services/ruleWebview')
                  // SAKANA_ONLINE_ATTACH_FIRST=1：先挂载内核再开探针视图（复现真实 UI 顺序：
                  // 播放页进入即 attach，探针网页视图随后盖在视频区之上）
                  const useMpv = process.env.SAKANA_ONLINE_ENGINE === 'mpv'
                  // 指定 mpv 时必须同时强制内核，否则 activeEngine() 会按用户设置回落到 libVLC
                  if (useMpv && !process.env.SAKANA_FORCE_ENGINE) process.env.SAKANA_FORCE_ENGINE = 'mpv'
                  // 指定 vlc 或 mpv 时都走播放内核调度器（这样才会经过广告过滤等调度层逻辑）
                  const eng = process.env.SAKANA_ONLINE_ENGINE
                    ? await import('./services/playerEngine')
                    : null
                  const attachFirst = process.env.SAKANA_ONLINE_ATTACH_FIRST === '1'
                  let preAttach: { ok: boolean; message: string } | null = null
                  if (attachFirst) {
                    const { attachVlc } = await import('./services/vlc')
                    preAttach = eng
                      ? await eng.engineAttach(win, { x: 0, y: 60, width: 960, height: 480 })
                      : await attachVlc(win)
                    console.log(
                      `[online-test] ${rule.name}: 先挂载内核(UI 顺序) ${JSON.stringify(preAttach)}`
                    )
                  }
                  const stream = await new Promise<{ url: string; referer?: string; cookies?: string } | null>(
                    (resolve) => {
                      const timer = setTimeout(() => resolve(null), 40000)
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
                      openRuleWebview(
                        win,
                        play.url,
                        { x: 0, y: 60, width: 960, height: 480 },
                        rule.baseUrl
                      )
                    }
                  )
                  closeRuleWebview()
                  setProbeHook(null)
                  if (stream) {
                    ok++
                    console.log(`[online-test] ${rule.name}: ✅ 捕获视频流 ${stream.url.slice(0, 110)}`)
                    console.log(
                      `[online-test] ${rule.name}: 会话信息 referer=${stream.referer ? '有' : '无'} cookies=${stream.cookies ? `${stream.cookies.length} 字符` : '无'}`
                    )
                    // 端到端验证：先直连（带 Cookie），失败则改走 FFmpeg 中转
                    try {
                      const { attachVlc, vlcPlay, getVlcState, destroyVlc } = await import('./services/vlc')
                      const { startLiveUrl, stopLive } = await import('./services/transcode')
                      console.log(
                        `[online-test] ${rule.name}: 验证内核=${eng ? eng.activeEngine() : 'vlc(直连调用)'}`
                      )
                      const att =
                        preAttach ??
                        (eng
                          ? await eng.engineAttach(win, { x: 0, y: 60, width: 960, height: 480 })
                          : await attachVlc(win))
                      console.log(`[online-test] ${rule.name}: 内核嵌入 ${JSON.stringify(att)}`)
                      const engPlay = (u: string, ref?: string, ck?: string): void =>
                        eng ? eng.enginePlay(u, ref, ck) : vlcPlay(u, ref, ck)
                      const engState = (): { playing: boolean; time: number; length: number } | null =>
                        eng ? eng.engineGetState() : getVlcState()
                      const engDetach = (): void => {
                        if (eng) eng.engineDetach()
                        else destroyVlc()
                      }
                      if (!att.ok) {
                        console.log(`[online-test] ${rule.name}: ⚠ 内核嵌入失败：${att.message}`)
                      } else {
                        const waitPlay = async (label: string, rounds: number, stepMs: number) => {
                          for (let i = 0; i < rounds; i++) {
                            await new Promise((r) => setTimeout(r, stepMs))
                            const st = engState()
                            console.log(
                              `[online-test] ${rule.name}: ${label} 状态(${((i + 1) * stepMs) / 1000}s) ${JSON.stringify(st)}`
                            )
                            if (st?.playing && st.length > 0) return st
                          }
                          return null
                        }
                        // ① 直连（Referer 语义：空串=不带 Referer）
                        const refDirect = stream.referer !== undefined ? stream.referer || undefined : rule.baseUrl
                        console.log(
                          `[online-test] ${rule.name}: 直连 Referer=${refDirect ?? '(不带)'}`
                        )
                        engPlay(stream.url, refDirect, stream.cookies)
                        const skipDirect = process.env.SAKANA_ONLINE_FORCE_RELAY === '1'
                        if (skipDirect) console.log(`[online-test] ${rule.name}: 跳过直连（强制验证中转）`)
                        const direct = skipDirect ? null : await waitPlay('直连', 4, 5000)
                        if (direct) {
                          console.log(
                            `[online-test] ${rule.name}: 🎬 直连播放成功（时长 ${Math.round(direct.length / 1000)}s）`
                          )
                        } else {
                          console.log(`[online-test] ${rule.name}: 直连未播放 → 改用 FFmpeg 中转`)
                          try {
                            const relay = startLiveUrl(stream.url, {
                              referer: refDirect,
                              cookies: stream.cookies
                            })
                            console.log(`[online-test] ${rule.name}: 中转流 ${relay.url}`)
                            engPlay(relay.url)
                            const viaRelay = await waitPlay('中转', 6, 5000)
                            if (viaRelay) {
                              console.log(
                                `[online-test] ${rule.name}: 🎬 FFmpeg 中转播放成功（时长 ${Math.round(viaRelay.length / 1000)}s）`
                              )
                            } else {
                              console.log(`[online-test] ${rule.name}: ⚠ FFmpeg 中转也未能播放`)
                            }
                            stopLive(relay.sessionId)
                          } catch (err) {
                            console.log(
                              `[online-test] ${rule.name}: ⚠ 中转启动失败 ${String(err).slice(0, 140)}`
                            )
                          }
                        }
                        engDetach()
                      }
                    } catch (err) {
                      console.log(`[online-test] ${rule.name}: ⚠ 内核验证异常 ${String(err).slice(0, 120)}`)
                    }
                  } else {
                    fail++
                    console.log(`[online-test] ${rule.name}: ❌ 22s 内未捕获视频流`)
                  }
                }
              }
            } catch (err) {
              fail++
              console.log(`[online-test] ${rule.name}: ❌ 异常 ${String(err).slice(0, 140)}`)
            }
            const maxFail = Number(process.env.SAKANA_ONLINE_MAX_FAIL ?? 3)
            if (fail >= (Number.isFinite(maxFail) ? maxFail : 3)) {
              console.log(`[online-test] 失败已达 ${maxFail} 次，停止测试`)
              break
            }
          }
          } // for (const kw of kws)
          console.log(`[online-test] 完成：成功 ${ok} 条 / 失败 ${fail} 条`)
          markQuitting()
          app.quit()
        })()
      }, 3000)
    }

    // libmpv 端到端自检（SAKANA_MPV_TEST=视频文件）：嵌入子窗口 → 播放 → 读状态
    if (process.env.SAKANA_MPV_TEST) {
      setTimeout(() => {
        void (async () => {
          const file = process.env.SAKANA_MPV_TEST!
          const { mpvAttach, mpvPlay, mpvGetState, mpvDestroy, mpvAvailable, mpvEventCounts, mpvResetEventCounts } =
            await import('./services/mpv')
          const win = BrowserWindow.getAllWindows()[0]
          console.log(`[mpv-test] 运行时可用=${mpvAvailable()}`)
          if (!win) {
            console.log('[mpv-test] 无主窗口')
            markQuitting()
            app.quit()
            return
          }
          const att = mpvAttach(win, { x: 0, y: 60, width: 960, height: 480 })
          console.log(`[mpv-test] 嵌入: ${JSON.stringify(att)}`)
          if (att.ok) {
            // 两轮：验证「退出播放器 → 再次进入」时能重新创建输出子窗口
            for (let cycle = 1; cycle <= 2; cycle++) {
              // 关键回归点：每轮（相当于每次换集）都必须重新发出 playing 事件，
              // 否则渲染层 playingRef 一直为 false，8 秒后会误切 FFmpeg 中转。
              mpvResetEventCounts()
              mpvPlay(file)
              // 自检：按需调用画面比例（验证它是否会干扰状态读取/播放）
              if (process.env.SAKANA_MPV_ASPECT) {
                const { mpvSetAspect } = await import('./services/mpv')
                mpvSetAspect(process.env.SAKANA_MPV_ASPECT as 'fit' | 'cover' | 'stretch')
              }
              let okPlay = false
              for (let i = 0; i < 8; i++) {
                await new Promise((r) => setTimeout(r, 1000))
                const st = mpvGetState()
                console.log(`[mpv-test] 第${cycle}轮 状态(${i + 1}s) ${JSON.stringify(st)}`)
                if (st?.ready && st.length > 0 && st.time > 0 && !st.paused) {
                  okPlay = true
                  console.log(
                    `[mpv-test] 🎬 第${cycle}轮 libmpv 播放成功（时长 ${(st.length / 1000).toFixed(1)}s，进度 ${(st.time / 1000).toFixed(1)}s）`
                  )
                  break
                }
              }
              const counts = mpvEventCounts()
              console.log(
                `[mpv-test] 第${cycle}轮 事件计数 ${JSON.stringify(counts)} → playing ${counts.playing > 0 ? '✓ 已发出' : '✗ 未发出（渲染层会误判未开播）'}`
              )
              if (!okPlay) console.log(`[mpv-test] ⚠ 第${cycle}轮 libmpv 未能开始播放`)
              mpvDestroy()
              await new Promise((r) => setTimeout(r, 800))
              if (cycle === 1) {
                const re = mpvAttach(win, { x: 0, y: 60, width: 960, height: 480 })
                console.log(`[mpv-test] 重新嵌入: ${JSON.stringify(re)}`)
                if (!re.ok) break
              }
            }
          }
          console.log('[mpv-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 中转流自检（SAKANA_LIVE_TEST=视频文件）：
    // FFmpeg 中转 → 本机 HTTP 地址 → 当前内核播放（验证回退方案对 libVLC/libmpv 都可用）
    if (process.env.SAKANA_LIVE_TEST) {
      setTimeout(() => {
        void (async () => {
          const file = process.env.SAKANA_LIVE_TEST!
          const { startLive, stopLive, initLiveServer } = await import('./services/transcode')
          const { engineAttach, enginePlay, engineGetState, engineDetach, activeEngine } =
            await import('./services/playerEngine')
          const win = BrowserWindow.getAllWindows()[0]
          await initLiveServer()
          const relay = startLive(file, { mode: 'vcopy' })
          console.log(`[live-test] 内核=${activeEngine()} 中转地址=${relay.url}`)
          if (!win) {
            console.log('[live-test] 无主窗口')
            markQuitting()
            app.quit()
            return
          }
          const att = await engineAttach(win, { x: 0, y: 60, width: 960, height: 480 })
          console.log(`[live-test] 嵌入 ${JSON.stringify(att)}`)
          if (att.ok) {
            enginePlay(relay.url)
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 1000))
              const st = engineGetState()
              console.log(`[live-test] 状态(${i + 1}s) ${JSON.stringify(st)}`)
              if (st?.playing && st.time > 0) {
                console.log(`[live-test] 🎬 中转流播放成功（进度 ${(st.time / 1000).toFixed(1)}s）`)
                break
              }
            }
          }
          stopLive(relay.sessionId)
          engineDetach()
          console.log('[live-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 画面像素自检（SAKANA_MPV_PIXEL_TEST=视频文件）：
    // 播放后截取屏幕、裁剪视频区域并统计亮度/非黑像素占比，
    // 用于判定「有声音但黑屏」是没画出来还是被遮挡（看不了图，只能量化）。
    if (process.env.SAKANA_MPV_PIXEL_TEST) {
      setTimeout(() => {
        void (async () => {
          const file = process.env.SAKANA_MPV_PIXEL_TEST!
          const { engineAttach, engineGetState, enginePlay, engineDetach, activeEngine } =
            await import('./services/playerEngine')
          const { desktopCapturer, screen } = await import('electron')
          const win = BrowserWindow.getAllWindows()[0]
          const bounds = { x: 0, y: 60, width: 960, height: 480 }
          if (!win) {
            console.log('[pixel-test] 无主窗口')
            markQuitting()
            app.quit()
            return
          }
          win.show()
          win.focus()
          const att = await engineAttach(win, bounds)
          console.log(`[pixel-test] 内核=${activeEngine()} 嵌入=${JSON.stringify(att)}`)
          enginePlay(file)
          await new Promise((r) => setTimeout(r, 4500))
          const st = engineGetState()
          console.log(`[pixel-test] 播放状态 ${JSON.stringify(st)}`)
          // 关键分离：让 mpv 自己把当前帧写成 PNG。
          // 截图有画面 = 解码/渲染管线正常，黑屏纯粹是窗口可见性问题；
          // 截图全黑 = vo 根本没出帧。
          try {
            const { mkdirSync, existsSync } = await import('node:fs')
            const { join: pjoin } = await import('node:path')
            const { mpvSnapshot } = await import('./services/mpv')
            const dir = pjoin(process.cwd(), '.shots')
            mkdirSync(dir, { recursive: true })
            const shot = pjoin(dir, 'mpv-frame.png')
            mpvSnapshot(shot)
            await new Promise((r) => setTimeout(r, 1200))
            if (existsSync(shot)) {
              const { nativeImage } = await import('electron')
              const img = nativeImage.createFromPath(shot)
              const sz = img.getSize()
              const bmp = img.getBitmap() as unknown as Buffer
              let sum = 0
              let n = 0
              let minL = 255
              let maxL = 0
              for (let i = 0; i + 3 < bmp.length; i += 4 * 37) {
                const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
                sum += l
                if (l < minL) minL = l
                if (l > maxL) maxL = l
                n++
              }
              console.log(
                `[pixel-test] mpv 自身截图 ${sz.width}x${sz.height}：平均亮度 ${(sum / Math.max(1, n)).toFixed(1)}，最暗 ${minL.toFixed(0)} 最亮 ${maxL.toFixed(0)} → ${maxL - minL > 30 ? '有画面（渲染管线正常）' : '接近纯色（渲染异常）'}`
              )
            } else {
              console.log('[pixel-test] mpv 截图未生成')
            }
          } catch (err) {
            console.log(`[pixel-test] mpv 截图失败: ${String(err).slice(0, 140)}`)
          }
          // 分阶段像素测量：定位「何时挂载才生效」
          const measure = async (label: string): Promise<void> => {
            try {
              const disp = screen.getDisplayMatching(win.getBounds())
              const sf = disp.scaleFactor || 1
              const wb = win.getBounds()
              const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 4096, height: 4096 }
              })
              const src = sources.find((s) => s.name === win.getTitle()) ?? sources[0]
              const img = src.thumbnail
              const size = img.getSize()
              const bmp = img.getBitmap() as unknown as Buffer
              const kx = size.width / Math.max(1, Math.round(wb.width * sf))
              const ky = size.height / Math.max(1, Math.round(wb.height * sf))
              const sx = bounds.x * sf * kx
              const sy = bounds.y * sf * ky
              const sw = bounds.width * sf * kx
              const sh = bounds.height * sf * ky
              let sum = 0
              let n = 0
              let minL = 255
              let maxL = 0
              for (let y = Math.round(sy) + 4; y < Math.min(Math.round(sy + sh) - 4, size.height); y += 3) {
                for (let x = Math.round(sx) + 4; x < Math.min(Math.round(sx + sw) - 4, size.width); x += 3) {
                  const i = (y * size.width + x) * 4
                  const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
                  sum += l
                  if (l < minL) minL = l
                  if (l > maxL) maxL = l
                  n++
                }
              }
              const mean = sum / Math.max(1, n)
              console.log(
                `[pixel-test] 【${label}】亮度 ${mean.toFixed(1)} 最暗 ${minL.toFixed(0)} 最亮 ${maxL.toFixed(0)} → ${mean < 230 ? '有画面' : '只有页面底色'}`
              )
            } catch (err) {
              console.log(`[pixel-test] 【${label}】测量失败: ${String(err).slice(0, 100)}`)
            }
          }
          await measure('初始（挂载即嵌入渲染窗口）')
          const { mpvReparentToWidget, mpvSetSurfaceVisible } = await import('./services/mpv')
          if (process.env.SAKANA_MPV_PARENT_WIDGET) {
            console.log(`[pixel-test] 播放中再次重挂: ${mpvReparentToWidget()}`)
            await new Promise((r) => setTimeout(r, 1500))
            await measure('播放中重挂后')
          }
          if (process.env.SAKANA_MPV_TOGGLE_VISIBLE) {
            mpvSetSurfaceVisible(false)
            await new Promise((r) => setTimeout(r, 400))
            mpvSetSurfaceVisible(true)
            await new Promise((r) => setTimeout(r, 1200))
            await measure('显隐切换后')
          }
          await measure('结束前')
          // 输出窗口树：确认渲染子窗口是否存在、位置/可见性/样式如何（两个内核都可对比）
          try {
            const { mpvDumpWindows, mpvWindowsOf } = await import('./services/mpv')
            const tree = mpvDumpWindows()
            if (tree) {
              console.log(`[pixel-test] 自建子窗口下: ${JSON.stringify(tree.childChildren)}`)
            }
            const all = mpvWindowsOf(win.getNativeWindowHandle())
            console.log(
              `[pixel-test] 主窗口子窗口树: ${(all ?? ['(不可用)']).join('\n    ')}`
            )
          } catch (err) {
            console.log(`[pixel-test] 窗口树失败: ${String(err).slice(0, 120)}`)
          }
          await measureWindowRegion(win, bounds, '窗口采集')
          engineDetach()
          console.log('[pixel-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 网络栈自检（SAKANA_NET_TEST=URL）：对比 Electron(Chromium) 网络栈的连通性
    if (process.env.SAKANA_NET_TEST) {
      setTimeout(() => {
        void (async () => {
          const { net } = await import('electron')
          const url = process.env.SAKANA_NET_TEST!
          const t0 = Date.now()
          try {
            const res = await net.fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
              }
            })
            const text = await res.text()
            console.log(
              `[net-test] Chromium 栈: HTTP ${res.status} ${text.length}B ${Date.now() - t0}ms 含关键词=${/败犬女主太多了/.test(text)}`
            )
          } catch (err) {
            console.log(`[net-test] Chromium 栈失败(${Date.now() - t0}ms): ${String(err).slice(0, 200)}`)
          }
          const t1 = Date.now()
          try {
            const r = await axiosGet(url)
            console.log(
              `[net-test] Node 栈: HTTP ${r.status} ${r.body.length}B ${Date.now() - t1}ms 含关键词=${/败犬女主太多了/.test(r.body)}`
            )
          } catch (err) {
            console.log(`[net-test] Node 栈失败: ${String(err).slice(0, 200)}`)
          }
          console.log('[net-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 播放器 UI 自检（SAKANA_PLAYERUI_TEST=视频文件夹）：打开播放页并测量控制栏布局
    if (process.env.SAKANA_PLAYERUI_TEST) {
      const folder = process.env.SAKANA_PLAYERUI_TEST
      setTimeout(() => {
        void (async () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) {
            console.log('[playerui] 无主窗口')
            markQuitting()
            app.quit()
            return
          }
          const devUrl = process.env['ELECTRON_RENDERER_URL']
          const hash = `/player?folder=${encodeURIComponent(folder)}&title=${encodeURIComponent('布局自检')}`
          if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#${hash}`)
          else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
          await new Promise((r) => setTimeout(r, 14000))
          const { activeEngine } = await import('./services/playerEngine')
          console.log(
            `[playerui] 当前内核=${activeEngine()}（设置=${process.env.SAKANA_PLAYERUI_ENGINE ?? '未指定'}）`
          )
          // 真实播放页：测量视频区像素，确认内核画面真的显示出来了
          // （必须先确保窗口可见并置顶：WGC/Chromium 截图对隐藏或被遮挡窗口都会返回全黑）
          if (win.isMinimized()) win.restore()
          win.show()
          win.setAlwaysOnTop(true)
          win.moveTop()
          win.focus()
          await new Promise((r) => setTimeout(r, 900))
          console.log(
            `[playerui] 窗口状态 可见=${win.isVisible()} 最小化=${win.isMinimized()} 边界=${JSON.stringify(win.getBounds())}`
          )
          // 全屏自检：对比「窗口 / DOM 视频区 / mpv 子窗口」三者矩形，定位画面不铺满的原因
          if (process.env.SAKANA_PLAYERUI_FULLSCREEN) {
            const hostRect = async (): Promise<unknown> =>
              win.webContents.executeJavaScript(
                `(function(){var el=document.getElementById('vlc-host');var r=el?el.getBoundingClientRect():null;return r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),winW:window.innerWidth,winH:window.innerHeight,dpr:window.devicePixelRatio}:null})()`
              )
            const videoRect = async (): Promise<string> => {
              const { mpvWindowsOf } = await import('./services/mpv')
              const all = mpvWindowsOf(win.getNativeWindowHandle()) ?? []
              return all
                .map((s) => {
                  const cls = /"class":"([^"]*)"/.exec(s)?.[1] ?? '?'
                  const rect = /"rect":\[([^\]]*)\]/.exec(s)?.[1] ?? ''
                  const vis = /"visible":(\d)/.exec(s)?.[1] === '1'
                  return `${cls}[${rect}]${vis ? '' : '(隐藏)'}`
                })
                .join(' | ')
            }
            const disp = screen.getDisplayMatching(win.getBounds())
            console.log(
              `[playerui] 全屏前: 窗口=${JSON.stringify(win.getBounds())} 显示器=${disp.size.width}x${disp.size.height}@${disp.scaleFactor} host=${JSON.stringify(await hostRect())} 视频窗口=${await videoRect()}`
            )
            win.setFullScreen(true)
            await new Promise((r) => setTimeout(r, 1200))
            console.log(
              `[playerui] 全屏+控制栏可见: 全屏=${win.isFullScreen()} 窗口=${JSON.stringify(win.getBounds())} host=${JSON.stringify(await hostRect())} 视频窗口=${await videoRect()}`
            )
            await measureWindowRegion(win, { x: 0, y: 0, width: win.getBounds().width, height: win.getBounds().height }, '全屏·控制栏可见·整屏')
            // 等控制栏 5 秒自动隐藏后：画面应铺满整屏
            await new Promise((r) => setTimeout(r, 6500))
            console.log(
              `[playerui] 全屏+控制栏隐藏: host=${JSON.stringify(await hostRect())} 视频窗口=${await videoRect()}`
            )
            await measureWindowRegion(win, { x: 0, y: 0, width: win.getBounds().width, height: win.getBounds().height }, '全屏·控制栏隐藏·整屏')
            // 悬浮窗自检：窗口是否存在、控制栏 DOM 是否渲染
            try {
              const { overlayWindow } = await import('./services/playerOverlay')
              const ow = overlayWindow()
              if (!ow) {
                console.log('[playerui] 悬浮窗: 未创建')
              } else {
                const probe = (await ow.webContents.executeJavaScript(
                  `JSON.stringify({buttons:document.querySelectorAll('button').length,text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,80),w:window.innerWidth,h:window.innerHeight})`
                )) as string
                console.log(
                  `[playerui] 悬浮窗: 已创建 ${JSON.stringify(ow.getBounds())} 内容=${probe} 可见=${ow.isVisible()}`
                )
              }
            } catch (err) {
              console.log(`[playerui] 悬浮窗检查失败: ${String(err).slice(0, 120)}`)
            }
            await measureScreenRegion(win, { x: 0, y: 0, width: win.getBounds().width, height: win.getBounds().height }, '全屏·控制栏隐藏·屏幕实拍')
            // 模拟鼠标移动唤出控制栏，画面应让出上下两条
            win.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 })
            await new Promise((r) => setTimeout(r, 900))
            console.log(
              `[playerui] 全屏+唤出控制栏: host=${JSON.stringify(await hostRect())} 视频窗口=${await videoRect()}`
            )
            win.setFullScreen(false)
            await new Promise((r) => setTimeout(r, 1200))
            console.log(
              `[playerui] 退出全屏后: 窗口=${JSON.stringify(win.getBounds())} host=${JSON.stringify(await hostRect())} 视频窗口=${await videoRect()}`
            )
          }
          // ① 屏幕抓取（用户实际所见，包含原生子窗口）
          try {
            const disp = screen.getDisplayMatching(win.getBounds())
            const sf = disp.scaleFactor || 1
            const wb = win.getBounds()
            const shots = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: {
                width: Math.round(disp.size.width * sf),
                height: Math.round(disp.size.height * sf)
              }
            })
            const img = (shots.find((s) => String(s.display_id) === String(disp.id)) ?? shots[0]).thumbnail
            const size = img.getSize()
            const bmp = img.getBitmap() as unknown as Buffer
            const rx = Math.round((wb.x - disp.bounds.x) * sf)
            const ry = Math.round((wb.y - disp.bounds.y + 62) * sf)
            const rw = Math.round(982 * sf)
            const rh = Math.round(480 * sf)
            let sum = 0
            let n = 0
            let minL = 255
            let maxL = 0
            for (let y = ry + 4; y < Math.min(ry + rh - 4, size.height); y += 3) {
              for (let x = rx + 4; x < Math.min(rx + rw - 4, size.width); x += 3) {
                const i = (y * size.width + x) * 4
                const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
                sum += l
                if (l < minL) minL = l
                if (l > maxL) maxL = l
                n++
              }
            }
            console.log(
              `[playerui] 屏幕抓取 视频区(${rx},${ry},${rw},${rh})：平均亮度 ${(sum / Math.max(1, n)).toFixed(1)} 最暗 ${minL.toFixed(0)} 最亮 ${maxL.toFixed(0)}`
            )
          } catch (err) {
            console.log(`[playerui] 屏幕抓取失败: ${String(err).slice(0, 100)}`)
          }
          // ② 命中测试：视频区中心最上层是不是我们的窗口
          try {
            const { mpvHitTest, mpvSnapshot } = await import('./services/mpv')
            const disp = screen.getDisplayMatching(win.getBounds())
            const sf = disp.scaleFactor || 1
            const wb = win.getBounds()
            const cx = Math.round((wb.x - disp.bounds.x + 491) * sf)
            const cy = Math.round((wb.y - disp.bounds.y + 62 + 240) * sf)
            const h = mpvHitTest(cx, cy)
            console.log(
              `[playerui] 命中(${cx},${cy}): ${h?.hitClass} ourChild=${h?.isOurChild} 链=${JSON.stringify(h?.ourChain)}`
            )
            // ③ mpv 自身截图：确认它到底有没有画面
            const { mkdirSync, existsSync } = await import('node:fs')
            const { join: pjoin } = await import('node:path')
            const dir = pjoin(process.cwd(), '.shots')
            mkdirSync(dir, { recursive: true })
            const shot = pjoin(dir, 'playerui-frame.png')
            mpvSnapshot(shot)
            await new Promise((r) => setTimeout(r, 1200))
            if (existsSync(shot)) {
              const { nativeImage } = await import('electron')
              const im = nativeImage.createFromPath(shot)
              const s2 = im.getSize()
              const b2 = im.getBitmap() as unknown as Buffer
              let sm = 0
              let c = 0
              let lo = 255
              let hi = 0
              for (let i = 0; i + 3 < b2.length; i += 4 * 37) {
                const l = (b2[i] + b2[i + 1] + b2[i + 2]) / 3
                sm += l
                if (l < lo) lo = l
                if (l > hi) hi = l
                c++
              }
              console.log(
                `[playerui] mpv 自身截图 ${s2.width}x${s2.height}：平均亮度 ${(sm / Math.max(1, c)).toFixed(1)} 最暗 ${lo.toFixed(0)} 最亮 ${hi.toFixed(0)}`
              )
            } else {
              console.log('[playerui] mpv 截图未生成')
            }
          } catch (err) {
            console.log(`[playerui] 命中/截图失败: ${String(err).slice(0, 100)}`)
          }
          await measureWindowRegion(win, { x: 0, y: 62, width: 982, height: 480 }, '播放页视频区')
          // 对照组：Chromium 自身的页面截图（不含原生子窗口），用于判断
          // 「WGC 采集失效（全黑）」还是「页面本身全黑」
          try {
            const snap = await win.webContents.capturePage()
            const sz = snap.getSize()
            const bmp = snap.getBitmap() as unknown as Buffer
            let sum = 0
            let n = 0
            let minL = 255
            let maxL = 0
            for (let i = 0; i + 3 < bmp.length; i += 4 * 53) {
              const l = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
              sum += l
              if (l < minL) minL = l
              if (l > maxL) maxL = l
              n++
            }
            console.log(
              `[playerui] Chromium 页面截图 ${sz.width}x${sz.height}：平均亮度 ${(sum / Math.max(1, n)).toFixed(1)} 最暗 ${minL.toFixed(0)} 最亮 ${maxL.toFixed(0)}`
            )
          } catch (err) {
            console.log(`[playerui] 页面截图失败: ${String(err).slice(0, 100)}`)
          }
          await measureWindowRegion(win, { x: 0, y: 0, width: 982, height: 642 }, '整窗')
          try {
            const { mpvDumpWindows, mpvWindowsOf } = await import('./services/mpv')
            console.log(
              `[playerui] 视频窗口树: ${JSON.stringify(mpvDumpWindows()?.childChildren ?? null)}`
            )
            console.log(
              `[playerui] 主窗口子窗口: ${(mpvWindowsOf(win.getNativeWindowHandle()) ?? []).join(' | ')}`
            )
          } catch (err) {
            console.log(`[playerui] 窗口树失败: ${String(err).slice(0, 100)}`)
          }
          const info = (await win.webContents.executeJavaScript(
            `(function(){
              const r = (el) => { if(!el) return null; const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)} }
              const bars = Array.from(document.querySelectorAll('div')).filter(d => {
                const s = getComputedStyle(d)
                return s.zIndex === '30' && d.className && String(d.className).includes('gradient')
              })
              const top = bars[0], bottom = bars[bars.length-1]
              const host = document.getElementById('vlc-host')
              const seek = document.querySelector('.group.relative.flex.h-6')
              const btns = Array.from(document.querySelectorAll('button'))
              return JSON.stringify({
                win: { w: window.innerWidth, h: window.innerHeight },
                barCount: bars.length,
                top: r(top), bottom: r(bottom), host: r(host),
                topButtons: top ? top.querySelectorAll('button').length : -1,
                bottomButtons: bottom ? bottom.querySelectorAll('button').length : -1,
                seek: seek ? r(seek) : null,
                seekPercentOfWindow: seek ? Math.round((seek.getBoundingClientRect().width / window.innerWidth) * 100) : -1,
                totalButtons: btns.length
              })
            })()`
          )) as string
          console.log(`[playerui] ${info}`)
          const { engineGetState } = await import('./services/playerEngine')
          console.log(`[playerui] 播放状态 ${JSON.stringify(engineGetState())}`)
          try {
            const { mpvDebugProps } = await import('./services/mpv')
            console.log(`[playerui] mpv 属性 ${JSON.stringify(mpvDebugProps())}`)
          } catch (err) {
            console.log(`[playerui] mpv 属性读取失败: ${String(err).slice(0, 80)}`)
          }
          console.log('[playerui] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 打包环境自检（SAKANA_ENV_TEST=1）：检查内置 libVLC / FFmpeg / aria2 是否可见
    if (process.env.SAKANA_ENV_TEST) {
      setTimeout(() => {
        void (async () => {
          const { resolveVlcDir } = await import('./services/vlc')
          const { ffmpegExe } = await import('./services/transcode')
          const { aria2 } = await import('./services/downloader/aria2')
          const { mpvRuntimeAvailable, mpvAvailable } = await import('./services/mpv')
          const { existsSync } = await import('node:fs')
          const vlcDir = resolveVlcDir()
          const ffmpeg = ffmpegExe()
          const aria = await aria2.findBinary()
          console.log(`[env-test] isPackaged=${app.isPackaged}`)
          console.log(`[env-test] appPath=${app.getAppPath()}`)
          console.log(`[env-test] resourcesPath=${process.resourcesPath ?? '(none)'}`)
          console.log(`[env-test] userData=${app.getPath('userData')}`)
          console.log(`[env-test] libVLC=${vlcDir ?? '未找到'} ${vlcDir ? (existsSync(vlcDir) ? '✓' : '✗') : ''}`)
          console.log(`[env-test] FFmpeg=${ffmpeg ?? '未找到'} ${ffmpeg ? '✓' : ''}`)
          console.log(`[env-test] aria2c=${aria ?? '未找到'} ${aria ? '✓' : ''}`)
          console.log(
            `[env-test] libmpv.dll=${mpvRuntimeAvailable() ? '✓' : '✗'} 插件=${mpvAvailable() ? '✓' : '✗'}`
          )
          console.log('[env-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 小窗口自检（SAKANA_SMALLWIN_TEST=1）：逐个打开副窗口并输出渲染层错误/内容长度
    if (process.env.SAKANA_SMALLWIN_TEST) {
      setTimeout(() => {
        void (async () => {
          const { openSmallWindow } = await import('./window')
          const hashes = [
            '/stattool',
            // v0.2.4：新增搜索页（收藏页的搜索框已迁到这里），纳入小窗口自检以免路由级错误漏网
            '/search',
            '/rules',
            '/shortcuts',
            '/player-settings',
            '/cache-settings',
            '/datasource',
            '/logs',
            '/about',
            '/save-dirs',
            '/nav-bg',
            '/downloader-config',
            '/galgame/tools',
            '/downloads-win?title=%E6%B5%8B%E8%AF%95'
          ]
          for (const hash of hashes) {
            const w = openSmallWindow(hash, { width: 720, height: 520, title: `测试 ${hash}` })
            const logs: string[] = []
            const onConsole = (...args: unknown[]): void => {
              const d =
                typeof args[1] === 'object' && args[1] !== null
                  ? (args[1] as { level?: string; message?: string })
                  : { level: String(args[1]), message: String(args[2]) }
              logs.push(`${d.level}: ${String(d.message).slice(0, 260)}`)
            }
            w.webContents.on('console-message', onConsole)
            await new Promise<void>((resolve) => {
              w.webContents.once('did-finish-load', () => resolve())
              w.webContents.once('did-fail-load', (_e, code, desc) => {
                logs.push(`did-fail-load ${code} ${desc}`)
                resolve()
              })
              setTimeout(resolve, 5000)
            })
            await new Promise((r) => setTimeout(r, 2500))
            let info = ''
            try {
              info = String(
                await w.webContents.executeJavaScript(
                  `(function(){
                    var m=document.querySelector('main');var b=document.body;
                    var r=m?m.getBoundingClientRect():{width:0,height:0};
                    var cs=b?getComputedStyle(b):null;
                    var root=document.getElementById('root');
                    var rc=root?getComputedStyle(root):null;
                    var firstText=document.querySelector('main h1, main h2, main div');
                    var txt=function(sel,cap){return Array.prototype.slice.call(document.querySelectorAll(sel),0,cap).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)}).filter(Boolean)};
                    return JSON.stringify({
                      url:location.hash,
                      bodyLen:(b?b.innerText.length:0),
                      mainW:Math.round(r.width),mainH:Math.round(r.height),
                      bodyBg:cs?cs.backgroundColor:'',bodyColor:cs?cs.color:'',
                      rootOpacity:rc?rc.opacity:'',rootDisplay:rc?rc.display:'',
                      theme:document.documentElement.getAttribute('data-theme'),
                      firstTextColor:firstText?getComputedStyle(firstText).color:'',
                      overflowX:b?Math.max(0,b.scrollWidth-b.clientWidth):-1,
                      overflowY:b?Math.max(0,b.scrollHeight-b.clientHeight):-1,
                      badges:txt('[class*="rounded-full"]',6),
                      heads:txt('[class*="font-semibold"]',8)
                    })})()`
                )
              )
            } catch (err) {
              info = `executeJavaScript 失败: ${String(err).slice(0, 120)}`
            }
            console.log(`[smallwin] ${hash} → ${info}`)
            // SAKANA_SMALLWIN_SHOT=1：把每个副窗口截图到 .shots/ 便于人工核对
            if (process.env.SAKANA_SMALLWIN_SHOT) {
              try {
                const { mkdirSync, writeFileSync } = await import('node:fs')
                const { join: pjoin } = await import('node:path')
                const dir = pjoin(process.cwd(), '.shots')
                mkdirSync(dir, { recursive: true })
                const png = await w.webContents.capturePage()
                const name = hash.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'
                writeFileSync(pjoin(dir, `${name}.png`), png.toPNG())
                console.log(`[smallwin] 截图 .shots/${name}.png`)
              } catch (err) {
                console.log(`[smallwin] 截图失败: ${String(err).slice(0, 120)}`)
              }
            }
            const errs = logs.filter((l) => /error|Error|did-fail/.test(l))
            if (errs.length) console.log(`[smallwin] ${hash} 错误: ${errs.slice(0, 4).join(' || ')}`)
            w.destroy()
          }
          console.log('[smallwin] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 规则仓库全量同步（SAKANA_RULES_SYNC=1）：导入仓库里全部规则（含新版本与 moonci 等）
    if (process.env.SAKANA_RULES_SYNC) {
      setTimeout(() => {
        void (async () => {
          try {
            const { rulesRepoImport, rulesRepoIndex } = await import('./services/rules')
            const idx = await rulesRepoIndex()
            const names = idx.map((r) => r.name)
            console.log(`[rules-sync] 仓库规则 ${names.length} 条：${names.join(', ')}`)
            const r = await rulesRepoImport(names)
            console.log(`[rules-sync] 导入成功 ${r.imported} 条，失败 ${r.failed.length} 条 ${r.failed.join('; ')}`)
          } catch (err) {
            console.log('[rules-sync] 失败:', String(err))
          }
          console.log('[rules-sync] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 下载端到端自检（SAKANA_DL_TEST=关键词）：
    // 蜜柑搜索 → 建任务 → 下载器取种/磁力 → aria2 实际下载 → 进度、错误码、落盘文件
    if (process.env.SAKANA_DL_TEST) {
      setTimeout(() => {
        void (async () => {
          const kw = process.env.SAKANA_DL_TEST!
          const { mikan } = await import('./services/mikan')
          const { downloadManager } = await import('./services/downloader/manager')
          const { aria2 } = await import('./services/downloader/aria2')
          const { getSettings } = await import('./net')
          const { readdirSync } = await import('node:fs')
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
          try {
            const s = await mikan.search(kw)
            console.log(`[dl-test] 搜索「${kw}」→ ${s.items.length} 条${s.error ? `（${s.error}）` : ''}`)
            // SAKANA_DL_PICK=<子串>：按标题子串挑选资源（用于验证"能做种/能下完"的场景）
            const pickTag = process.env.SAKANA_DL_PICK
            const pick = pickTag
              ? s.items.find((i) => i.title.includes(pickTag) && (i.torrentUrl || i.magnet))
              : (s.items.find((i) => i.episode === 1 && (i.torrentUrl || i.magnet)) ??
                s.items.find((i) => i.torrentUrl || i.magnet))
            if (!pick) {
              console.log('[dl-test] 没有可用资源（无种子/磁力）')
              markQuitting()
              app.quit()
              return
            }
            console.log(
              `[dl-test] 选中: ${pick.title} | 第${pick.episode}集 | 字幕组=${pick.group ?? '-'}`
            )
            console.log(`[dl-test] 种子=${pick.torrentUrl ?? '(无)'}`)
            console.log(`[dl-test] 磁力=${pick.magnet ? pick.magnet.slice(0, 80) : '(无)'}`)
            console.log(`[dl-test] 下载器自检: ${JSON.stringify(await downloadManager.test())}`)
            const task = await downloadManager.add({
              subjectId: 0,
              animeTitle: kw,
              episode: pick.episode,
              group: pick.group,
              name: pick.title,
              cover: '',
              magnet: pick.magnet ?? undefined,
              torrentUrl: pick.torrentUrl ?? undefined,
              pubDate: pick.pubDate
            })
            console.log(`[dl-test] 任务创建: ${task.id}`)
            for (let i = 0; i < 15; i++) {
              await sleep(3000)
              const t = downloadManager.list().find((x) => x.id === task.id)
              console.log(
                `[dl-test] ${(i + 1) * 3}s 状态=${t?.status} 进度=${t?.progress ?? 0}% 速度=${t?.speed ?? '-'} 错误=${t?.error ?? '-'} gid=${t?.downloaderId ?? '-'}`
              )
              if (t?.downloaderId) {
                console.log(
                  `[dl-test]   aria2: ${JSON.stringify(await aria2.rawStatus(t.downloaderId))}`
                )
              }
              if (t?.status === 'done' || t?.status === 'error') break
            }
          } catch (err) {
            console.log(`[dl-test] 异常: ${String((err as Error)?.stack ?? err).slice(0, 300)}`)
          }
          const dir = getSettings().downloadDir || join(app.getPath('userData'), 'downloads')
          console.log(`[dl-test] 下载目录 ${dir}:`)
          try {
            for (const f of readdirSync(dir)) console.log(`   ${f}`)
          } catch (err) {
            console.log(`   读取失败: ${String(err)}`)
          }
          console.log('[dl-test] done')
          markQuitting()
          app.quit()
        })()
      }, 3000)
    }

    // 订阅实时同步自检（SAKANA_SUBS_TEST=1）：
    // 打开订阅页 → 通过 IPC 新建一条订阅 → 不刷新页面看卡片是否立刻出现（修复前必须重启）
    if (process.env.SAKANA_SUBS_TEST) {
      setTimeout(() => {
        void (async () => {
          const win = BrowserWindow.getAllWindows()[0]
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
          if (!win) {
            console.log('[subs-test] 无主窗口')
            markQuitting()
            app.quit()
            return
          }
          const devUrl = process.env['ELECTRON_RENDERER_URL']
          if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#/subs`)
          else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/subs' })
          await sleep(3000)
          const probe = async (): Promise<string> =>
            (await win.webContents.executeJavaScript(
              `(async () => {
                 const r = await window.sakana.subs.list()
                 const cards = Array.from(document.querySelectorAll('main div')).filter(d => /测试番剧_自检/.test(d.innerText || '')).length
                 return JSON.stringify({ storeCount: r.ok ? r.data.length : -1, domHasCard: cards > 0, text: (document.querySelector('main')?.innerText || '').replace(/\\s+/g,' ').slice(0, 120) })
               })()`
            )) as string
          console.log(`[subs-test] 添加前: ${await probe()}`)
          const created = (await win.webContents.executeJavaScript(
            `window.sakana.downloads.subscribeOnly({ subjectId: 999999, name: '测试番剧_自检', nameCn: '测试番剧_自检', cover: '', mikanItem: { title: '测试资源', group: '自检字幕组', episode: 1, pubDate: new Date().toUTCString(), torrentUrl: '', magnet: null, size: '', resolution: null, guid: 'selftest', link: '' } }).then(r => JSON.stringify({ ok: r.ok, id: r.ok ? r.data.subscription.id : r.error }))`
          )) as string
          console.log(`[subs-test] 创建订阅: ${created}`)
          await sleep(1500)
          console.log(`[subs-test] 添加后（未刷新页面）: ${await probe()}`)
          // 清理自检数据
          const id = (JSON.parse(created) as { id?: string }).id
          if (id) {
            await win.webContents.executeJavaScript(`window.sakana.subs.remove(${JSON.stringify(id)})`)
            await sleep(600)
          }
          console.log(`[subs-test] 清理后: ${await probe()}`)
          console.log('[subs-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 网页视图侦察自检（SAKANA_WEBVIEW_TEST=URL，可选 SAKANA_WEBVIEW_XPATH=表达式）：
    // 打开页面并多次采样「浏览器里真正渲染出来的 DOM」，用于判断站点是否 JS 渲染 / 有拦截页
    if (process.env.SAKANA_WEBVIEW_TEST) {
      setTimeout(() => {
        void (async () => {
          const url = process.env.SAKANA_WEBVIEW_TEST!
          const xpath = process.env.SAKANA_WEBVIEW_XPATH ?? ''
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
          const w = new BrowserWindow({
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
          const probe = async (): Promise<string> => {
            try {
              return (await w.webContents.executeJavaScript(
                `JSON.stringify({
                   title: document.title,
                   htmlLen: document.documentElement.innerHTML.length,
                   divs: document.getElementsByTagName('div').length,
                   links: document.getElementsByTagName('a').length,
                   boxes: document.querySelectorAll('[class*="public-list-box"], [class*="searchlist_item"], [class*="lpic"], [class*="vod-detail"]').length,
                   xpathHits: (() => { try { return document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength } catch (e) { return 'err:' + e.message } })(),
                   text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 150)
                 })`
              )) as string
            } catch (err) {
              return `探测失败: ${String(err).slice(0, 100)}`
            }
          }
          w.webContents.once('did-finish-load', () => console.log('[wv-test] did-finish-load'))
          w.webContents.on('did-fail-load', (_e, code, desc) =>
            console.log(`[wv-test] did-fail-load ${code} ${desc}`)
          )
          console.log(`[wv-test] 打开 ${url}`)
          void w.loadURL(url).catch((err) => console.log(`[wv-test] loadURL 异常: ${String(err).slice(0, 90)}`))
          for (const wait of [2500, 3000, 4000]) {
            await sleep(wait)
            console.log(`[wv-test] +${wait}ms ${await probe()}`)
          }
          console.log('[wv-test] done')
          try {
            w.destroy()
          } catch {
            /* ignore */
          }
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    // 规则仓库导入自检（SAKANA_REPO_TEST=1）：索引 + 导入 2 条规则
    if (process.env.SAKANA_REPO_TEST) {
      setTimeout(() => {
        void (async () => {
          try {
            const { rulesRepoImport, rulesRepoIndex } = await import('./services/rules')
            const idx = await rulesRepoIndex()
            console.log(`[repo-test] 仓库规则数: ${idx.length}，样本: ${idx.slice(0, 5).map((r) => r.name).join(', ')}`)
            // SAKANA_REPO_ALL=1：导入全部规则（用应用自带的 Kazumi → 本地规则转换器，顺带刷新旧定义）
            const all = process.env.SAKANA_REPO_ALL === '1'
            const names = all ? idx.map((r) => r.name) : idx.slice(0, 3).map((r) => r.name)
            const r = await rulesRepoImport(names)
            console.log(`[repo-test] 导入 ${r.imported} 条，失败 ${r.failed.length} 条${all ? '（全量）' : ''}`)
            if (r.failed.length) console.log(`[repo-test] 失败明细: ${r.failed.slice(0, 8).join(', ')}`)
          } catch (err) {
            console.log('[repo-test] 失败:', String(err))
          }
          console.log('[repo-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2000)
    }

    // 统计工具导出图片自检（SAKANA_STAT_TEST=1）：注入临时列表 → 渲染截图 → 校验 PNG
    if (process.env.SAKANA_STAT_TEST) {
      setTimeout(() => {
        void (async () => {
          try {
            const { statExportTest } = await import('./services/statExport')
            const out = await statExportTest()
            const { statSync } = await import('node:fs')
            const size = statSync(out).size
            console.log(`[stat-test] OK 导出图片 ${out}（${size} bytes）`)
          } catch (err) {
            console.log('[stat-test] 失败:', String(err))
          }
          console.log('[stat-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2000)
    }

    // 播放页流嗅探自检（SAKANA_PROBE_TEST=1）：加载内嵌视频的网页并捕获流地址
    if (process.env.SAKANA_PROBE_TEST) {
      setTimeout(() => {
        void (async () => {
          const { startRuleProbe } = await import('./services/ruleProbe')
          const win = BrowserWindow.getAllWindows()[0]
          console.log('[probe-test] 隔离测试：无分区窗口能否加载页面…')
          const bare = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: false } })
          try {
            await bare.loadURL('https://www.w3schools.com/html/html5_video.asp')
            console.log('[probe-test] 无分区窗口加载成功')
          } catch (err) {
            console.log('[probe-test] 无分区窗口失败:', String(err))
          }
          bare.destroy()
          console.log('[probe-test] 正式探流…（事件由 ruleProbe 日志输出）')
          startRuleProbe(
            win,
            'data:text/html,' + encodeURIComponent('<video src="https://www.w3schools.com/html/mov_bbb.mp4" autoplay muted></video>'),
            undefined
          )
          setTimeout(() => {
            console.log('[probe-test] done')
            markQuitting()
            app.quit()
          }, 18000)
        })()
      }, 2000)
    }

    // libVLC 播放自检（SAKANA_VLC_TEST=视频文件）：嵌入 + 播放 + 状态日志后退出
    if (process.env.SAKANA_VLC_TEST) {
      setTimeout(() => {
        void (async () => {
          const { attachVlc, destroyVlc, getVlcState, vlcPlay } = await import('./services/vlc')
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) {
            console.log('[vlc-test] 无窗口')
            markQuitting()
            app.quit()
            return
          }
          await new Promise<void>((resolve) => {
            if (!win.webContents.isLoading()) return resolve()
            win.webContents.once('did-finish-load', () => resolve())
            setTimeout(resolve, 8000)
          })
          // 在页面中创建 #vlc-host 容器（自检用）
          await win.webContents.executeJavaScript(
            `(() => { const d = document.createElement('div'); d.id = 'vlc-host'; d.style.cssText = 'position:fixed;inset:44px 0 0 0;'; document.body.appendChild(d); return true })()`
          )
          const file = process.env.SAKANA_VLC_TEST!
          console.log(`[vlc-test] 播放: ${file}`)
          try {
            // 直接实例化以获取完整错误堆栈
            const { VlcPlayer, getLibVlcVersion } = await import('electron-vlc-player')
            const { resolveVlcDir } = await import('./services/vlc')
            const dir = resolveVlcDir()
            console.log(`[vlc-test] vlcDir: ${dir}`)
            try {
              console.log('[vlc-test] libVLC 版本:', JSON.stringify(getLibVlcVersion()))
            } catch (e) {
              console.log('[vlc-test] 版本查询失败:', (e as Error).message)
            }
            const probe = new VlcPlayer({
              window: win,
              container: '#vlc-host',
              vlcDir: dir!,
              locale: 'zh-CN',
              controls: true,
              pageFullscreenButton: false
            })
            try {
              await probe.embed()
              console.log('[vlc-test] 直接 embed 成功')
              probe.destroy()
            } catch (e) {
              console.log('[vlc-test] 直接 embed 失败:', (e as Error).stack ?? String(e))
            }
          } catch (e) {
            console.log('[vlc-test] 实例化失败:', (e as Error).stack ?? String(e))
          }
          const r = await attachVlc(win)
          console.log(`[vlc-test] 嵌入结果: ${JSON.stringify(r)}`)
          if (r.ok) {
            vlcPlay(file)
            let lastLog = ''
            for (let i = 0; i < 16; i++) {
              await new Promise((res) => setTimeout(res, 1000))
              const s = getVlcState()
              const line = s ? `playing=${s.playing} time=${Math.round(s.time / 1000)}s length=${Math.round(s.length / 1000)}s` : 'not-ready'
              if (line !== lastLog) {
                console.log(`[vlc-test] ${line}`)
                lastLog = line
              }
            }
          }
          destroyVlc()
          console.log('[vlc-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2000)
    }

    // 媒体扫描自检（SAKANA_MEDIA_TEST=文件夹路径）：递归扫描视频与字幕后退出
    if (process.env.SAKANA_MEDIA_TEST) {
      setTimeout(() => {
        void (async () => {
          const { net } = await import('electron')
          const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url')
          const videos = listVideos(process.env.SAKANA_MEDIA_TEST!)
          console.log(`[media-test] 找到 ${videos.length} 个视频`)
          for (const v of videos) {
            console.log(`[media-test]   ${v.name} (ep=${v.episode ?? '?'}) 字幕: ${v.subs.map((s) => `${s.label}(${s.type})`).join(', ') || '无'}`)
            for (const s of v.subs) {
              const vtt = convertSubtitleToVtt(s.path)
              console.log(`[media-test]     → ${s.name} 转 VTT: ${vtt.replace(/\n/g, ' ⏎ ').slice(0, 120)}`)
            }
            if (!videos[0]) continue
            if (v === videos[0]) {
              // 协议层验证：net.fetch 直接请求 sakana-media / sakana-sub
              const mediaUrl = `sakana-media://local/${b64(v.path)}`
              const full = await net.fetch(mediaUrl)
              console.log(`[media-test] 协议 GET: ${full.status} type=${full.headers.get('content-type')} len=${full.headers.get('content-length')} acao=${full.headers.get('access-control-allow-origin')}`)
              const body = await full.arrayBuffer()
              console.log(`[media-test] 协议 GET 实际字节: ${body.byteLength}`)
              const ranged = await net.fetch(mediaUrl, { headers: { Range: 'bytes=0-99' } })
              const rBody = await ranged.arrayBuffer()
              console.log(`[media-test] 协议 Range: ${ranged.status} cr=${ranged.headers.get('content-range')} len=${ranged.headers.get('content-length')} 实际=${rBody.byteLength}`)
              if (v.subs[0]) {
                const subRes = await net.fetch(`sakana-sub://local/${b64(v.subs[0].path)}`)
                const subText = await subRes.text()
                console.log(`[media-test] 协议字幕: ${subRes.status} type=${subRes.headers.get('content-type')} acao=${subRes.headers.get('access-control-allow-origin')} 前40字:${subText.slice(0, 40).replace(/\n/g, ' ')}`)
              }
            }
          }
          // 渲染层探测：真实 <video> 元素加载协议 URL（假视频内容应得到解码错误码 3/4 而非网络错误码 2）
          const win = BrowserWindow.getAllWindows()[0]
          if (win && videos[0]) {
            await new Promise<void>((resolve) => {
              if (!win.webContents.isLoading()) return resolve()
              win.webContents.once('did-finish-load', () => resolve())
              setTimeout(resolve, 8000)
            })
            const mediaUrl = `sakana-media://local/${b64(videos[0].path)}`
            const result = (await win.webContents.executeJavaScript(
              `(async () => {
                const url = ${JSON.stringify(mediaUrl)}
                return await new Promise((resolve) => {
                  const v = document.createElement('video')
                  v.muted = true
                  v.crossOrigin = 'anonymous'
                  v.src = url
                  v.onerror = () => resolve({ kind: 'error', code: v.error ? v.error.code : -1, msg: v.error ? v.error.message : '' })
                  v.onloadedmetadata = () => resolve({ kind: 'ok', duration: v.duration })
                  setTimeout(() => resolve({ kind: 'timeout', networkState: v.networkState, readyState: v.readyState }), 12000)
                  v.load()
                })
              })()`
            )) as { kind: string; code?: number; msg?: string; networkState?: number; readyState?: number; duration?: number }
            console.log(`[media-test] 渲染层媒体探测: ${JSON.stringify(result)}`)
          }
          console.log('[media-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2000)
    }

    // 规则引擎自检（SAKANA_RULE_TEST=关键词）：依次用默认规则搜索并打印结果后退出
    // 离屏浏览器取数自检（SAKANA_OFFSCREEN_TEST=<url>）：
    // 用来验证「带机器人校验的镜像站能否在应用进程内取到真实页面」。
    // 之所以单独做成一个模式：同一个地址在纯净 Electron 探针里能开、
    // 在应用进程里却可能被重置，必须能在应用自身环境里复现与定位。
    if (process.env.SAKANA_OFFSCREEN_TEST) {
      const target = process.env.SAKANA_OFFSCREEN_TEST
      setTimeout(() => {
        void (async () => {
          const { offscreenGet } = await import('./services/offscreenFetch')
          try {
            const t = await offscreenGet(target)
            const title = /<title>([\s\S]{0,60}?)<\/title>/.exec(t)?.[1] ?? ''
            console.log(`[offscreen-test] ✅ ${t.length} 字节 标题=${title.replace(/\s+/g, ' ').trim()}`)
          } catch (err) {
            console.log(`[offscreen-test] ❌ ${String((err as Error)?.message ?? err)}`)
          }
          markQuitting()
          app.quit()
        })()
      }, 3000)
    }

    if (process.env.SAKANA_RULE_TEST) {
      const kw = process.env.SAKANA_RULE_TEST
      setTimeout(() => {
        void (async () => {
          for (const rule of DEFAULT_RULES) {
            const r = await ruleSearch(rule.id, kw)
            console.log(`[rule-test] ${rule.name}: ${r.items.length} 条结果${r.error ? ` (${r.error})` : ''}`)
            if (r.items.length === 0 && !r.error) {
              // 诊断：直接请求搜索地址看响应状态与长度
              try {
                const axios = (await import('axios')).default
                const url = rule.search.url.replace('@keyword', encodeURIComponent(kw))
                const res = await axios.get(url, {
                  timeout: 15000,
                  responseType: 'text',
                  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
                  validateStatus: () => true
                })
                const body = String(res.data ?? '')
                console.log(`[rule-test]   diag: HTTP ${res.status}, ${body.length}B, 头 160 字: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
              } catch (err) {
                console.log(`[rule-test]   diag: 请求失败 ${String(err)}`)
              }
            }
            const first = r.items[0]
            if (first) {
              console.log(`[rule-test]   → "${first.name}"`)
              const eps = await ruleEpisodes(rule.id, first)
              console.log(
                `[rule-test]   → 线路 ${eps.groups.length}${eps.groups[0] ? ` / 首线路剧集 ${eps.groups[0].episodes.length}` : ''}${eps.error ? ` (${eps.error})` : ''}`
              )
            }
          }
          console.log('[rule-test] done')
          markQuitting()
          app.quit()
        })()
      }, 3000)
    }
  })

  app.on('window-all-closed', () => {
    downloadManager.stop()
    app.quit()
  })

  app.on('before-quit', () => {
    markQuitting()
    downloadManager.stop()
    stopAllLive()
    store.flushAll()
    destroyTray()
  })

  process.on('uncaughtException', (err) => {
    log.append('error', 'app', `未捕获异常: ${err?.stack ?? String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    log.append('error', 'app', `未处理的 Promise 拒绝: ${String(reason)}`)
  })
}
