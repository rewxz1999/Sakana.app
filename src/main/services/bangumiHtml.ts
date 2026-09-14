// bangumi 网页镜像（bangumi.pro / bgm.tv 网页版）HTML 解析器
// 网页镜像没有 JSON API，从服务端渲染的页面中提取结构化数据
import type { CalendarDay, CoverImages, SearchResultItem, SubjectDetail } from '@shared/types'

const DAY_ID: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const DAY_CN: Record<number, string> = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' }
const DAY_EN: Record<number, string> = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' }
const DAY_JA: Record<number, string> = { 1: '月曜日', 2: '火曜日', 3: '水曜日', 4: '木曜日', 5: '金曜日', 6: '土曜日', 7: '日曜日' }

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

export function stripTags(s: string, keepBr = false): string {
  let out = s
  if (keepBr) out = out.replace(/<br\s*\/?>/gi, '\n')
  else out = out.replace(/<br\s*\/?>/gi, ' ')
  out = out.replace(/<[^>]+>/g, '')
  return decodeEntities(out).replace(/[ \t]+/g, ' ').trim()
}

function fixProtocol(url: string): string {
  if (url.startsWith('//')) return `https:${url}`
  return url
}

/** 去掉 /r/xxx 缩放前缀，取原图 */
function originalImage(url: string): string {
  return fixProtocol(url).replace(/\/r\/\d+\//, '/')
}

function makeImages(raw: string | null): CoverImages | null {
  if (!raw) return null
  const full = originalImage(raw)
  const common = full
  const large = full
  const medium = full
  const small = full
  return { common, large, medium, small, grid: full }
}

/** 找与 openTagStart 处 <li> 匹配的 </li>（处理嵌套 li） */
function findLiEnd(html: string, openTagStart: number): number {
  let depth = 0
  const re = /<li[\s>]|<\/li>/g
  re.lastIndex = openTagStart
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--
      if (depth === 0) return m.index
    } else {
      depth++
    }
  }
  return -1
}

/** 解析 /calendar 网页（bgm 经典日历结构：一周 = 7 个 li.week，周日开头） */
export function parseCalendar(html: string): CalendarDay[] {
  const days: CalendarDay[] = []
  const dayMap = new Map<number, CalendarDay['items']>()

  const weekRe = /<li class="week[^"]*">/g
  let w: RegExpExecArray | null
  while ((w = weekRe.exec(html)) !== null) {
    const weekEnd = findLiEnd(html, w.index)
    const block = html.slice(w.index, weekEnd >= 0 ? weekEnd : html.length)
    const dtMatch = /<dt class="(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^"]*"/.exec(block)
    if (!dtMatch) continue
    const id = DAY_ID[dtMatch[1]]
    if (!id) continue

    const ddStart = block.indexOf('<dd', dtMatch.index)
    if (ddStart < 0) continue
    const ddEnd = block.indexOf('</dd>', ddStart)
    const ddHtml = block.slice(ddStart, ddEnd >= 0 ? ddEnd : block.length)

    const items: CalendarDay['items'] = dayMap.get(id) ?? []
    const liRe = /<li[^>]*background:[^"]*url\(['"]?([^'")]+)['"]?\)[^>]*>([\s\S]*?)<\/li>/g
    let li: RegExpExecArray | null
    while ((li = liRe.exec(ddHtml)) !== null) {
      const cover = li[1] ? originalImage(li[1]) : ''
      const inner = li[2]
      const idMatch = /\/subject\/(\d+)/.exec(inner)
      if (!idMatch) continue
      // 两个 p：中文名 / 原名（原名可能不存在）
      const pRe = /<p>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/p>/g
      const names: string[] = []
      let p: RegExpExecArray | null
      while ((p = pRe.exec(inner)) !== null && names.length < 2) {
        names.push(stripTags(p[1]))
      }
      const nameCn = names[0] ?? ''
      const name = names[1] && names[1] !== nameCn ? names[1] : nameCn
      items.push({
        id: Number(idMatch[1]),
        name,
        name_cn: nameCn,
        images: makeImages(cover),
        rating: null,
        air_date: null,
        genres: []
      })
    }
    dayMap.set(id, items)
  }

  // 页面顺序为 Sun, Mon, …, Sat；按 weekday.id 升序输出
  for (let id = 1; id <= 7; id++) {
    const items = dayMap.get(id)
    if (!items) continue
    days.push({
      weekday: { id, cn: DAY_CN[id], en: DAY_EN[id], ja: DAY_JA[id] },
      items
    })
  }
  return days
}

