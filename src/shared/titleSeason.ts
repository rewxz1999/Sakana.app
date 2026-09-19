// 番剧标题解析：基名（base）/ 季数（season）/ 类型（kind）
//
// 为什么放在 shared：主进程的订阅更新检测（mikan.checkSub）要用它做过滤，渲染层以后要展示
// 「这条资源为什么没被算作订阅更新」也必须用同一份规则；两边各写一套必然漂移，
// 最后表现为「日志里说匹配到了、界面上却没有」，根本没法排查。
//
// 总体取舍一句话：**基名宁可算宽，季数不能算错**。
// 基名宽了还有调用方的「一方包含另一方」兜底（跨语言、带副标题、带字幕组前缀都能救回来），
// 季数错一格就是整条资源被静默丢掉。
//
// 实测依据：本文件的每条规则都对着 mikanani.kas.pub 的真实搜索结果调过，样本见
// .e2e/test-sub-match.js（该脚本把这份逻辑整份复制过去跑，因为脚本要在没有 TS 运行时的
// 情况下直接 node 执行）。

export type TitleKind = 'tv' | 'movie' | 'ova' | 'special' | 'unknown'

export interface TitleSeasonInfo {
  /** 归一化基名：去季数标记、去字幕组/技术标签、去标点空格、全角转半角、拉丁字母小写 */
  base: string
  /** 明确写出的季数；认不出就是 null（调用方按「第 1 季」处理） */
  season: number | null
  kind: TitleKind
}

// ---------------------------------------------------------------------------
// 归一化与数字
// ---------------------------------------------------------------------------

/**
 * 兼容折叠：全角 → 半角，并把兼容字符折成普通字符。
 *
 * NFKC 会顺手把「：」→「:」、「４」→「4」、「Ⅳ」→「IV」、半角片假名 → 全角片假名，
 * 于是后面所有正则只要认一种写法就够了，不用到处写 `[：:]`、`[0-9０-９]`、`[ⅣIViv]`。
 * 坑：NFKC 也会折掉「㈱」「①」这类字符，但番剧标题里基本不出现，可以接受。
 */
function fold(s: string): string {
  return String(s ?? '').normalize('NFKC')
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  貳: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9
}

/**
 * 中文数字 → 阿拉伯数字。
 *
 * 必须支持「一 ~ 十九」（用户明确要求），另外顺手支持到「九十九」。
 * 坑：番剧季数最大也就到十几，不需要处理「百/千」，所以这里刻意不实现 —— 少写一半代码，
 * 也避免把「第一百季」这种不存在的写法解析成一个离谱的数字。
 * 非中文数字串（例如「第X季」里的 X）一律返回 null，由调用方继续试别的规则。
 */
export function cnNumberToInt(s: string): number | null {
  const t = String(s ?? '')
  if (/^[0-9]+$/.test(t)) {
    const v = parseInt(t, 10)
    return Number.isNaN(v) ? null : v
  }
  if (!t) return null
  if (!/^[零一壹二两貳贰三叁四肆五伍六陆七柒八捌九玖十拾]+$/.test(t)) return null
  const ten = Math.max(t.indexOf('十'), t.indexOf('拾'))
  if (ten >= 0) {
    // 「十」=10、「十一」=11、「十九」=19、「二十」=20、「二十三」=23
    const head = t.slice(0, ten)
    const tail = t.slice(ten + 1)
    const h = head ? CN_DIGITS[head] : 1
    const r = tail ? CN_DIGITS[tail] : 0
    if (h == null || r == null) return null
    const v = h * 10 + r
    return v >= 1 && v <= 99 ? v : null
  }
  if (t.length === 1) return CN_DIGITS[t] ?? null
  // 「一二」这种连写没意义，拒绝
  return null
}

/** 罗马数字（只到 XX）。Ⅳ/Ⅴ 这类字符已被 NFKC 折成 IV/V。 */
const ROMAN: Record<string, number> = {
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20
}

export function romanToInt(s: string): number | null {
  return ROMAN[String(s ?? '').toUpperCase()] ?? null
}

// ---------------------------------------------------------------------------
// 季数
// ---------------------------------------------------------------------------

interface SeasonPattern {
  /** 正则源码。检测时直接用；剥离时加 g 标志整体替换掉 */
  src: string
  flags: string
  /** 从捕获组 1 取数字 */
  toNum: (token: string) => number | null
}

