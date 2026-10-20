import type { PlayRule } from './types'
import ageRaw from '../../resources/rules/age.json'
import soraniRaw from '../../resources/rules/sorani.json'
import aafunRaw from '../../resources/rules/aafun.json'
import ezdmwRaw from '../../resources/rules/ezdmw.json'
import aniwatchRaw from '../../resources/rules/aniwatch.json'

/**
 * 内置规则（AGE / sorani / aafun）—— **随应用分发**，不是"首次启动去 git 拉"。
 *
 * 存放位置：仓库 `resources/rules/*.json`。为什么用 JSON 文件而不是像以前那样写死在 TS 里：
 *  1. 用户明确要求「这三条一定要内置到应用中」，把规则放在 `resources/rules` 下，
 *     谁都能一眼看到"应用里到底带了哪几条规则、内容是什么"，不用翻两千行的 types.ts；
 *  2. 规则本体是**数据**而不是逻辑（一堆 XPath / JSONPath 字符串），
 *     以后想加内置规则只需丢一个 json 进去，不必改代码。
 *
 * 为什么这里用 `import`（构建期打包）而不是运行时读 `<安装目录>/resources/rules`：
 *  electron-builder 的 extraResources 是把 `resources/xxx` 按**条目逐个**拷到安装目录的
 *  （见 package.json），运行时读文件就依赖"打包配置里别漏了这一条"，
 *  一旦漏了，用户装完就没有内置规则 —— 而内置规则缺失是"打开就没有规则可用"级别的故障。
 *  用 import 则规则被编进 app.asar，开发态与打包态**走的是同一份内容**，不存在漏拷贝这种失败模式。
 *  JSON 里 `_` 开头的字段（`_note`）是写给维护者看的说明，这里会被剥掉，不会进 store。
 */
function stripNotes(raw: unknown): PlayRule {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out as unknown as PlayRule
}

/**
 * 内置规则清单：这个数组只决定**存储顺序**（ensureDefaultRules 的合并顺序）。
 * 界面/嗅探顺序不再看这里 —— 用户要求去掉"置顶三条"后，一律按 `speedMs` 实测排序
 * （见 types.ts 的 sortRulesBySpeed 与 RULE_SPEED_MS）。
 *
 * `id` 统一强制为 `default-<小写名>`：ensureDefaultRules() 靠这个前缀区分
 * 「内置/应用托管的规则」与「用户自己的规则」，不能依赖 JSON 文件里写对。
 * `enabled: true`（用户要求内置规则开箱即用）、`createdAt: 0`（内置不算"创建时间"，
 * 也让排序不会因为安装时间不同而变化）。
 */
/**
 * Tucao（吐槽弹幕网）—— 内置第 4 条，排在 AGE / sorani / aafun 之后。
 *
 * 为什么它必须内置、而不是让用户导入：
 *   · 它用的是**新加的引擎能力** `episodesSplit` / `episodesField`（把 `ul#player_code` 里
 *     那一整串 `type=video&file=<mp4>|01**type=video&file=<mp4>|02` 切成多集），
 *     这种"整段文本拼集数"的老 PHP 站以后还会遇到，内置一条等于给引擎能力做了活样例；
 *   · 站点结构是我实测过的（搜索服务端渲染、播放页直链 MP4、弹幕走 DPlayer 协议），
 *     不需要用户自己填 XPath。
 *
 * 注意：搜索 URL 必须写**绝对地址** —— 引擎不会把 baseUrl 和相对路径拼起来，
 * 写成 `index.php?...` 会直接报 `Invalid URL`（这是一次真实踩坑）。
 */
