import { app } from 'electron'
import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 数据根目录（v0.2.9 最后更新，用户要求）。
 *
 * 用户原话：**所有缓存都和应用在同一个安装地址中**，可在安装地址中创建缓存文件夹
 * （番剧封面/信息、galgame 封面/信息等），**只有必需在 C 盘加载的文件才留在 C 盘**，
 * 最大限度减少 C 盘占用；番剧默认下载目录与截图默认目录也在安装目录下。
 *
 * 实现方式：把 Electron 的 `userData` / `sessionData` / `crashDumps` 全部重定向到
 * `<安装目录>/data/userData`。这样**所有**原本落在 `%APPDATA%\sakana` 的东西
 * （设置、日志、图片缓存、弹幕缓存、Chromium 自带的 Cache/GPUCache/Local Storage…）
 * 一次性跟着搬过来，不需要逐个文件去改路径 —— 漏改一个就会出现「一半在 C 盘」的割裂状态。
 *
 * 目录布局（安装目录下）：
 * ```
 * <安装目录>/
 * ├── data/
 * │   ├── userData/     Electron 的 userData（设置 store、日志、Chromium 缓存、tmp/…）
 * │   └── updates/      应用内更新下载的安装包（就地存放，装完即删）
 * ├── cache/            业务缓存（图片 / 番剧条目 / galgame 封面）
 * ├── downloads/        番剧默认下载目录
 * ├── screenshots/      番剧截图默认目录
 * └── galgame-screenshots/  galgame 截图默认目录
 * ```
 * 仍然留在 C 盘的只有 Windows 强制的位置：系统临时目录（`%TEMP%`，Chromium/安装器自用）
 * 以及下面「安装目录不可写」时的兜底目录。
 *
 * 开发态（`npm run dev`）同样走这套规则，根目录 = 仓库目录 —— 这样「开发时看到的路径」
 * 与「装完之后看到的路径」始终是同一个相对结构，排查路径问题不会出现两套事实。
 */

export interface DataPaths {
  /** 数据根：安装目录（不可写时回退到 %LOCALAPPDATA%） */
  root: string
  /** Electron userData（设置/日志/Chromium 缓存/tmp） */
  userData: string
  /** 业务缓存根（图片、番剧条目、galgame 封面） */
  cache: string
  /** 番剧默认下载目录 */
  downloads: string
  /** 番剧截图默认目录 */
  screenshots: string
  /** galgame 截图默认目录 */
  galgameShots: string
  /** 应用内更新：安装包下载目录 */
  updates: string
  /** 是否因为安装目录不可写而回退（true 时说明用户装到了 Program Files 之类的只读位置） */
  fallback: boolean
}

let cachedPaths: DataPaths | null = null

/** 安装目录：打包后是可执行文件所在目录，开发态是仓库根目录 */
export function installDir(): string {
  if (!app.isPackaged) return app.getAppPath()
  return dirname(app.getPath('exe'))
}

/** 目录可写探测：能创建并写入探测文件才算可用（只读介质/Program Files 会失败） */
function writable(dir: string): boolean {
  const probe = join(dir, `.sakana-write-test-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 计算数据目录（只算一次；应用启动早期调用，之后各处直接复用） */
export function dataPaths(): DataPaths {
  if (cachedPaths) return cachedPaths
  const install = installDir()
  let root = install
  let fallback = false
  if (!writable(install)) {
    // 安装目录不可写（例如用户把它装进了 Program Files）：
    // 退到 Local（不是 Roaming）—— 用户反馈的问题正是 Roaming 里的旧数据作怪。
    // Electron 的 getPath 没有 localAppData 这个键，只能读环境变量（Windows 上一定有）。
    const local = process.env.LOCALAPPDATA || app.getPath('appData')
    root = join(local, 'Sakana')
    fallback = true
  }
  const userData = join(root, 'data', 'userData')
  cachedPaths = {
    root,
    userData,
    cache: join(root, 'cache'),
    downloads: join(root, 'downloads'),
    screenshots: join(root, 'screenshots'),
    galgameShots: join(root, 'galgame-screenshots'),
    updates: join(root, 'data', 'updates'),
    fallback
  }
  return cachedPaths
}

/**
 * 应用 `userData` 重定向。**必须在 app ready 之前调用**：
 * 单实例锁文件、store、日志、Chromium 的整个 profile 都挂在 userData 上，
 * ready 之后再改就会出现「一半写到旧位置」的诡异状态。
 */
export function applyDataRoot(): void {
  const p = dataPaths()
  for (const dir of [p.userData, p.cache, p.downloads, p.screenshots, p.galgameShots, p.updates]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 目录不可建时下面各处会各自报错，这里不致命 */
    }
  }
  try {
    app.setPath('userData', p.userData)
    // Electron ≥ 28 起 sessionData 与 userData 分离；不显式设置的话 Chromium 的
    // 网络/缓存 profile 仍会留在 C 盘的默认位置 —— 那正是用户要避免的。
    app.setPath('sessionData', p.userData)
    app.setPath('crashDumps', join(p.root, 'data', 'crash-dumps'))
  } catch {
    /* 某些平台/时机不允许时忽略：退化为 electron 默认位置 */
  }
  if (p.fallback) {
    console.warn(
      `[paths] 安装目录不可写，数据改存到 ${p.root}（如需把缓存放在安装目录，请把应用安装到用户可写的位置）`
    )
  }
}

/** 给界面/日志用的一行说明：数据实际存放在哪 */
export function dataRootLabel(): string {
  const p = dataPaths()
  return p.fallback ? `${p.root}（安装目录不可写，已回退）` : p.root
}
