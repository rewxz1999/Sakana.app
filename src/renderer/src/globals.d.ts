/**
 * 构建期注入的全局常量声明（v0.2.12）。
 *
 * `__SAKANA_AUTHOR__` 由 `electron.vite.config.ts` 在构建时通过 Vite 的 `define` 注入：
 * 值来自被 .gitignore 忽略的 `sakana.local.json`（用户要求作者名字不进 git 仓库），
 * 未配置时为空串。这里只是给 TypeScript 一个类型声明。
 */
declare const __SAKANA_AUTHOR__: string