/** 数字写法：阿拉伯（1~2 位）或中文数字（一~十九） */
const NUM = '(?:[0-9]{1,2}|[零一壹二两貳贰三叁四肆五伍六陆七柒八捌九玖十拾]{1,3})'

/**
 * 「真·季标记」，按优先级从上到下，第一个命中的胜出。
 *
 * 为什么要分优先级而不是「谁在标题里靠前用谁」：
 * 《Re:Zero ... S04E17》里靠前的可能只是字幕组名、靠后的才是 `4th Season`；
 * 而《Season 4 Part 2》里两个标记都是季信息，语义上应当取 Season。
 */
const SEASON_MAIN: SeasonPattern[] = [
  // ① 最标准的中文/日文写法：第4季 / 第四季 / 第 4 期 / 第4クール / 第4シーズン
  //    坑：这里**绝不能**把「集/话/話」写进后缀 —— 那是集数不是季数。
  //    （现有 parseEpisode 的 EP_RE 正是靠「集/话/話」区分，所以「第4季」不会被误当成第 4 集。）
  { src: `第\\s*(${NUM})\\s*(?:季|期|クール|シーズン)`, flags: 'u', toNum: cnNumberToInt },
  // ② 省掉「第」的阿拉伯写法：4期 / 2季 / 4クール（压制组很爱这么写）
  //    坑①：中文数字省「第」一律不收 —— 「四季」是「四个季节」，《四季樱》这类标题会被误伤。
  //    坑②：(?<!\d) 防止把「2024季」这类年份切成「24季」。
  { src: `(?<!\\d)([0-9]{1,2})\\s*(?:季|期|クール)(?!\\d)`, flags: 'u', toNum: cnNumberToInt },
  // ③ Season 4 / Season04 / シーズン4（(?<![A-Za-z]) 防 Preseason 这类词）
  { src: `(?<![A-Za-z])(?:season|シーズン)\\s*0*([0-9]{1,2})(?!\\d)`, flags: 'iu', toNum: cnNumberToInt },
  // ④ 4th Season / 2nd season
  { src: `(?<!\\d)([0-9]{1,2})(?:st|nd|rd|th)\\s*(?:season|シーズン)`, flags: 'iu', toNum: cnNumberToInt },
  // ⑤ Season IV（罗马数字，NFKC 已把 Ⅳ 折成 IV）
  { src: `(?<![A-Za-z])(?:season|シーズン)\\s*([IVX]{2,4})(?![A-Za-z])`, flags: 'iu', toNum: romanToInt },
  // ⑥ 压制组缩写：S4 / S04 / S04E17
  //    坑：(?<![A-Za-z0-9]) 保证 S 是独立标记，否则 PS2、Aegisub 里的 S 也会被当季数。
  //    (?!\d) 让它能吃到 S04E17 的「04」而不会把后面的集数一起吞掉。
  { src: `(?<![A-Za-z0-9])S0?([0-9]{1,2})(?!\\d)`, flags: 'u', toNum: cnNumberToInt },
  // ⑦ 独立的罗马数字：Ⅱ Ⅲ Ⅳ（→ II/III/IV）
  //    只收 ≥2 个字母：单个 I / V / X 太容易撞车（VCB、AVC、MKV 里的 V，XviD 里的 X）。
  //    这条排在最后，因为它的误报概率是全部规则里最高的。
  { src: `(?<![A-Za-z])([IVX]{2,4})(?![A-Za-z])`, flags: 'u', toNum: romanToInt }
]

/**
 * 「部分」类标记，优先级低于 SEASON_MAIN。
 * 理由：《Season 4 Part 2》里的 Part 2 是「第 4 季的后半」，算成第 5 季会直接把
 * 订阅池打歪；只有当标题里**真的没有**季标记时，才把 Part N / 第 N 部当成季数。
 */
const SEASON_PART: SeasonPattern[] = [
  // ⑧ 第2部分 / 第2部：中文里「部分」等价于 Part
  { src: `第\\s*(${NUM})\\s*(?:部分|部)`, flags: 'u', toNum: cnNumberToInt },
  // ⑨ Part 2 / Part2 / PART 02
  { src: `(?<![A-Za-z])part\\s*0*([0-9]{1,2})(?!\\d)`, flags: 'iu', toNum: cnNumberToInt },
  // ⑩ Part II
  { src: `(?<![A-Za-z])part\\s*([IVX]{2,4})(?![A-Za-z])`, flags: 'iu', toNum: romanToInt }
]

