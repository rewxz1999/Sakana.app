import axios, { type AxiosRequestConfig } from 'axios'
import type { GalSiteSearchResult } from '@shared/types'
import { log } from '../log'
import { BROWSER_UA, buildProxyAgents, getSettings } from '../net'

/**
 * galgame 资源站「搜索数量统计」（galgame 库顶部搜索用）。
 *
 * 设计原则：
 * 1. **只在主进程发请求**：渲染层 fetch 会撞 CORS，且这些站点基本不发 CORS 头。
 * 2. **只回传数量 + 跳转链接**，绝不回传站点正文 —— 页面结构随时会变，
 *    而且需求本身只要求「有多少个结果 + 能跳过去」。
 * 3. **逐站独立、绝不互相拖累**：7 个请求并行、各自 try/catch + 单独超时，
 *    任何一站失败（需要 JS / Cloudflare 拦截 / 证书过期 / 超时）都只变成
 *    countKind='none'，界面显示「无法统计（前往站点搜索）」，绝不会有转圈卡住。
 * 4. **数量语义必须诚实**：站点给出分页总数才算「约 N 个结果」；
 *    只数得清首页清单的站点一律标成「首屏 N 个」（countKind='page'），
 *    数不出来的就明说无法统计，不编数字。
 *
 * 每个站点的 URL / 提取规则都来自本机真实 HTTP 探测（见各站注释里的实测结果）。
 */

/** 单站默认超时：正常站点都在 1.5s 内返回，7s 足够 */
const TIMEOUT_MS = 7000
/** 真红小站的搜索页会一次性直出 200KB+ 清单（实测 2.6~4.6s），给它更宽的超时 */
const SLOW_TIMEOUT_MS = 12000

function netCfg(timeout: number, extra: AxiosRequestConfig = {}): AxiosRequestConfig {
  const baseHeaders: Record<string, string> = {
    // 必须带浏览器 UA：多数站点对非浏览器 UA 直接 403
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/json,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  // 注意 headers 要显式合并：直接 {...base, ...extra} 会让 extra.headers 整个顶掉默认 UA
  return {
    timeout,
    responseType: 'text',
    maxRedirects: 5,
    // 拿原始文本，别让 axios 按 content-type 猜成对象
    transformResponse: (d: unknown) => d,
    ...buildProxyAgents(getSettings().proxy),
    ...extra,
    headers: { ...baseHeaders, ...((extra.headers ?? {}) as Record<string, string>) }
  }
}

async function getText(url: string, timeout = TIMEOUT_MS): Promise<string> {
  const res = await axios.get(url, netCfg(timeout))
  return String(res.data ?? '')
}

async function getJson(url: string, timeout = TIMEOUT_MS): Promise<unknown> {
  const res = await axios.get(url, netCfg(timeout, { headers: { Accept: 'application/json' } }))
  return JSON.parse(String(res.data ?? '')) as unknown
}

async function postJson(
  url: string,
  body: unknown,
  timeout = TIMEOUT_MS,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const cfg = netCfg(timeout)
  const res = await axios.post(url, body, {
    ...cfg,
    headers: {
      ...(cfg.headers as Record<string, string>),
      'Content-Type': 'application/json',
      ...headers
    }
  })
  return JSON.parse(String(res.data ?? '')) as unknown
}

/** 去掉 script/style/标签，只留可见文本（有的站点把计数写在标签之间） */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
}

interface ProbeResult {
  count: number
  kind: 'total' | 'page'
}

