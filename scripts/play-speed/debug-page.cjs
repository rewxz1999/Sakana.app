/*
 * 排障用：打印某部番某条规则的「播放页地址 + 页面里有没有直出地址」。
 * 用法：node -r ./scripts/play-speed/bootstrap.cjs ./scripts/play-speed/debug-page.cjs <规则id> <关键词>
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const path = require('path')
const OUT = process.env.SAKANA_SPEED_OUT || path.join(__dirname, '..', '..', '.tmp-play-speed', 'out')
const R = (p) => require(path.join(OUT, 'src', 'main', 'services', p))
const CORE = (p) => require(path.join(OUT, 'src', 'main', p))
const { store } = CORE('store')
const { log } = CORE('log')
const { ensureDefaultRules, rulePlay, ruleSearch, ruleEpisodes } = R('rules')
const ruleProbe = R('ruleProbe')

async function main() {
  store.init()
  log.init()
  ensureDefaultRules()
  const ruleId = process.argv[2] || 'default-aafun'
  const kw = process.argv[3] || '葬送的芙莉莲'
  const rule = store.get('rules', []).find((r) => r.id === ruleId)
  if (!rule) {
    console.log('没有规则', ruleId)
    return
  }
  const s = await ruleSearch(rule.id, kw)
  console.log('搜索', s.items.length, s.error || '')
  const eps = await ruleEpisodes(rule.id, s.items[0])
  console.log('剧集线路', eps.groups.map((g) => `${g.lineName || '?'}:${g.episodes.length}`).join(' '))
  const g = eps.groups[0]
  const play = await rulePlay(rule.id, s.items[0], 0, 0, g.episodes[0].link, eps.vars || {})
  console.log('播放页', play && play.url, 'referer', play && play.referer)
  if (!play) return
  const t0 = Date.now()
  const res = await fetch(play.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: rule.baseUrl
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  }).catch((e) => ({ status: 0, text: async () => String(e), url: play.url }))
  const text = await res.text()
  console.log('直连播放页', res.status, res.url, text.length, Date.now() - t0 + 'ms')
  const idx = text.indexOf('player_aaaa')
  console.log('player_aaaa 位置', idx, idx >= 0 ? JSON.stringify(text.slice(idx, idx + 220)) : '')
  console.log('m3u8 出现次数', (text.match(/m3u8/g) || []).length, 'mp4', (text.match(/mp4/g) || []).length)
  const cands = await ruleProbe.extractStreamCandidates(play.url, rule.baseUrl).catch((e) => [`ERR ${e}`])
  console.log('extractStreamCandidates', cands.length, cands.slice(0, 3).map((c) => String(c).slice(0, 100)))
}

void main().then(
  () => setTimeout(() => process.exit(0), 100),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