/**
 * 「Final Season / 最终季」是个**弱标记**：它明说了「有季这个概念，但没写数字」。
 * 处理方式：季数返回 null（不猜数字），并且**跳过 Part 规则**。
 * 理由：《进击的巨人 The Final Season Part 2》里的 Part 2 指的是「最终季的第二部分」，
 * 按 Part 规则会算成第 2 季，比「算不出来」更糟；而 Mikan 上同一个字幕组会把
 * 《The Final Season》和《The Final Season Part 2》都这么写，两边都返回 null → 都按第 1 季
 * 比较，反而能正确匹配上（见 sameSeason 的 null→1 规则）。
 */
const FINAL_SEASON_RE = /(?:final\s*season|最終シーズン|最终季|最終季)/iu

function matchPattern(p: SeasonPattern, text: string): number | null {
  const m = text.match(new RegExp(p.src, p.flags))
  if (!m) return null
  return p.toNum(m[1] ?? '')
}

/**
 * 抽取季数。认不出返回 null（**不要**在这里兜底成 1，兜底是 sameSeason 的事，
 * 这样调用方还能知道「这条根本没写季数」）。
 */
export function parseSeason(title: string): number | null {
  const text = fold(title)
  if (FINAL_SEASON_RE.test(text)) return null
  for (const p of SEASON_MAIN) {
    const v = matchPattern(p, text)
    if (v != null && v >= 1 && v <= 99) return v
  }
  for (const p of SEASON_PART) {
    const v = matchPattern(p, text)
    if (v != null && v >= 1 && v <= 99) return v
  }
  return null
}

/** 把标题里所有季数/部分标记抹掉（用于生成基名） */
function stripSeasonMarks(text: string): string {
  let out = text
  for (const p of [...SEASON_MAIN, ...SEASON_PART]) {
    out = out.replace(new RegExp(p.src, p.flags + 'g'), ' ')
  }
  return out
}

// ---------------------------------------------------------------------------
// 类型（movie / ova / special / tv / unknown）
// ---------------------------------------------------------------------------

// 判别优先序：movie → ova → special → tv → unknown
//
// ① movie 放最前：`剧场总集篇`/`剧场版`/`Movie` 是最强的语义标记；
//    实测里 `[MOVIE Fin]`、`[剧场版]`、`剧场总集篇` 经常和 `SP`、`总集篇` 同时出现在一条标题里，
//    先判 movie 才不会把剧场版资源归到 special。
// ② 再判 ova：OVA/OAD/OAV/番外篇 —— 用户明确要求「番外篇」算 OVA。
// ③ 再判 special：特别篇/SP/特番/总集篇/Recap。`SP` 必须加字母边界，
//    否则《Sparks of Tomorrow》里的「Sp」会被当成特别篇（这条坑在 shared/subgroup.ts 的
//    注释里也踩过一次）。
// ④ 剩下能看出「这是剧集」的（写了季数、写了集数、带 TV 标记）→ tv。
// ⑤ 其余 → unknown（例如只有番剧名的条目、剧场版副标题）。
const MOVIE_RE =
  /(?:剧场总集篇|劇場総集編|剧场版|劇場版|映画|(?<![A-Za-z])the\s+movie(?![A-Za-z])|(?<![A-Za-z])movie(?![A-Za-z]))/iu
const OVA_RE = /(?:(?<![A-Za-z])(?:ova|oad|oav)(?![A-Za-z])|番外篇|番外)/iu
const SPECIAL_RE =
  /(?:(?<![A-Za-z])(?:sp|special|specials|recap)(?![A-Za-z])|特别篇|特別篇|特番|总集篇|總集篇)/iu
const TV_RE = /(?<![A-Za-z])tv(?![A-Za-z])/iu
/** 标题里像不像写着集数（第12话 / [12] / - 12 / EP12）。只用于 kind 判定，不参与集数解析 */
const EPISODE_LIKE_RE =
  /(?:第\s*\d{1,4}\s*[话話集]|(?<![A-Za-z])[Ee][Pp]?\s*\d{1,3}(?![0-9])|(?:^|[\s[【（(])0*\d{1,3}(?:\.5)?(?:[vV]\d)?(?:[\s\]】）)]|$))/u