const tucaoRaw = {
  id: 'default-tucao',
  name: 'Tucao',
  /*
   * ⚠️ 改了内置规则的**内容**就要升版本号。
   * `ensureDefaultRules()` 只在版本变化时才用新定义覆盖 store 里已有的那条；
   * 我这一轮改了搜索 XPath（从猜的 `//div[contains(@class,"search")]//li`
   * 换成实测的 `//div[@class="list"]/div[@class="item"]`），但版本仍是 1.0，
   * 于是应用里跑的还是**旧的错误 XPath** —— 表现为"HTTP 拿到了 HTML 却 0 条"。
   */
  version: '1.1',
  baseUrl: 'https://www.tucao.my/',
  search: {
    type: 'xpath',
    method: 'GET',
    url: 'https://www.tucao.my/index.php?m=content&c=search&a=init&dosubmit=1&k=@keyword',
    /*
     * 带上浏览器头：Tucao 对"裸请求"的响应很差（实测 curl 多次 0 字节、应用里 20 秒超时）。
     * Referer 指向站内搜索页更符合它的正常访问路径。
     */
    headers: JSON.stringify({
      Referer: 'https://www.tucao.my/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }),
    query: '{}',
    bodyType: '',
    /*
     * 结果结构（实测抓下来的真实 HTML）：
     *   <div class="list">
     *     <div class="item"><div class="b">
     *       <a href="/play/h4107864/" class="p vp">封面</a>
     *       <a href="/play/h4107864/" class="t">【10月】脑洞学生会/学生会也有洞！【ANi】</a>
     * 取 `.b` 作为每个条目的容器、里面的 `a.t` 作为标题/链接 —— 实测在这个站的解析树上，
     * 从 `<body` 起解析时 `//a[@class="t"]` 能命中、而 `//div[@class="list"]/div[@class="item"]`
     * 命中 0（它的 HTML 头部会让解析器建出空树，见 rules.ts 的 toDoc 兜底）。
     */
    listXPath: '//div[@class="b"]',
    itemNameXPath: './/a[@class="t"]',
    itemLinkXPath: './/a[@class="t"]',
    listJsonPath: '',
    itemNameJsonPath: '',
    itemSourceJsonPath: '',
    /*
     * Tucao 会按"有没有浏览器会话"分流：裸请求拿到的是 15KB 残缺页（连 class="list" 都没有），
     * 真实浏览器会话拿到的是 32KB 结果页。所以搜索这一步走 Chromium 网络栈（会保存 Cookie）。
     */
    useChromium: true
  },
  episodes: {
    type: 'xpath',
    method: 'GET',
    /*
     * XPath 型集数**不用这个字段**：引擎会用 `entry.link` 拼 baseUrl 去抓播放页。
     * 一开始我在这里写了 `@link`，结果日志里出现 `Request failed with status code 404`
     * （它被当成真实地址去请求了）。留空即可。
     */
    url: '',
    headers: '{}',
    query: '{}',
    bodyType: '',
    useChromium: true,
    responseFormat: '',
    linesXPath: '',
    episodesXPath: '//ul[@id="player_code"]/li',
    episodesSplit: '**',
    episodesField: 'file'
  },
  play: { type: 'direct', urlTemplate: '@episodeUrl', headers: '{}' }
}

/**
 * 实测的「决定性耗时」（毫秒）—— 点播放 → 资源地址可交给播放器。
 *
 * 为什么放在 shared 而不是数据库里：它是**排序键**，规则管理页、播放源弹窗、
 * 预嗅探、投屏四处都要读同一个值；而规则数据在用户机器上会被仓库更新覆盖，
 * 代码常量才是"我们实测过的那一份"。rules.ts 的 `migrateRuleLibrary()` 会把它
 * 写进每条规则（`speedMs`），仓库导入/内置刷新之后也不会丢。
 *
 * 测量口径与结果（2026-10-20，`.e2e/rule-speed.mjs`，每段 3 次取中位数；
 * 用《败犬女主太多了》实测，避免不同番剧的选集数差异影响耗时）：
 *   moonci 699 / mgnacg 694 / aafun 689 / mutefun 822 / sorani 921 / baimao 924 /
 *   AGE 965 / MXdm 1345 / ezdmw 1385 / Tucao 16393 / akianime 37311
 * ⚠️ 口径说明：xpath 规则在真机上"拿流"那一步是窗口嗅探，HTTP 层只能测到
 * 「选集页 + 播放页」为止；AGE/sorani/aafun 的真实耗时还要再加嗅探（几秒），
 * ezdmw 的播放页只要再取一层 player iframe 就能拿到 <video src>，所以它的 1.4s 更接近真机值。
 * 没测过的规则不填（排序时排最后），宁可不猜也不虚标。
 */
export const RULE_SPEED_MS: Record<string, number> = {
  'repo-moonci': 699,
  'repo-mgnacg': 694,
  'default-aafun': 689,
  'repo-mutefun': 822,
  'default-sorani': 921,
  'repo-baimao': 924,
  'default-age': 965,
  'repo-mxdm': 1345,
  'repo-ezdmw': 1385,
  'default-tucao': 16393,
  'repo-akianime': 37311
}

/**
 * 规则库整理版本（用户要求：本地库去重、删巴哈姆特、合并同 ruleId 的旧版）。
 *
 * 为什么用"启动迁移"而不是让维护者手工改 JSON：
 *   · 规则数据在 `<安装目录>/data/userData/data/`，不在构建产物里，改代码不会自动生效；
 *   · 迁移是**幂等**的（版本号 + 内容哈希），老用户升级后也能自动被整理一遍。
 * 递增这个数字会让 rules.ts 再跑一次清理（见 migrateRuleLibrary）。
 */
export const RULE_LIBRARY_REVISION = 2

/** 这次整理要**删除**的规则 id（一次性） */
export const REMOVED_RULE_IDS = [
  /** 巴哈姆特：用户原话「巴哈姆特用于弹幕源就够了」—— 播放规则删掉，弹幕模块不受影响 */
  'local-bahamut',
  /** 重复的 sorani：与内置 default-sorani 同站同名同版本，两条会让搜索结果出现两份 */
  'repo-sorani'
]

/**
 * 新增/替换的两条规则（一次性 upsert，之后归用户/仓库管理）。
 * 定义本体在 `resources/rules/*.json`，与内置规则同一套存放约定：
 * 谁都能一眼看到"应用里带了什么规则"，改规则不必翻代码。
 */
export const RULE_LIBRARY_SEEDS: PlayRule[] = [
  { ...stripNotes(ezdmwRaw), id: 'repo-ezdmw', origin: 'repo' },
  { ...stripNotes(aniwatchRaw), id: 'local-aniwatch', origin: 'local' }
]

/**
 * 四部番逐条实测后判「暂不可用」的规则（一次性停用 + 写明原因）。
 *
 * 判定口径（用户要求）：四部番**都**搜不到 / 播不出才停用，一部能用就保留。
 * 数据来自 `.e2e/rule-matrix.mjs` 的多轮复核（首轮 + 串行慢速复核，取最好的一次），
 * 报告在本地库/状态表里；「需人机验证」的（樱之空）不在此列 —— 用户过一次验证还能用。
 */
export const RETIRED_RULES: Record<string, string> = {
  'default-tvtfun': '暂不可用：四部番均搜索不到条目（站点的 /api/videos/search 已不返回结果）',
  'repo-dm84': '暂不可用：四部番均搜索不到条目（站点可能已改版或停止服务）',
  'repo-gugu3': '暂不可用：四部番均搜索不到条目（站点可能已改版或停止服务）',
  'repo-xfdmneo': '暂不可用：四部番均搜索不到条目（站点可能已改版或停止服务）',
  'repo-girigirilove': '暂不可用：搜索有结果，但详情页返回 404（站点详情页地址已变），四部番都解析不出剧集',
  'repo-lmm': '暂不可用：搜索有结果，但详情页返回 404（站点详情页地址已变），四部番都解析不出剧集',
  'repo-dalvdm': '暂不可用：搜索有结果，但详情页返回 404（站点详情页地址已变），四部番都解析不出剧集',
  'repo-xfdmnext': '暂不可用：选集接口返回 401（需要登录/授权），四部番都拿不到剧集',
  'local-aniwatch':
    '暂不可用：搜索/选集接口可用（站内没有《CLANNAD》），但播放页要求先过 Cloudflare 人机验证，' +
    '四部番都拿不到画面。等站点放开验证或引擎能自动过 Turnstile 后再启用。'
}

/** 不能停用、但需要如实告知限制的规则（樱之空：验证墙，用户过一次就能用） */
export const RULE_NOTES: Record<string, string> = {
  'default-skrsks': '需人机验证：站点对裸请求返回验证页，在播放源列表里点这条线路过一次验证即可用'
}

export const BUILTIN_RULES: PlayRule[] = [
  stripNotes(ageRaw),
  stripNotes(soraniRaw),
  stripNotes(aafunRaw),
  stripNotes(tucaoRaw)
].map(
  (r) => ({
    ...r,
    id: `default-${String(r.name).toLowerCase()}`,
    enabled: true,
    createdAt: 0,
    origin: 'builtin' as const,
    /** 内置规则也带测速值：界面/嗅探排序不区分"内置"还是"仓库"，只认实测 */
    speedMs: RULE_SPEED_MS[`default-${String(r.name).toLowerCase()}`]
  })
)
