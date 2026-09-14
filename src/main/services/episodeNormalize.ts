import type { RuleEpisode, RuleEpisodeGroup } from '@shared/types'
import { log } from '../log'

/**
 * 剧集线路规范化（v0.2.4）。
 *
 * 规则站点的选集结构五花八门，实测会出现两类「能用但很难用」的结果：
 *
 * 1. **线路名是整串集名**：线路标题取到了容器文本，变成「第01集第02集第03集…」。
 *    这里判定为拼接标题后统一改名成「线路 N」（不重新跑规则，纯本地改名）。
 *
 * 2. **多条线路的剧集被塞进同一个列表**：整页只解析出一个线路，
 *    集数是「第01集…第12集、第01集…第12集…」——编号重新开始的地方就是下一条线路。
 *    这里按「编号重启」切分成多条线路。
 *
 * 只有高置信度才动手，拿不准就原样返回（宁可名字丑，也不能把正确的列表切坏）。
 */

/** 从名字里抽出所有「集数」数字：支持「第3集」「第 12 话」「EP03」「03」「3.5」 */
function episodesInName(name: string): number[] {
  const out: number[] = []
  const re = /第\s*(\d{1,4})(?:\.5)?\s*[话話集回]|[Ee][Pp]?\s*(\d{1,4})|(?<![\d.])(\d{1,4})(?:\.5)?(?![\d.])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(name)) !== null) {
    const n = Number.parseInt(m[1] ?? m[2] ?? m[3] ?? '', 10)
    if (Number.isFinite(n) && n > 0 && n < 2000) out.push(n)
  }
  return out
}

/** 名字是不是「多集标题粘在一起」 */
function looksLikeConcatenatedName(name: string): boolean {
  const n = episodesInName(name)
  if (n.length >= 3) return true
  // 没有任何数字但异常长（整段播放列表文本）也算拼接
  if (n.length === 0 && name.length >= 24) return true
  return n.length >= 2 && name.length >= 12
}

/** 集名里能不能稳定读出递增编号（用于判断「编号重启=新线路」） */
function numbering(episodes: RuleEpisode[]): number[] | null {
  const nums: number[] = []
  for (const e of episodes) {
    const list = episodesInName(e.name)
    // 集名里通常只有一个数字；多个数字时取最后一个（「第03集 1080P」这种取到 1080 的情况由 <2000 兜住）
    if (list.length === 0) return null
    nums.push(list[list.length - 1])
  }
  // 至少要有 4 集且出现过递增，才有资格谈「重启」
  let ups = 0
  for (let i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1]) ups++
  if (nums.length < 4 || ups < 2) return null
  return nums
}

/** 找出编号重启的位置（返回每段的起始下标） */
function splitPoints(nums: number[]): number[] {
  const starts = [0]
  for (let i = 1; i < nums.length; i++) {
    const prev = nums[i - 1]
    const cur = nums[i]
    // 重启特征：当前编号比上一集小（且回到开头附近），并且该段已经攒够 2 集
    if (cur <= prev && cur <= 3 && i - starts[starts.length - 1] >= 2) starts.push(i)
  }
  return starts
}

/** 单个线路内部的规范化（改名 + 拆分） */
function normalizeGroup(group: RuleEpisodeGroup, index: number): RuleEpisodeGroup[] {
  const name = (group.lineName ?? '').trim()
  const renameTo = `线路 ${index + 1}`

  // ① 线路名是整串集名 → 改名
  let lineName = name
  if (looksLikeConcatenatedName(name)) lineName = renameTo

  // ② 一个列表里塞了多条线路 → 按编号重启切分
  const nums = numbering(group.episodes)
  if (nums) {
    const starts = splitPoints(nums)
    if (starts.length >= 2) {
      const groups = starts.map((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : group.episodes.length
        return {
          lineName: `${renameTo}-${i + 1}`,
          episodes: group.episodes.slice(start, end)
        }
      })
      // 切出来的每一段至少要有 1 集，且总集数不能丢
      const total = groups.reduce((n, g) => n + g.episodes.length, 0)
      if (total === group.episodes.length && groups.every((g) => g.episodes.length > 0)) {
        log.append(
          'info',
          'rules',
          `线路规范化：检出同一列表内含 ${groups.length} 条线路（按集数编号重启切分），已改名 ${renameTo}-1…${groups.length}`
        )
        return groups
      }
    }
  }
  if (lineName !== name) {
    log.append('info', 'rules', `线路规范化：线路名疑似整串集名，已改名为「${lineName}」`)
  }
  return [{ lineName: lineName || renameTo, episodes: group.episodes }]
}

/** 对外入口：对规则返回的剧集分组做一次规范化（幂等） */
export function normalizeEpisodeGroups(groups: RuleEpisodeGroup[]): RuleEpisodeGroup[] {
  if (!groups.length) return groups
  const out: RuleEpisodeGroup[] = []
  groups.forEach((g, i) => out.push(...normalizeGroup(g, i)))
  // 名称为空或完全重名的线路统一编号，避免界面上出现多个一样的名字
  const names = out.map((g) => (g.lineName ?? '').trim())
  const dup = names.some((n, i) => !n || names.indexOf(n) !== i)
  if (dup) {
    return out.map((g, i) => ({ ...g, lineName: `线路 ${i + 1}` }))
  }
  return out
}
