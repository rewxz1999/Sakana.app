/**
 * 「选择数据源-选集界面」的失败原因归类（v0.3.9）。
 *
 * ## 为什么要在渲染层做这件事
 *
 * 主进程 `rules.ts` 的搜索/选集结果只带一个 `error` 字符串，而且大半是 axios 的原始
 * message。界面过去就把它整句贴出来（实测长这样）：
 *
 *   「搜索失败 (aafun): timeout of 30000ms exceeded」
 *   「选集解析失败 (AGE): getaddrinfo ENOTFOUND www.agedm.io」
 *
 * 用户看到这种话得不到任何结论。而这四类失败**用户该做的事完全不同**：
 *   · 验证墙 → 点「去验证」在应用内过一遍人机验证，之后这条线路就能用；
 *   · 超时   → 稍后重试；
 *   · 连不上 → 这条线路当前不可达（被墙 / 站点挂了），换线路；
 *   · 没结果 → 这条线路里确实没有这部番，换个源或改关键词。
 *
 * 所以这里把它们归一成「一句话结论 + 一句建议」，**原始 message 仍然原样保留**并
 * 展示在下面（不吞错误 —— 用户反馈时贴给我们的就是这一行，日志里也是它）。
 *
 * ## 判据为什么和主进程「重复」了一遍
 *
 * 主进程那边判的是 **HTTP 200 的软拦截**（`rules.ts` 的 `looksLikeVerificationWall`，
 * 读的是响应正文）；这里判的是**已经冒泡上来的错误文本**（axios 抛的错、或主进程
 * 归一化后的 `VERIFY_WALL_MESSAGE`）。两者输入不同，没法共用一份实现；
 * 关键词刻意取同一批，保证「主进程说是验证墙」和「界面说是验证墙」不会打架。
 */

export type SourceFailureKind = 'verify' | 'timeout' | 'unreachable' | 'blocked' | 'empty' | 'other'

export interface SourceFailure {
  kind: SourceFailureKind
  /** 大字：一句话结论，用户扫一眼就知道发生了什么 */
  label: string
  /** 灰字：下一步该做什么 */
  hint: string
  /** 主进程给的原始文本（原样展示，便于用户反馈与对照日志）；空串表示"没有报错，就是没结果" */
  raw: string
}

/** 这条消息是不是「站点要我们先过验证」 */
export function isVerifyWall(message: string): boolean {
  return /人机验证|安全验证|身份验证|请完成验证|访问验证|验证码|403|forbidden|Just a moment|Checking your browser|cf-browser-verification/i.test(
    String(message ?? '')
  )
}

/** 失败发生在哪一步（措辞要跟着步骤走，不然「搜索超时」和「取集超时」看着像同一件事） */
export type SourceStage = 'search' | 'episodes' | 'play'

const STAGE_VERB: Record<SourceStage, string> = {
  search: '搜索这条线路',
  episodes: '解析这条线路的剧集',
  play: '解析这一集的播放地址'
}

/**
 * 把主进程的错误文本归类。
 *
 * `raw` 为空串是**合法输入**：那表示「请求成功、但一条结果都没有」——
 * 这不是错误，而是「这条线路里没有这部番」，用户该做的是换源而不是重试。
 */
export function classifySourceFailure(raw: string, stage: SourceStage): SourceFailure {
  const text = String(raw ?? '').trim()
  const verb = STAGE_VERB[stage]

  if (!text) {
    return {
      kind: 'empty',
      label: stage === 'search' ? '这条线路里没有搜到这部番' : '这条线路里没有可用的剧集',
      hint:
        stage === 'search'
          ? '换个播放源，或在下面手动改关键词（日文原名 / 别名 / 去掉季数后缀）重试'
          : '换个播放源或换一个搜索结果试试',
      raw: ''
    }
  }

  if (isVerifyWall(text)) {
    return {
      kind: 'verify',
      label: '这条线路需要人机验证',
      hint: '点下面的「去验证」，在应用内过一遍验证；验证状态会记住，之后这条线路可以正常搜索与播放',
      raw: text
    }
  }

  if (/timeout|timed? ?out|超时|ETIMEDOUT|ECONNABORTED|headers timeout|body timeout/i.test(text)) {
    return {
      kind: 'timeout',
      label: `${verb}超时`,
      hint: '站点在超时时间内没有回应，稍后重试；一直如此就换一条线路',
      raw: text
    }
  }

  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPROTO|socket hang up|getaddrinfo|Network Error|ERR_|net::|certificate/i.test(
      text
    )
  ) {
    return {
      kind: 'unreachable',
      label: `连不上这条线路的站点`,
      hint: '域名解析不了或连接被中断（站点可能已失效、或当前网络到不了），换一条线路',
      raw: text
    }
  }

  if (/\b(4\d\d|5\d\d)\b|429|Too Many Requests|Service Unavailable/i.test(text)) {
    return {
      kind: 'blocked',
      label: '站点拒绝了这次请求',
      hint: '站点返回了 4xx/5xx（可能限流或反爬），稍后重试或换一条线路',
      raw: text
    }
  }

  return {
    kind: 'other',
    label: `${verb}失败`,
    hint: '换一条线路再试；如果每条线路都这样，把下面这行原始错误反馈给我们',
    raw: text
  }
}
