import type { PlayRule } from './types'

/**
 * 巴哈姆特动画疯的「库驱动」规则定义（v1.1）。
 *
 * ## 为什么它不是一条 XPath 规则
 *
 * 用户要求「巴哈姆特规则用 npm 包 `bahamut-anime`」。这个包（v1.2.0）的实际内容
 * （见 `node_modules/bahamut-anime/lib/index.d.ts`）只有四个只读接口：
 *   · `v1/search.php?kw=`            搜索（返回 anime_sn / title）
 *   · `v3/video.php?anime_sn=`       番剧详情（返回 volumes["0".."3"]，每卷只给 video_sn）
 *   · `v3/video.php?sn=`             单集详情（视频元数据）
 *   · `v3/token.php?sn=`             弹幕与广告清单
 * **没有任何一个接口返回视频流地址**：真正播放走的是站点自己的播放器
 * （`ani.gamer.com.tw` 页面里再取 `/ajax/m3u8.php`），那一步不在这个包里。
 *
 * 所以这条规则的两段能力是分开的、也必须分开告诉用户：
 *   ① 搜索 / 选集：由 `bahamut-anime`（或同一批公开接口）给出，能拿到；
 *   ② 播放地址：只能给出**官方观看页地址**，能否出流取决于站点播放器与本机网络
 *     （站点对非台湾 IP 直接拒绝），我们只能靠通用嗅探去试着接。
 * 这条限制写在 `playbackNote` 里，界面原样显示 —— 不给"点了没反应"的按钮。
 *
 * ## 为什么 id 不是 `default-` 前缀
 *
 * `ensureDefaultRules()` 每次启动都会把 `default-` 前缀的规则**强制启用**并整体覆盖。
 * 巴哈姆特是"可选线路"，用户要求它**能被启用/停用**，因此它用普通 id，
 * 只在首次启动时播种一次，之后的启用状态由用户自己决定（见 rules.ts 的 seed）。
 */
export const BAHAMUT_RULE_ID = 'local-bahamut'

/** 界面/日志里统一的一句话限制说明（不要在多处各写一份） */
export const BAHAMUT_PLAYBACK_NOTE =
  '巴哈姆特只能提供条目与选集：视频直链不在 bahamut-anime 包内，播放要靠官方观看页的网页播放器，且站点只对台湾网络开放'

/**
 * 空壳的 XPath/JSONPath 定义。
 *
 * 不是"没填完"，而是**这条规则不使用它们**：engine='bahamut' 时执行分支根本不会读
 * （见 rules.ts 的三个 `if (rule.engine === 'bahamut')` 提前返回）。
 * 仍然给全字段，是因为 PlayRule 的类型要求它们存在、且规则管理页的编辑器会渲染这些字段；
 * 让它们保持空串比塞一段假的 XPath 更诚实。
 */
export function bahamutRule(): PlayRule {
  return {
    id: BAHAMUT_RULE_ID,
    name: '巴哈姆特',
    version: '1.0',
    baseUrl: 'https://ani.gamer.com.tw/',
    engine: 'bahamut',
    playbackNote: BAHAMUT_PLAYBACK_NOTE,
    search: {
      type: 'api',
      method: 'GET',
      url: 'https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=@keyword',
      headers: '{}',
      query: '{}',
      bodyType: '',
      listXPath: '',
      itemNameXPath: '',
      itemLinkXPath: '',
      listJsonPath: '',
      itemNameJsonPath: '',
      itemSourceJsonPath: ''
    },
    episodes: {
      type: 'api',
      method: 'GET',
      url: 'https://api.gamer.com.tw/mobile_app/anime/v3/video.php?anime_sn=@source',
      headers: '{}',
      query: '{}',
      bodyType: '',
      responseFormat: '',
      linesXPath: '',
      episodesXPath: '',
      linesJsonPath: '',
      lineNameJsonPath: '',
      episodesJsonPath: '',
      episodeNameJsonPath: '',
      vars: {},
      playUrlTemplate: '',
      playQuery: {}
    },
    enabled: true,
    createdAt: 0,
    origin: 'builtin'
  }
}
