import type { DanmakuFetcherId, DanmakuSource } from '@shared/types'
import { getSettings } from '../../net'
import { listSources } from '../danmakuSources'
import { bahamutFetcher } from './bahamut'
import { danmuboxFetcher } from './danmubox'
import { linkFetcher } from './link'
import type { DanmakuFetcher } from './types'

/**
 * 获取器注册表（V1.2）。
 *
 * 「弹幕源」在代码里就是这里的几个 fetcher：
 *   · 巴哈姆特动画疯（api）；
 *   · 弹幕盒子（site）；
 *   · 直链/模板（link，老能力，只有用户自己加了规则才参与）。
 *
 * ## 默认只启用巴哈姆特
 * 用户明确要求「默认巴哈姆特」。设置里 `danmaku.enabledSources` 默认 `['bahamut']`；
 * 这里把它翻译成可执行的 fetcher 列表。如果用户在高级规则表里给某个适配器配了**启用**的规则
 * （例如自建巴哈反代），就优先用那条规则的基址/关键词，不再重复跑默认配置。
 */

const REGISTRY: Record<DanmakuFetcherId, DanmakuFetcher> = {
  bahamut: bahamutFetcher,
  danmubox: danmuboxFetcher,
  link: linkFetcher
}

export function fetcherById(id: string): DanmakuFetcher | null {
  return REGISTRY[id as DanmakuFetcherId] ?? null
}

/** 一个可执行的「fetcher + 它的用户配置」 */
export interface EnabledFetcher {
  fetcher: DanmakuFetcher
  /** 用户配置（没有就是适配器默认值） */
  source?: DanmakuSource
  /** 缓存文件名与界面显示都用它（用户改过名就用用户的） */
  name: string
}

/** 取默认显示名（设置页的开关列表也用这个，避免两处各写一份） */
export function fetcherDisplayName(id: DanmakuFetcherId): string {
  return REGISTRY[id]?.name ?? id
}

/** 设置页「选择启用弹幕源」的两项（link 不在其中：它来自用户自己加的规则） */
export const DANMAKU_SOURCE_OPTIONS: { id: DanmakuFetcherId; name: string; desc: string }[] = [
  {
    id: 'bahamut',
    name: bahamutFetcher.name,
    desc: 'ani.gamer.com.tw：搜索 → 取集（本篇/剧场版/OVA/中配）→ 取弹幕。需要日文名/繁体名搜索（应用会自动取番剧原名）。默认启用。'
  },
  {
    id: 'danmubox',
    name: danmuboxFetcher.name,
    desc: 'danmubox.github.io：按番剧名检索加密静态索引 → 下载 7z → 解出 B 站 XML。以 2019–2021 存档为主，新番基本搜不到。'
  }
]

/**
 * 当前要跑的获取器（按优先级）。
 *
 * 顺序：用户显式配置并启用的规则（`sources`，按 priority）→ 设置里勾选的内置源（默认巴哈）。
 * 同一个适配器只要有启用规则就不再跑默认配置，避免对同一部番重复请求两次。
 */
export function enabledFetchers(): EnabledFetcher[] {
  const settings = getSettings()
  const enabledIds = settings.danmaku?.enabledSources ?? ['bahamut']
  const configured = listSources().filter((s) => s.enabled && fetcherById(s.adapter))
  const out: EnabledFetcher[] = []
  const seen = new Set<string>()

  for (const source of configured) {
    const fetcher = fetcherById(source.adapter)
    if (!fetcher) continue
    const key = `${fetcher.id}|${source.base ?? ''}|${source.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ fetcher, source, name: source.name?.trim() || fetcher.name })
  }

  for (const id of enabledIds) {
    if (id === 'link') continue
    const fetcher = REGISTRY[id]
    if (!fetcher) continue
    if (configured.some((s) => s.adapter === id)) continue
    const key = `${id}|`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ fetcher, name: fetcher.name })
  }

  return out
}