export function detectKind(title: string): TitleKind {
  const text = fold(title)
  if (MOVIE_RE.test(text)) return 'movie'
  if (OVA_RE.test(text)) return 'ova'
  if (SPECIAL_RE.test(text)) return 'special'
  if (parseSeason(text) != null) return 'tv'
  if (EPISODE_LIKE_RE.test(text) || TV_RE.test(text)) return 'tv'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// 基名
// ---------------------------------------------------------------------------

/** 括号段是不是「技术标签」（分辨率/编码/音轨/语言/字幕/合集…） */
const TECH_LOOSE_RE =
  /(?:1080|720|2160|480|4k|8k|x26[45]|h\.?26[45]|hevc|avc|av1|vp9|10bit|8bit|hi10p|ma10p|yuv\d+|aac|flac|opus|mp3|ac3|eac3|dts|truehd|atmos|web-?dl|web-?rip|bdrip|bdbox|bdmv|bluray|blu-ray|veryslow|repack|简繁|简体|繁体|内封|内嵌|外挂|字幕|双语|多国|合集|特典|正片|修正|招募|招人)/i
/** 需要字母边界的短技术标签（不加边界会把 Bocchi 里的 chi、Global 里的… 之类切出来） */
const TECH_WORD_RE =
  /(?<![A-Za-z])(?:chs|cht|gb|big5|jpsc|jpn|jp|chi|eng|kor|sp|srt|ass|ssa|mkv|mp4|avi|m2ts|sub|subs|hd|fhd|uhd|rip|raw|raws|fin|end|v2|v3|tv|hdr|dolby|ost|op|ed|cd)(?![A-Za-z])/i
/** 假名（用于判断短括号段是不是日文番剧名） */
const KANA_RE = /[\u3040-\u30ff]/

/**
 * 只有「技术标签」和「短噪音标签」才从基名里丢掉。
 *
 * 这是本文件最容易写错的地方：把**番剧名**塞进方括号是 Mikan 上极常见的写法
 * （实测：[晚街与灯][Re：从零开始的异世界生活 第四季 / Re:Zero ...]、
 *  [千夏字幕组][孤独摇滚!_BOCCHI THE ROCK!][第01-12话]、
 *  [爱恋字幕社][7月新番][无职转生 第三季 …][Mushoku Tensei III …][11]…），
 * 一律「删掉所有 [] 段」会让这些标题的基名直接变成空串，整条资源永远匹配不上。
 */
function isTechSegment(seg: string): boolean {
  return TECH_LOOSE_RE.test(seg) || TECH_WORD_RE.test(seg)
}

/**
 * 短噪音段：字幕组名（[ANi] / [爱恋字幕社] / [7³ACG]）、[完] / [Fin] 之类。
 * 判据：≤8 字符 + 没有假名 + 没有「第」+ 没有「/」。
 * 之所以要求「没有假名」：[黒ネズミたち] 这种带假名的字幕组名会被保留（宁可留噪音，
 * 也不能把《ぼっち・ざ・ろっく！》这类全假名番剧名一起丢掉）。
 */
function isShortNoiseSegment(seg: string): boolean {
  const s = seg.trim()
  return s.length <= 8 && !KANA_RE.test(s) && !/[第/／]/.test(s)
}

interface Seg {
  text: string
  bracketed: boolean
}

/** 把标题切成括号段 / 非括号段（[] 【】 （） () 一视同仁） */
function splitSegments(text: string): Seg[] {
  const out: Seg[] = []
  const re = /[[【（(]([^\]】）)]*)[\]】）)]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bracketed: false })
    out.push({ text: m[1], bracketed: true })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ text: text.slice(last), bracketed: false })
  return out
}

/** 类型词：基名里不保留（订阅《剧场版 库特wafter》和资源《库特Wafter OVA》应当算同一个基名） */
const KIND_WORD_RE =
  /(?:剧场总集篇|劇場総集編|剧场版|劇場版|映画|(?<![A-Za-z])the\s*movie(?![A-Za-z])|(?<![A-Za-z])movie(?![A-Za-z])|(?<![A-Za-z])(?:ova|oad|oav)(?![A-Za-z])|(?<![A-Za-z])(?:sp|special|recap)(?![A-Za-z])|番外篇|番外|特别篇|特別篇|特番|总集篇|總集篇)/giu

/** 集数标记（含区间合集：第01-12话） */
const EPISODE_STRIP_RE =
  /(?:第\s*\d{1,4}\s*(?:[-~～]\s*\d{1,4})?\s*[话話集]|(?<![A-Za-z])[Ee][Pp]?\s*\d{1,3}(?![0-9])|[-–—]\s*\d{1,4}(?![0-9])|\d{1,4}\s*[-~～]\s*\d{1,4}(?![0-9])|(?<![A-Za-z0-9])[vV]\d(?![0-9]))/gu

