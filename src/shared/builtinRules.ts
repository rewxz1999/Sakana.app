import type { PlayRule } from './types'
import ageRaw from '../../resources/rules/age.json'
import soraniRaw from '../../resources/rules/sorani.json'
import aafunRaw from '../../resources/rules/aafun.json'

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
 * 内置规则清单：顺序 = 列表里的展示顺序（置顶名单另有一份 `PINNED_RULES`，
 * 两处名单一致，所以这三条既排在最前面、也带着置顶标记）。
 *
 * `id` 统一强制为 `default-<小写名>`：ensureDefaultRules() 靠这个前缀区分
 * 「内置/应用托管的规则」与「用户自己的规则」，不能依赖 JSON 文件里写对。
 * `enabled: true`（用户要求内置规则开箱即用）、`createdAt: 0`（内置不算"创建时间"，
 * 也让排序不会因为安装时间不同而变化）。
 */
export const BUILTIN_RULES: PlayRule[] = [stripNotes(ageRaw), stripNotes(soraniRaw), stripNotes(aafunRaw)].map(
  (r) => ({
    ...r,
    id: `default-${String(r.name).toLowerCase()}`,
    enabled: true,
    createdAt: 0,
    origin: 'builtin' as const
  })
)