interface SiteProbe {
  key: string
  name: string
  host: string
  /** 人手点开的站点搜索页（永远可用，与能否统计无关） */
  pageUrl: (kw: string) => string
  probe: (kw: string) => Promise<ProbeResult>
  timeout?: number
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

const SITES: SiteProbe[] = [
  {
    // 稻荷acg：Nuxt 站，GET /api/search 是 404，必须 POST JSON；
    // 且参数名是 search（传 keyword 会被回「搜索关键词为空」）。
    // 实测 POST {search:'CLANNAD'} → data.pagination.total = 2、{search:'千恋万花'} → 1。
    // 跳转链接用站内首页的 ?search=（其 bundle 里 index 路由读的正是 query.search，
    // 站点自己的 SearchAction 也是 ?search={search_term_string}）。
    key: 'inarigal',
    name: '稻荷acg',
    host: 'inarigal.com',
    pageUrl: (kw) => `https://inarigal.com/?search=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const data = (await postJson('https://inarigal.com/api/search', { search: kw, page: 1 })) as {
        data?: { pagination?: { total?: unknown } }
      }
      const total = num(data?.data?.pagination?.total)
      if (total === null) throw new Error('响应里没有 pagination.total')
      return { count: total, kind: 'total' }
    }
  },
  {
    // 鲲gal：/api/search 必须带 type/page/limit（缺一个就 400）。
    // type=galgame 对应「Galgame 资料库」命中数，实测 CLANNAD → total=51、千恋万花 → 5。
    key: 'kungal',
    name: '鲲gal',
    host: 'kungal.com',
    pageUrl: (kw) => `https://www.kungal.com/search?keywords=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const url = `https://www.kungal.com/api/search?keywords=${encodeURIComponent(kw)}&type=galgame&page=1&limit=1`
      const data = (await getJson(url)) as { data?: { total?: unknown } }
      const total = num(data?.data?.total)
      if (total === null) throw new Error('响应里没有 data.total')
      return { count: total, kind: 'total' }
    }
  },
  {
    // GalgameX：Next.js（RSC）搜索页服务端直出结果，载荷里的 initialTotal 就是结果总数。
    // 实测 CLANNAD → 2、千恋万花 → 1、随便打的乱码 → 0。
    key: 'galgamex',
    name: 'GalgameX',
    host: 'galgamex.net',
    pageUrl: (kw) => `https://www.galgamex.net/search?q=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const html = await getText(`https://www.galgamex.net/search?q=${encodeURIComponent(kw)}`)
      const m = /initialTotal\\+"\s*:\s*(\d+)/.exec(html)
      const total = num(m?.[1])
      if (total === null) throw new Error('页面里没有 initialTotal')
      return { count: total, kind: 'total' }
    }
  },
  {
    // 真红小站：Next.js 搜索页把文件清单服务端直出（一次最多 200 条），
    // 但**页面里没有任何总数文案**，而且清单并未真正按关键词过滤（乱码关键词同样返回 200 条），
    // 因此只能数「清单里标题/路径含关键词的条目」= 首屏命中数，标成 countKind='page'，
    // 绝不冒充「约 N 个结果」。实测 CLANNAD → 18、千恋万花 → 5。
    key: 'shinnku',
    name: '真红小站',
    host: 'shinnku.com',
    timeout: SLOW_TIMEOUT_MS,
    pageUrl: (kw) => `https://www.shinnku.com/search?q=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const html = await getText(`https://www.shinnku.com/search?q=${encodeURIComponent(kw)}`, SLOW_TIMEOUT_MS)
      const needle = kw.toLowerCase()
      const links = new Set(
        [...html.matchAll(/href="(\/files\/[^"]+)"/g)].map((m) => {
          try {
            return decodeURIComponent(m[1]).toLowerCase()
          } catch {
            return m[1].toLowerCase()
          }
        })
      )
      return { count: [...links].filter((l) => l.includes(needle)).length, kind: 'page' }
    }
  },
  {
    // TouchGal：Kun 系补丁站的接口 POST /api/search/（载荷来自其开源客户端），返回 {galgames,total}。
    // 本机实测：touchgal.us / touchgal.top 的 TLS 证书已在 2026-06-28 过期，
    // www.touchgal.ink / .top 全站走 Cloudflare 挑战（403 Just a moment），
    // 所以正常情况下这里必然落到「无法统计」，但接口仍然是真实存在的，保留尝试。
    key: 'touchgal',
    name: 'TouchGal',
    host: 'touchgal.us',
    pageUrl: (kw) => `https://www.touchgal.us/search?q=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const body = {
        queryString: JSON.stringify([{ type: 'keyword', name: kw }]),
        limit: 1,
        searchOption: { searchInIntroduction: false, searchInAlias: true, searchInTag: false },
        page: 1,
        selectedType: 'all',
        selectedLanguage: 'all',
        selectedPlatform: 'all',
        sortField: 'resource_update_time',
        sortOrder: 'desc',
        selectedYears: ['all'],
        selectedMonths: ['all']
      }
      const data = (await postJson('https://www.touchgal.us/api/search/', body, TIMEOUT_MS, {
        'x-requested-with': 'kun-fetch',
        Referer: 'https://www.touchgal.us/'
      })) as { total?: unknown }
      const total = num(data?.total)
      if (total === null) throw new Error('响应里没有 total')
      return { count: total, kind: 'total' }
    }
  },
  {
    // NekoGAL：WordPress 主题搜索页 ?s=，页面直接写「搜索 X ，共找到 N 个文章」，N 就是总数。
    // 注意必须走 www 子域：apex 域名 nekogal.com 的证书已过期（2025-11-21），www 是有效的。
    // 实测 CLANNAD → 1、galgame → 3、乱码 → 0。
    key: 'nekogal',
    name: 'NekoGAL',
    host: 'nekogal.com',
    pageUrl: (kw) => `https://www.nekogal.com/?s=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const html = await getText(`https://www.nekogal.com/?s=${encodeURIComponent(kw)}`)
      const m = /共找到\s*([\d,]+)/.exec(visibleText(html))
      const total = num(m?.[1])
      if (total === null) throw new Error('页面里没有「共找到 N」')
      return { count: total, kind: 'total' }
    }
  },
  {
    // 绮梦 ACG：WordPress（onenav 主题）导航站，搜索页 ?s=。
    // body 上的 search-no-results 类名 = 明确 0 结果；否则数首页的 .posts-item 卡片，
    // 主题不输出总数（REST 的 wp-json 计数与站内搜索口径不一致，不能用），所以标 countKind='page'。
    // 实测 ?s=galgame → 首屏 10 个；?s=CLANNAD → search-no-results（0）。
    key: 'acgfav',
    name: '绮梦 ACG',
    host: 'acgfav.com',
    pageUrl: (kw) => `https://acgfav.com/?s=${encodeURIComponent(kw)}`,
    probe: async (kw) => {
      const html = await getText(`https://acgfav.com/?s=${encodeURIComponent(kw)}`)
      // 「没有结果」是站点自己给的确定结论，可以直接当作总数 0
      if (/search-no-results/.test(html)) return { count: 0, kind: 'total' }
      const count = (html.match(/class="posts-item/g) ?? []).length
      return { count, kind: 'page' }
    }
  }
]

/** 关键词清洗：站点查询串不接收换行/超长内容 */
function cleanKeyword(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * 硬超时兜底。
 * axios 自己也有 timeout，但 DNS 卡死 / 连接挂起等情况下 axios 的计时器不一定先到，
 * 这里再加一层，保证「界面上的转圈」永远不会超过单站预算。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 统计超时（>${ms}ms）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e as Error)
      }
    )
  })
}

