import { app, BrowserWindow, desktopCapturer, screen, session } from 'electron'
import { join } from 'node:path'
import { log } from './log'
import { registerIpc } from './ipc'
import { store } from './store'
import { bangumi } from './services/bangumi'
import { mikan } from './services/mikan'
import { downloadManager } from './services/downloader/manager'
import { registerMediaProtocols } from './services/media'
import { CH } from '@shared/channels'
import { ensureDefaultRules } from './services/rules'
import { createTray, destroyTray, markQuitting } from './tray'
import { createMainWindow, getMainWindow, realWindows } from './window'
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
      // 只看业务窗口：离屏取数窗口也是 BrowserWindow，误选它会把镜像站页面当成主窗口弹出来
      const wins = realWindows()
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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

            /*
             * 按钮链路自检（v0.2.5）：用户反馈「点播放器全屏按钮没反应」。
             * 小窗口下控制栏由悬浮窗绘制，按钮点下去是往主窗口发 overlayAction，
             * 所以这里直接模拟那条动作，验证「按下按钮 → 真的全屏」这一段是通的；
             * 同时检查悬浮窗是否跟随主窗口缩放（不跟随会导致按钮位置与命中区域错位）。
             */
            try {
              const { overlayWindow } = await import('./services/playerOverlay')
              const before = win.getBounds()
              // ① 缩放主窗口 → 悬浮窗应跟随
              win.setSize(before.width + 160, before.height + 120)
              await new Promise((r) => setTimeout(r, 700))
              const after = win.getBounds()
              const ow = overlayWindow()
              const ob = ow?.getBounds()
              const followed =
                !!ob && Math.abs(ob.width - after.width) <= 2 && Math.abs(ob.height - after.height) <= 2
              console.log(
                `[playerui] 窗口缩放跟随: 主窗口=${after.width}x${after.height} 悬浮窗=${ob ? `${ob.width}x${ob.height}` : '无'} 跟随=${followed}`
              )
              // ② 模拟悬浮窗上的「全屏播放」按钮
              win.webContents.send(CH.overlayAction, { type: 'toggleFullscreen' })
              await new Promise((r) => setTimeout(r, 1500))
              console.log(`[playerui] 按钮动作 toggleFullscreen → 全屏=${win.isFullScreen()}`)
              // ③ 再点一次应退出全屏
              win.webContents.send(CH.overlayAction, { type: 'toggleFullscreen' })
              await new Promise((r) => setTimeout(r, 1500))
              console.log(`[playerui] 再次点击 → 全屏=${win.isFullScreen()}（应为 false）`)
            } catch (err) {
              console.log(`[playerui] 按钮链路自检失败: ${String(err).slice(0, 140)}`)
            }
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

    /*
     * 弹幕自检（SAKANA_DANMAKU_TEST='番剧名[|集数]'，v0.2.8）：
     * 打印「匹配到哪个条目 / 第几集 / 弹幕条数 / 前几条内容 / 是否命中缓存」，
     * 并跑两遍（第二遍应命中磁盘缓存）——弹幕链路排查全靠它。
     */
    if (process.env.SAKANA_DANMAKU_TEST) {
      setTimeout(() => {
        void (async () => {
          const raw = String(process.env.SAKANA_DANMAKU_TEST)
          const [title, epRaw] = raw.split('|')
          const episode = Number.parseInt(epRaw ?? '1', 10) || 1
          const { matchDanmaku, loadDanmaku, episodeNumberFromTitle, seasonOfTitle } = await import('./services/danmaku')
          console.log(`[danmaku-test] 关键词「${title}」第 ${episode} 集`)
          console.log(
            `[danmaku-test] 集数解析自检：` +
              ['【renren】 第01集', 'EP03', '[05]', ' - 12 ', '第7话', '葬送的芙莉莲_28', '【qq】 葬送的芙莉莲[普通话版]_28']
                .map((s) => `${s}→${episodeNumberFromTitle(s)}`)
                .join(' | ')
          )
          console.log(
            `[danmaku-test] 季数解析自检：` +
              [
                '葬送的芙莉莲 第二季',
                '葬送的芙莉莲 第1季(2023)',
                '葬送的芙莉莲(2023)',
                'Sousou no Frieren S02E05',
                '间谍过家家 第二季(2023)',
                '无职转生Ⅱ 到了异世界就拿出真本事 Part 2',
                '败犬女主太多了！',
                'Frieren 2nd Season'
              ]
                .map((s) => `${s.slice(0, 20)}→第${seasonOfTitle(s)}季`)
                .join(' | ')
          )
          try {
            const m = await matchDanmaku(title, episode)
            console.log(`[danmaku-test] 匹配结果: ${m ? JSON.stringify(m) : '(未匹配到)'}`)
          } catch (err) {
            console.log(`[danmaku-test] 匹配失败: ${String(err)}`)
          }
          for (const round of [1, 2]) {
            try {
              const t0 = Date.now()
              const r = await loadDanmaku(title, episode)
              if (!r) {
                console.log(`[danmaku-test] 第 ${round} 遍：未拿到弹幕`)
                continue
              }
              console.log(
                `[danmaku-test] 第 ${round} 遍：${r.animeTitle} / ${r.episodeTitle} | 共 ${r.count} 条 | ` +
                  `缓存命中=${r.fromCache} | 用时 ${Date.now() - t0}ms`
              )
              console.log(
                `[danmaku-test]   前 5 条: ${r.comments
                  .slice(0, 5)
                  .map((c) => `${c.time}s[${c.mode}]${c.color} ${c.text}`)
                  .join(' ／ ')}`
              )
            } catch (err) {
              console.log(`[danmaku-test] 第 ${round} 遍失败: ${String(err)}`)
            }
          }
          console.log('[danmaku-test] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
    }

    /*
     * 播放器输入自检（SAKANA_PLAYER_INPUT_TEST='番剧名'，v0.2.8 附加）。
     *
     * 用来复现「播放器按键全部失灵、但 Esc 还能退出」这类问题：
     * 1) 控制栏隐藏后，鼠标移入是否重新变为可交互（poke → setInteractive(true)）；
     * 2) 控制栏按钮位置上的**命中测试**（elementFromPoint 拿到的到底是谁）；
     * 3) 发**真实鼠标事件**点击播放/暂停与选集，看状态是否真的变化；
     * 4) 给主窗口发真实键盘事件（空格），看快捷键是否生效。
     */
    if (process.env.SAKANA_PLAYER_INPUT_TEST) {
      setTimeout(() => {
        void (async () => {
          const kw = String(process.env.SAKANA_PLAYER_INPUT_TEST)
          const ruleName = process.env.SAKANA_PLAYER_INPUT_RULE ?? 'aafun'
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
          if (!win) return
          const { ruleEpisodes, rulePlay, ruleSearch } = await import('./services/rules')
          const rules = store.get<import('@shared/types').PlayRule[]>('rules', [])
          const rule =
            rules.find((r) => r.enabled && r.name.toLowerCase().includes(ruleName.toLowerCase())) ??
            rules.find((r) => r.enabled)
          if (!rule) {
            console.log('[input-test] 没有可用规则')
            markQuitting()
            app.quit()
            return
          }
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
          const s = await ruleSearch(rule.id, kw)
          if (!s.items.length) {
            console.log('[input-test] 搜索无结果')
            markQuitting()
            app.quit()
            return
          }
          const ep = await ruleEpisodes(rule.id, s.items[0])
          const g = ep.groups[0]
          if (!g) {
            console.log('[input-test] 没有剧集')
            markQuitting()
            app.quit()
            return
          }
          const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, ep.vars)
          const state = {
            mode: 'rule',
            title: s.items[0].name || kw,
            url: play.url,
            ruleId: rule.id,
            entry: s.items[0],
            vars: ep.vars,
            groups: ep.groups,
            referer: rule.baseUrl,
            startLine: 0,
            startEp: 0
          }
          const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
          const hash = `/player?ts=${encodeURIComponent(b64)}`
          const devUrl = process.env['ELECTRON_RENDERER_URL']
          if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#${hash}`)
          else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash })

          const { overlayWindow, isOverlayInteractive } = await import('./services/playerOverlay')
          const readOverlay = async (): Promise<{ text: string; visible: boolean }> => {
            const ow = overlayWindow()
            if (!ow || ow.isDestroyed()) return { text: '(无悬浮窗)', visible: false }
            const raw = (await ow.webContents.executeJavaScript(
              `JSON.stringify({text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160),visible:!!document.querySelector('[class*="bottom-0"]')&&getComputedStyle(document.querySelector('[class*="bottom-0"]')).opacity!=='0'})`,
              true
            )) as string
            return JSON.parse(raw) as { text: string; visible: boolean }
          }
          /** 在悬浮窗里做命中测试：返回该坐标最上层元素 */
          const hitTest = async (x: number, y: number): Promise<string> => {
            const ow = overlayWindow()
            if (!ow || ow.isDestroyed()) return '(无悬浮窗)'
            return (await ow.webContents.executeJavaScript(
              `(function(){var el=document.elementFromPoint(${x},${y});if(!el)return '(空)';var c=el.tagName+(el.className&&typeof el.className==='string'?'.'+el.className.split(' ').slice(0,3).join('.'):'');return c.slice(0,90)})()`,
              true
            )) as string
          }
          const clickAt = async (x: number, y: number): Promise<void> => {
            const ow = overlayWindow()
            if (!ow || ow.isDestroyed()) return
            ow.webContents.sendInputEvent({ type: 'mouseMove', x, y })
            await sleep(120)
            ow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
            await sleep(60)
            ow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          }

          // 轮询等待：控制栏出现且真的开播了再开始测（固定等待在慢站点上会测了个空）
          let ready = false
          for (let i = 0; i < 40; i++) {
            const ow = overlayWindow()
            if (ow && !ow.isDestroyed()) {
              const t = (await readOverlay()).text
              if (t.includes('播放中')) {
                ready = true
                break
              }
            }
            await sleep(2000)
          }
          console.log(`[input-test] 开播就绪=${ready}`)
          if (!ready) {
            console.log('[input-test] 播放未就绪，跳过后续输入测试')
            markQuitting()
            app.quit()
            return
          }
          const ow0 = overlayWindow()
          const size = ow0 && !ow0.isDestroyed() ? ow0.getContentBounds() : { width: 1280, height: 800 }
          const cx = Math.round(size.width / 2)
          const cyBottom = size.height - 40
          const a = await readOverlay()
          console.log(`[input-test] 初始：可交互=${isOverlayInteractive()} 控制栏可见=${a.visible} | ${a.text}`)

          // ① 空闲 6 秒让控制栏自动隐藏，再模拟鼠标移入
          await sleep(6500)
          const b = await readOverlay()
          console.log(`[input-test] 空闲后：可交互=${isOverlayInteractive()} 控制栏可见=${b.visible}`)
          ow0?.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cyBottom - 120 })
          await sleep(1200)
          const c = await readOverlay()
          console.log(`[input-test] 鼠标移入后：可交互=${isOverlayInteractive()} 控制栏可见=${c.visible}`)

          // ② 命中测试：底部控制栏一行
          const hits: string[] = []
          for (const dx of [-260, -200, 0, 120, 220]) {
            hits.push(`${dx}:${await hitTest(cx + dx, cyBottom)}`)
          }
          console.log(`[input-test] 命中测试(y=${cyBottom})：${hits.join(' | ')}`)

          // ③ 真实点击「播放/暂停」（左下角第一个按钮）与「选集」
          const before = await readOverlay()
          await clickAt(30, cyBottom)
          await sleep(2500)
          const afterPause = await readOverlay()
          console.log(`[input-test] 点击播放/暂停：${before.text.includes('播放中') ? '播放中' : '?'} → ${afterPause.text}`)
          await clickAt(30, cyBottom)
          await sleep(2000)

          // ④ 键盘：给主窗口发真实空格
          const beforeKey = await readOverlay()
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
          win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
          await sleep(2500)
          const afterKey = await readOverlay()
          console.log(`[input-test] 键盘空格：${beforeKey.text.includes('播放中') ? '播放中' : '?'} → ${afterKey.text}`)

          /*
           * ⑤ owner 归属自检（v0.2.8 附加）：
           * 「所有按钮都没反应」的经典原因之一是控制栏 owner 认成了别的小窗口 ——
           * 这里故意打开并聚焦一个「弹幕设置」小窗口，再从**播放页所在窗口**请求显示控制栏，
           * 打印出 owner 是谁。owner 应该是播放页那个窗口（且不聚焦），而不是刚打开的小窗口。
           */
          const { openSmallWindow } = await import('./window')
          const { logOverlayOwner } = await import('./services/playerOverlay')
          const small = openSmallWindow('/danmaku-settings', { width: 620, height: 560, title: '弹幕设置' })
          small.focus()
          await sleep(1800)
          console.log(`[input-test] 小窗口已聚焦：${small.isFocused()}`)
          /*
           * v0.2.8 附加五（用户定位的显示 bug）：主窗口被别的窗口盖住时，
           * 控制栏悬浮窗不能继续浮在别人窗口之上，否则「卡在别人窗口的位置上、点什么都没反应」。
           * 这里验证：① 小窗口抢焦点后控制栏自动收起；② 主窗口回前台后控制栏恢复且仍可点击。
           */
          const owFocus = overlayWindow()
          console.log(
            `[input-test] 主窗口失焦后：控制栏可见=${owFocus && !owFocus.isDestroyed() ? owFocus.isVisible() : '(无)'}（期望 false）`
          )
          await win.webContents
            .executeJavaScript(`window.sakana && window.sakana.overlay.show()`, true)
            .catch(() => undefined)
          await sleep(1200)
          const owStill = overlayWindow()
          console.log(
            `[input-test] 失焦状态下播放页请求 show 后：控制栏可见=${owStill && !owStill.isDestroyed() ? owStill.isVisible() : '(无)'}（期望仍为 false）`
          )
          win.focus()
          await sleep(1800)
          const owBack = overlayWindow()
          console.log(
            `[input-test] 主窗口回前台后：控制栏可见=${owBack && !owBack.isDestroyed() ? owBack.isVisible() : '(无)'}（期望 true）`
          )
          logOverlayOwner('播放页请求显示控制栏后')
          await clickAt(30, cyBottom)
          await sleep(2500)
          const afterSmall = await readOverlay()
          console.log(`[input-test] 回到前台后点击播放/暂停：${afterSmall.text}`)
          if (!small.isDestroyed()) small.destroy()

          console.log('[input-test] done')
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
            // v0.2.7：番剧详情页也纳入 —— 数据源换成自建反代后，这里最容易出现「信息缺字段」
            '/subject/400602',
            /*
             * v0.2.7 附加：收藏页纳入 —— 收藏里存的封面是镜像图床地址
             * （`lain.bangumi.pro`），图片改写没覆盖到时整页封面全空，
             * 靠 imgs/badImgs 两个计数就能直接判定。
             */
            '/favorites',
            '/rules',
            '/shortcuts',
            '/player-settings',
            '/cache-settings',
            // v0.2.8：弹幕设置页
            '/danmaku-settings',
            '/datasource',
            '/logs',
            '/about',
            '/save-dirs',
            '/nav-bg',
            '/downloader-config',
            '/galgame/tools',
            // v0.2.8 附加：galgame 页（空态默认背景图）纳入
            '/galgame',
            // v0.2.8 附加三：仪表盘（统计板块瘦身）纳入
            '/dashboard',
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
                      heads:txt('[class*="font-semibold"]',8),
                      /*
                       * 图片核对（v0.2.7 附加）：封面这类问题过去只能靠肉眼看，
                       * 这里直接统计「有几张图真的解码出来了」（naturalWidth>0）以及失败数量 —
                       * 收藏/订阅封面全部不显示时，这里会是 imgs=0 / badImgs=N。
                       */
                      imgs:Array.prototype.filter.call(document.images||[],function(i){return i.complete&&i.naturalWidth>0}).length,
                      badImgs:Array.prototype.filter.call(document.images||[],function(i){return i.complete&&i.naturalWidth===0}).length,
                      imgHosts:Array.from(new Set(Array.prototype.map.call(document.images||[],function(i){try{return new URL(i.src).host}catch(e){return i.src.slice(0,24)}}))).slice(0,4),
                      // 详情页核对用：把正文前 600 字带出来，能直接看到上映日期/导演/製作等是否渲染
                      text:(b?(b.innerText||'').replace(/\\s+/g,' ').slice(0,600):'')
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
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

    /*
     * 自动连播自检（SAKANA_EPISODE_TEST=<关键词>）：真实复现「播完第 1 集是否跳到第 2 集」。
     *
     * 为什么要做成自检：用户反馈「自动连播总是跳到最后一集」，而这个行为只有在
     * 「播到本集末尾」那一刻才会发生 —— 手动等到 24 分钟不现实，所以这里
     * 直接在播放器里 seek 到结尾前 8 秒，然后观察接下来切到了哪一集。
     * 判定依据取自悬浮窗渲染的标题/副标题（那里写着当前集名）。
     */
    if (process.env.SAKANA_EPISODE_TEST) {
      const kw = process.env.SAKANA_EPISODE_TEST
      setTimeout(() => {
        void (async () => {
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
          if (!win) return
          const { ruleEpisodes, rulePlay, ruleSearch } = await import('./services/rules')
          const rules = store.get<import('@shared/types').PlayRule[]>('rules', [])
          const rule =
            rules.find((r) => r.enabled && r.name.toLowerCase().includes((process.env.SAKANA_EPISODE_RULE ?? 'aafun').toLowerCase())) ??
            rules.find((r) => r.enabled)
          if (!rule) {
            console.log('[episode-test] 没有可用规则')
            markQuitting()
            app.quit()
            return
          }
          const s = await ruleSearch(rule.id, kw)
          if (!s.items.length) {
            console.log(`[episode-test] 搜索无结果（${rule.name} / ${kw}）`)
            markQuitting()
            app.quit()
            return
          }
          const ep = await ruleEpisodes(rule.id, s.items[0])
          const g = ep.groups[0]
          if (!g || g.episodes.length < 3) {
            console.log(`[episode-test] 剧集不足（${g?.episodes.length ?? 0} 集）`)
            markQuitting()
            app.quit()
            return
          }
          console.log(
            `[episode-test] ${rule.name} 命中 ${g.episodes.length} 集，前 3 集：${g.episodes.slice(0, 3).map((e) => e.name).join(' / ')}`
          )
          const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, ep.vars)
          const devUrl = process.env['ELECTRON_RENDERER_URL']
          const state = {
            mode: 'rule',
            title: s.items[0].name || '自检',
            url: play.url,
            ruleId: rule.id,
            entry: s.items[0],
            vars: ep.vars,
            groups: ep.groups,
            referer: rule.baseUrl,
            startLine: 0,
            startEp: 0
          }
          console.log(`[episode-test] 播放页 ${play.url.slice(0, 110)}`)
          // 渲染层日志转发：自动连播的判定与切换过程都在渲染层，必须能看见
          win.webContents.on('console-message', (...args: unknown[]) => {
            const d =
              typeof args[1] === 'object' && args[1] !== null
                ? (args[1] as { level?: string; message?: string })
                : { level: String(args[1]), message: String(args[2]) }
            const msg = String(d.message ?? '')
            if (/自动连播|切集|player\]/.test(msg)) console.log(`[renderer] ${msg.slice(0, 200)}`)
          })
          /*
           * 状态注入：file:// 源下 Chromium 不保留 sessionStorage，所以把状态 base64 后
           * 作为 URL 参数传给播放页（渲染层只在参数存在时读取，正常运行完全不受影响）。
           */
          const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
          const hash = `/player?ts=${encodeURIComponent(b64)}`
          if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#${hash}`)
          else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
          await new Promise((r) => setTimeout(r, 2500))

          const readEpisode = async (): Promise<string> => {
            try {
              const { overlayWindow } = await import('./services/playerOverlay')
              const ow = overlayWindow()
              if (!ow || ow.isDestroyed()) return '(无悬浮窗)'
              const text = (await ow.webContents.executeJavaScript(
                `(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)`,
                true
              )) as string
              // 一并读出播放页当前持有的路由状态（线路/集序号/是否自动连播），
              // 这样「到底请求了第几集」一目了然，不用靠猜
              const navState = (await win.webContents
                .executeJavaScript(`JSON.stringify((history.state&&history.state.usr)||{})`, true)
                .catch(() => '{}')) as string
              let brief = ''
              try {
                const st = JSON.parse(navState) as { startLine?: number; startEp?: number; auto?: boolean; url?: string }
                brief = ` nav=${st.startLine ?? '-'}:${st.startEp ?? '-'} ${String(st.url ?? '').slice(-14)}`
              } catch {
                /* ignore */
              }
              return text + brief
            } catch {
              return '(读取失败)'
            }
          }
          const { engineGetState, engineSeekSec } = await import('./services/playerEngine')
          // 等待探流 + 开播
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 5000))
            const st = engineGetState()
            const ui = await readEpisode()
            console.log(`[episode-test] 等待开播 ${(i + 1) * 5}s: ${JSON.stringify(st)} | UI=${ui.slice(0, 60)}`)
            if (st?.playing && st.length > 60000) break
          }
          const before = engineGetState()
          if (!before || before.length <= 0) {
            console.log('[episode-test] ❌ 未能开播，无法验证自动连播')
            markQuitting()
            app.quit()
            return
          }
          console.log(`[episode-test] 本集时长 ${Math.round(before.length / 1000)}s，跳到结尾前 8 秒观察自动连播`)
          engineSeekSec(before.length / 1000 - 8)
          for (let i = 0; i < 14; i++) {
            await new Promise((r) => setTimeout(r, 5000))
            const ui = await readEpisode()
            const st = engineGetState()
            console.log(
              `[episode-test] 观察 ${(i + 1) * 5}s: time=${st ? Math.round(st.time / 1000) : '?'}s len=${st ? Math.round(st.length / 1000) : '?'}s UI=${ui.slice(0, 70)}`
            )
          }
          markQuitting()
          app.quit()
        })()
      }, 5000)
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

    /*
     * 弹幕 UI 自检（SAKANA_DANMAKU_UI_TEST='番剧名'，v0.2.8）。
     *
     * 为什么要读**画布像素**：弹幕是画在悬浮窗 canvas 上的（画在播放页里会被原生视频盖住），
     * 「有没有真的画出来」无法从日志判断 —— 这里直接数非透明像素，
     * 并顺带验证「关闭弹幕 → 像素归零 → 重新打开 → 像素恢复」和「改覆盖区域不炸」。
     * 覆盖区域变小后同屏条数下降，像素数通常会明显减少，也可作为生效判据。
     */
    if (process.env.SAKANA_DANMAKU_UI_TEST) {
      setTimeout(() => {
        void (async () => {
          const kw = String(process.env.SAKANA_DANMAKU_UI_TEST)
          const ruleName = process.env.SAKANA_DANMAKU_UI_RULE ?? 'aafun'
          const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
          if (!win) return
          const { ruleEpisodes, rulePlay, ruleSearch } = await import('./services/rules')
          const rules = store.get<import('@shared/types').PlayRule[]>('rules', [])
          const rule =
            rules.find((r) => r.enabled && r.name.toLowerCase().includes(ruleName.toLowerCase())) ??
            rules.find((r) => r.enabled)
          if (!rule) {
            console.log('[danmaku-ui] 没有可用规则')
            markQuitting()
            app.quit()
            return
          }
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
          /*
           * 本地播放模式（SAKANA_DANMAKU_UI_LOCAL='<文件夹>|<标题>'）：
           * 本地播放同样要能用弹幕，所以这里也走一遍 —— 状态直接注入 local 模式，
           * 跳过规则搜索（本地播放不需要规则）。
           */
          const localSpec = process.env.SAKANA_DANMAKU_UI_LOCAL
          let state: Record<string, unknown>
          if (localSpec) {
            const [folder, title] = localSpec.split('|')
            state = { mode: 'local', title: title || '本地视频', folder }
            console.log(`[danmaku-ui] 本地播放模式：文件夹 ${folder}，标题「${title}」`)
          } else {
            const s = await ruleSearch(rule.id, kw)
            if (!s.items.length) {
              console.log(`[danmaku-ui] 搜索无结果（${rule.name} / ${kw}）`)
              markQuitting()
              app.quit()
              return
            }
            const ep = await ruleEpisodes(rule.id, s.items[0])
            const g = ep.groups[0]
            if (!g) {
              console.log('[danmaku-ui] 没有剧集')
              markQuitting()
              app.quit()
              return
            }
            const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, ep.vars)
            state = {
              mode: 'rule',
              title: s.items[0].name || kw,
              url: play.url,
              ruleId: rule.id,
              entry: s.items[0],
              vars: ep.vars,
              groups: ep.groups,
              referer: rule.baseUrl,
              startLine: 0,
              startEp: 0
            }
            console.log(`[danmaku-ui] ${rule.name} 《${state.title}》 第 1 集，播放页 ${play.url.slice(0, 90)}`)
          }
          win.webContents.on('console-message', (...args: unknown[]) => {
            const d =
              typeof args[1] === 'object' && args[1] !== null
                ? (args[1] as { message?: string })
                : { message: String(args[2]) }
            const msg = String(d.message ?? '')
            // 弹幕自检需要看到播放页的全部异常（否则崩溃时只能看到「无悬浮窗」）
            if (/弹幕|player|Error|error|Uncaught|失败|警告/.test(msg)) console.log(`[renderer] ${msg.slice(0, 300)}`)
          })
          const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
          const hash = `/player?ts=${encodeURIComponent(b64)}`
          const devUrl = process.env['ELECTRON_RENDERER_URL']
          if (!app.isPackaged && devUrl) await win.loadURL(`${devUrl}#${hash}`)
          else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash })

          const { overlayWindow } = await import('./services/playerOverlay')
          /** 读取悬浮窗：正文 + canvas 非透明像素数 */
          const probe = async (label: string): Promise<{ px: number; canvas: boolean; text: string }> => {
            const ow = overlayWindow()
            if (!ow || ow.isDestroyed()) {
              console.log(`[danmaku-ui] ${label}: (无悬浮窗)`)
              return { px: 0, canvas: false, text: '' }
            }
            try {
              const raw = (await ow.webContents.executeJavaScript(
                `(function(){
                   var c=document.querySelector('canvas');
                   var px=0;
                   if(c){try{var ctx=c.getContext('2d');var d=ctx.getImageData(0,0,c.width,c.height).data;
                     for(var i=3;i<d.length;i+=4){if(d[i]>8)px++}}catch(e){px=-1}}
                   return JSON.stringify({px:px,canvas:!!c,size:c?c.width+'x'+c.height:'',css:c?(c.style.width+'x'+c.style.height+' @'+c.style.top):'',dbg:window.__sakanaDanmaku||null,mount:window.__sakanaDanmakuMount===true,hasCanvas:window.__sakanaDanmakuHasCanvas===true,hasCtx:window.__sakanaDanmakuHasCtx===true,frames:window.__sakanaDanmakuFrames||0,text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,150)})
                 })()`,
                true
              )) as string
              const o = JSON.parse(raw) as {
                px: number
                canvas: boolean
                size: string
                css: string
                text: string
                dbg: unknown
                mount: boolean
                hasCanvas: boolean
                hasCtx: boolean
                frames: number
              }
              console.log(
                `[danmaku-ui] ${label}: canvas=${o.canvas} 背板=${o.size} CSS=${o.css} 像素=${o.px} 帧=${o.frames} ` +
                  `挂载=${o.mount} ref=${o.hasCanvas} ctx=${o.hasCtx} 探针=${JSON.stringify(o.dbg)} | ${o.text}`
              )
              return { px: o.px, canvas: o.canvas, text: o.text }
            } catch (err) {
              console.log(`[danmaku-ui] ${label}: 读取失败 ${String(err).slice(0, 120)}`)
              return { px: 0, canvas: false, text: '' }
            }
          }

          // 等播放起来 + 弹幕加载完
          await sleep(22000)
          let maxPlaying = 0
          for (let i = 0; i < 4; i++) {
            const a = await probe(`播放中 #${i + 1}`)
            maxPlaying = Math.max(maxPlaying, a.px)
            await sleep(4000)
          }
          // 关闭弹幕 → 像素应归零
          win.webContents.send(CH.overlayAction, { type: 'toggleDanmaku' })
          await sleep(2500)
          const off = await probe('关闭弹幕后')
          // 重新打开 → 像素应恢复
          win.webContents.send(CH.overlayAction, { type: 'toggleDanmaku' })
          await sleep(6000)
          const on = await probe('重新打开后')
          // 改覆盖区域（缩小到 1/4）与时间轴，验证不崩且仍在绘制
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'area', value: 0.25 })
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'offsetMs', value: -1000 })
          await sleep(6000)
          const area = await probe('覆盖区域 1/4 + 时间轴 -1s')
          // 关掉滚动弹幕（只留顶部/底部）再打开
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'showScroll', value: false })
          await sleep(4000)
          const noScroll = await probe('关闭滚动弹幕')
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'showScroll', value: true })
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'area', value: 1 })
          win.webContents.send(CH.overlayAction, { type: 'danmakuSetting', key: 'offsetMs', value: 0 })
          await sleep(5000)
          const restored = await probe('恢复默认设置')
          // 别名检测：会用番剧别名 + 弹幕库别名再搜一轮
          win.webContents.send(CH.overlayAction, { type: 'detectDanmakuAlias' })
          await sleep(15000)
          const alias = await probe('别名检测后')

          console.log(
            `[danmaku-ui] 结论：播放中最大像素=${maxPlaying} | 关闭后=${off.px} | 重开=${on.px} | ` +
              `区域1/4=${area.px} | 关滚动=${noScroll.px} | 恢复=${restored.px} | 别名检测=${alias.px}`
          )
          /*
           * 判据说明：这一集弹幕可能很稀疏（例如只有 15 条、间隔几十秒），
           * 所以只要求「播放期间至少有一帧真的画出了弹幕」，以及开关的挂载/卸载行为正确。
           */
          const pass = maxPlaying > 200 && off.canvas === false && on.canvas === true
          console.log(
            `[danmaku-ui] ${pass ? '✅ 通过' : '❌ 未通过'}` +
              `（判据：播放中画出过弹幕、关闭后画布移除、重开后画布回来）`
          )
          console.log('[danmaku-ui] done')
          markQuitting()
          app.quit()
        })()
      }, 2500)
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