/** 去季数/类型/集数标记 + 去标点空格 + 小写 */
function normalizeBase(text: string): string {
  const t = text
    .replace(KIND_WORD_RE, ' ')
    .replace(EPISODE_STRIP_RE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
  return t.toLowerCase()
}

function pickText(segs: Seg[], strict: boolean): string {
  return segs
    .filter((s) => {
      if (isTechSegment(s.text)) return false
      if (!strict) return true
      if (s.bracketed && isShortNoiseSegment(s.text)) return false
      return true
    })
    .map((s) => (s.bracketed ? ` ${s.text} ` : s.text))
    .join(' ')
}

/**
 * 生成基名。
 * @param title 原始标题（未折叠）
 */
function buildBase(title: string): string {
  const segs = splitSegments(stripSeasonMarks(fold(title)))
  let base = normalizeBase(pickText(segs, true))
  // 兜底：整条标题几乎都在括号里、且括号段都很短时，上面的激进规则会把名字也丢掉。
  // 这时退回宽松规则 —— 宁可留点噪音（调用方的包含关系能兜住），也不能让基名变成空串。
  if (base.length < 2) base = normalizeBase(pickText(segs, false))
  return base
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------

/** 解析一条资源/番剧标题 */
export function parseTitleSeason(title: string): TitleSeasonInfo {
  const text = fold(title)
  return {
    base: buildBase(title),
    season: parseSeason(text),
    kind: detectKind(text)
  }
}

/**
 * 是否同季。
 *
 * 规则（用户明确要求）：
 * - **没写季数就视为第 1 季**（null → 1），两边都按这个规则比较；
 *   所以《无职转生》（无季数）只和第 1 季的资源同季，第三季的资源会被判掉。
 * - movie / ova 没有「第几季」的概念：只要基名一致就算同季（基名由调用方先比较）。
 *
 * 已知边界：像 `[百冬练习组] Re:从零开始的异世界生活 - 83` 这种「不写季数但集数延续
 * 第 4 季」的写法，按本规则会被算成第 1 季从而判掉。这是「没写季数=第 1 季」这条规则的
 * 必然代价；如果以后不想这么严，改这里一行即可（checkSub 会把被判掉的条数写进日志）。
 */
export function sameSeason(
  subSeason: number | null,
  itemSeason: number | null,
  itemKind: TitleKind = 'unknown'
): boolean {
  if (itemKind === 'movie' || itemKind === 'ova') return true
  return (subSeason ?? 1) === (itemSeason ?? 1)
}

/** 基名比较：完全相等，或一方包含另一方且较短者 ≥ 4 个字符 */
export function sameBase(subBase: string, itemBase: string): boolean {
  if (!subBase || !itemBase) return false
  if (subBase === itemBase) return true
  const shorter = subBase.length <= itemBase.length ? subBase : itemBase
  // 短基名（如「AIR」「86」）靠包含关系匹配会把整个资源池搅乱，所以要求 ≥ 4 个字符；
  // 短名字仍然能靠上面的完全相等命中。
  if (shorter.length < 4) return false
  return itemBase.includes(subBase) || subBase.includes(itemBase)
}

/** 季数的中文展示（日志/界面都用它，避免各处自己拼） */
export function seasonLabel(season: number | null): string {
  return season == null ? '未标注季数（按第 1 季算）' : `第 ${season} 季`
}

/**
 * 从番剧名派生「用于 Mikan 搜索」的关键词：只去掉季数/类型标记，**保留标点与大小写形态**。
 *
 * 刻意不做成 parseTitleSeason().base：
 * base 会把标点空格全部删掉（`re从零开始的异世界生活`），那是给字符串比较用的，
 * 拿去当搜索词会严重降低 Mikan 的命中率（蜜柑的搜索对标点敏感，见 mikan.ts 的 keywordCandidates）。
 *
 * 这里做 NFKC 折叠是**故意的**：折叠出来的形态（全角「！」→「!」、全角「～」→「~」）
 * 与调用方保留的原始形态互为补充 —— 实测《孤独摇滚！》用全角与半角两个写法搜出来的结果
 * 几乎不重叠（全角 100 条里 0 条千夏字幕组，半角 47 条里 41 条是），叠加查询才捞得全。
 */
export function baseSearchKeyword(title: string): string {
  const t = stripSeasonMarks(fold(title))
    .replace(KIND_WORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—/|、,，]+$/g, '')
    .trim()
  return t
}