/**
 * 并行查询 7 个资源站点的「结果数量」。永不抛错：
 * 单站异常 → count=null + countKind='none' + note（原因）。
 */
export async function galSearchSites(keyword: string): Promise<GalSiteSearchResult[]> {
  const kw = cleanKeyword(keyword)
  if (!kw) {
    return SITES.map((s) => ({
      key: s.key,
      name: s.name,
      host: s.host,
      count: null,
      countKind: 'none' as const,
      url: s.pageUrl(''),
      note: '关键词为空'
    }))
  }

  const started = Date.now()
  const results = await Promise.all(
    SITES.map(async (site): Promise<GalSiteSearchResult> => {
      const base = { key: site.key, name: site.name, host: site.host, url: site.pageUrl(kw) }
      try {
        const budget = site.timeout ?? TIMEOUT_MS + 1000
        const r = await withTimeout(site.probe(kw), budget, site.name)
        return { ...base, count: r.count, countKind: r.kind }
      } catch (err) {
        const note = String((err as { message?: string })?.message ?? err).slice(0, 120)
        return { ...base, count: null, countKind: 'none', note }
      }
    })
  )

  log.append(
    'info',
    'gal',
    `站点搜索统计「${kw}」耗时 ${Date.now() - started}ms：` +
      results.map((r) => `${r.key}=${r.countKind === 'none' ? '无法统计' : r.count}`).join(' ')
  )
  return results
}
