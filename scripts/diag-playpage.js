// 诊断：抓不到的播放页里到底有什么（player_aaaa / iframe / 直链 / 播放器脚本）
// 用法：node scripts/diag-playpage.js <播放页URL> [...]
const axios = require('axios')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function decodeMac(raw, encrypt) {
  let out = String(raw ?? '').replace(/\\\//g, '/')
  if (Number(encrypt ?? 0) === 2) {
    try {
      const d = Buffer.from(out, 'base64').toString('utf8')
      if (d && /^%|^https?:\/\//i.test(d)) out = d
    } catch {
      /* ignore */
    }
  }
  for (let i = 0; i < 3; i++) {
    if (/^https?:\/\//i.test(out)) break
    try {
      const d = decodeURIComponent(out)
      if (d === out) break
      out = d
    } catch {
      break
    }
  }
  return out.replace(/\\\//g, '/')
}

;(async () => {
  for (const url of process.argv.slice(2)) {
    console.log(`\n===== ${url} =====`)
    try {
      const r = await axios.get(url, {
        timeout: 25000,
        responseType: 'text',
        headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' },
        validateStatus: () => true
      })
      const h = String(r.data)
      console.log(`HTTP ${r.status} ${h.length}B  标题=${((/<title>([\s\S]{0,50}?)<\/title>/.exec(h) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim()}`)
      const pa = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/.exec(h)
      if (pa) {
        const enc = (/encrypt"\s*:\s*(\d+)/.exec(pa[1]) ?? [])[1]
        const rawUrl = (/"url"\s*:\s*"([^"]+)"/.exec(pa[1]) ?? [])[1]
        console.log(`  player_aaaa: encrypt=${enc} from=${(/"from"\s*:\s*"([^"]+)"/.exec(pa[1]) ?? [])[1]}`)
        console.log(`  解码后 = ${decodeMac(rawUrl, enc).slice(0, 140)}`)
      } else {
        console.log('  无 player_aaaa')
      }
      const direct = [...h.matchAll(/https?:(?:\\?\/){2}[^"'\s\\<>]+\.(?:m3u8|mp4|flv)(?:\?[^"'\s\\<>]*)?/gi)]
        .map((m) => decodeMac(m[0], 0))
        .slice(0, 3)
      console.log(`  直链候选 ${direct.length} 条: ${direct.map((d) => d.slice(0, 100)).join(' | ') || '(无)'}`)
      const iframe = [...h.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 4)
      console.log(`  iframe ${iframe.length} 个: ${iframe.join(' | ') || '(无)'}`)
      const scripts = [...h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 6)
      console.log(`  外部脚本: ${scripts.join(' | ').slice(0, 200) || '(无)'}`)
      for (const k of ['MacPlayer', 'artplayer', 'DPlayer', 'Hls', 'hls.js', 'parse.js', 'player.js']) {
        if (h.includes(k)) console.log(`    · 含 ${k}`)
      }
    } catch (e) {
      console.log(`  请求失败: ${String(e.message).slice(0, 120)}`)
    }
  }
})()