/** 解析 /subject/{id} 详情页 */
export function parseSubjectPage(html: string, id: number): SubjectDetail | null {
  if (html.indexOf('id="infobox"') < 0 && html.indexOf('nameSingle') < 0) return null

  // 标题：<h1 class="nameSingle"><a title="中文名">原名</a></h1>
  let name = ''
  let nameCn = ''
  const h1Match = /<h1 class="nameSingle">([\s\S]*?)<\/h1>/.exec(html)
  if (h1Match) {
    const aMatch = /<a[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(h1Match[1])
    if (aMatch) {
      nameCn = decodeEntities(aMatch[1]).trim()
      name = stripTags(aMatch[2])
    }
  }

  // 封面大图：<a class="thickbox cover" href="原图">，fallback img.cover
  let cover = ''
  const thickbox = /<a[^>]*class="[^"]*thickbox[^"]*"[^>]*href="([^"]+)"/.exec(html)
  if (thickbox) {
    cover = thickbox[1]
  } else {
    const img = /<img[^>]+src="([^"]+)"[^>]*class="[^"]*cover[^"]*"/.exec(html)
    if (img) cover = img[1]
  }

  // 评分：<span class="number" property="v:average">8.1</span>；人数 property="v:votes"
  const scoreMatch = /property="v:average">([\d.]+)</.exec(html)
  const votesMatch = /property="v:votes">(\d+)</.exec(html)
  const score = scoreMatch ? Number(scoreMatch[1]) : 0
  const total = votesMatch ? Number(votesMatch[1]) : 0
  const rankMatch = /Bangumi Anime Ranked:<\/small>\s*<small class="grey">#?(\d+)</.exec(html)

  // 标签：subject_tag_section 内 a.meta
  const tags: { name: string; count?: number }[] = []
  const tagSection = /class="subject_tag_section"([\s\S]*?)<\/div>/.exec(html)
  if (tagSection) {
    const tagRe = /href="\/anime\/tag\/[^"]*"[^>]*><span>([^<]+)<\/span>\s*<small class="grey">(\d+)<\/small>/g
    let t: RegExpExecArray | null
    while ((t = tagRe.exec(tagSection[1])) !== null) {
      tags.push({ name: stripTags(t[1]), count: Number(t[2]) })
    }
  }

  // 简介：<div id="subject_summary" ...>…</div>
  let summary = ''
  const sumMatch = /<div id="subject_summary"[^>]*>([\s\S]*?)<\/div>/.exec(html)
  if (sumMatch) {
    summary = stripTags(sumMatch[1], true)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
  }

  // infobox：<ul id="infobox"><li><span class="tip">键</span>值</li>…
  const infobox: { key: string; value: string }[] = []
  const boxMatch = /<ul id="infobox">([\s\S]*?)<\/ul>/.exec(html)
  if (boxMatch) {
    const rowRe = /<li[^>]*>\s*<span class="tip">([^<]+)<\/span>\s*([\s\S]*?)<\/li>/g
    let r: RegExpExecArray | null
    while ((r = rowRe.exec(boxMatch[1])) !== null) {
      const key = decodeEntities(r[1]).trim().replace(/:$/, '')
      const value = stripTags(r[2]).replace(/\s+/g, ' ').trim()
      if (key && value) infobox.push({ key, value })
    }
  }

  const airDateRow = infobox.find((x) => x.key === '放送开始')
  const epsRow = infobox.find((x) => x.key === '话数')
  const epsNum = epsRow ? parseInt(epsRow.value, 10) : NaN

  return {
    id,
    name: name || `#${id}`,
    name_cn: nameCn,
    summary,
    air_date: airDateRow?.value ?? null,
    images: makeImages(cover),
    rating: { score: score > 0 ? score : null, total, rank: rankMatch ? Number(rankMatch[1]) : undefined },
    tags,
    infobox,
    eps: Number.isNaN(epsNum) ? undefined : epsNum
  }
}

/** 解析 /subject_search/{kw}?cat=2 搜索结果页 */
export function parseSearchPage(html: string): SearchResultItem[] {
  const items: SearchResultItem[] = []
  const listStart = html.indexOf('id="browserItemList"')
  if (listStart < 0) return items
  const listEnd = html.indexOf('</ul>', listStart)
  const list = html.slice(listStart, listEnd >= 0 ? listEnd : html.length)

  const liRe = /<li[^>]*class="item[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = liRe.exec(list)) !== null) {
    const inner = m[1]
    const idMatch = /\/subject\/(\d+)/.exec(inner)
    if (!idMatch) continue
    const imgMatch = /<img[^>]+src="([^"]+)"/.exec(inner)
    // 标题：<a href="/subject/x" class="l">中文名</a> <small class="grey">原名</small>
    const titleMatch = /<a href="\/subject\/\d+" class="l">([\s\S]*?)<\/a>\s*(?:<small class="grey">([^<]*)<\/small>)?/.exec(inner)
    // 评分：rateInfo 区域中的数字（宽容匹配）
    const rateMatch = /(?:rateInfo|fade">)\s*([\d.]+)/.exec(inner)
    const infoMatch = /<p class="info tip">\s*([\s\S]*?)<\/p>/.exec(inner)
    const info = infoMatch ? stripTags(infoMatch[1]) : ''
    const dateMatch = info.match(/(\d{4}年\d{1,2}月\d{1,2}日)/)
    const nameCn = titleMatch ? stripTags(titleMatch[1]) : ''
    const name = titleMatch?.[2] ? stripTags(titleMatch[2]) : nameCn
    items.push({
      id: Number(idMatch[1]),
      name,
      name_cn: nameCn,
      images: imgMatch ? makeImages(imgMatch[1]) : null,
      rating: rateMatch ? { score: Number(rateMatch[1]) || null, total: 0 } : null,
      air_date: dateMatch ? dateMatch[1].replace(/年|月/g, '-').replace(/日$/, '') : null,
      summary: info
    })
  }
  return items
}

/** 从详情页 HTML 中仅提取评分（用于日历卡片评分补全） */
export function parseRatingOnly(html: string): { score: number | null; total: number } {
  const scoreMatch = /property="v:average">([\d.]+)</.exec(html)
  const votesMatch = /property="v:votes">(\d+)</.exec(html)
  const score = scoreMatch ? Number(scoreMatch[1]) : 0
  return { score: score > 0 ? score : null, total: votesMatch ? Number(votesMatch[1]) : 0 }
}
