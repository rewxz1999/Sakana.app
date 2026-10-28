import { createHash } from 'node:crypto'
import { extname } from 'node:path'

/**
 * 图片缓存**文件名**的推算（V1.5.1）—— 纯函数，缓存数据库用它把"某部番的封面"
 * 映射到磁盘上真实存在的那个文件。
 *
 * 为什么单独一个文件、而且要把"改写后的地址"当参数传进来：
 *   · 缓存数据库需要这个映射来执行「收藏的图片永久保留 / 过期图片按档位删除」；
 *   · 但 URL 改写（`rewriteImageUrl`）依赖设置与内置反代常量，住在 bangumi.ts 里，
 *     而 bangumi.ts 又要 import 缓存数据库 —— 静态互相 import 会形成循环依赖。
 *   · 所以这里只保留**与改写无关**的部分（hash 与扩展名规则），改写在调用方做完再传进来。
 *     这样只有一份 hash 算法，且不会有循环依赖。
 */

/**
 * 缓存文件名里的 hash 部分（**与 media.fetchImageWithCache 逐字一致**）。
 *
 * 那边算的是 `sha1(最终请求地址).slice(0, 24)`；这里必须用同一套算法，
 * 否则"收藏图片永久保留"会保护到一批不存在的文件名，而真正的封面被当成无主图片清理掉。
 */
export function imageCacheStem(finalUrl: string): string {
  return createHash('sha1').update(finalUrl).digest('hex').slice(0, 24)
}

/** 图片缓存支持的扩展名（与 media 侧的 IMAGE_EXTS 一致；认不出就用 .img） */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

/** 从最终请求地址推扩展名（取图侧同样读 URL 的 pathname） */
export function imageCacheExt(finalUrl: string): string {
  try {
    const e = extname(new URL(finalUrl).pathname).toLowerCase()
    return IMAGE_EXTS.has(e) ? e : '.img'
  } catch {
    return '.img'
  }
}

/**
 * 由「原始地址 + 缩放后地址 + 原图地址」推出磁盘上可能存在的文件名集合。
 *
 * 为什么是多个：
 *   · 界面取图走 `rewriteImageUrl(raw)`（默认宽 400）→ 缩放路径一个文件；
 *   · 缩放路径不可用时取图侧会退回**原图路径**再试 → 同一张图存在第二个文件；
 *   · 导出 data URL（`imageDataUrl`）走 `rewriteImageUrl(raw, 0)` → 原图路径；
 *   · 用户在设置里换过图片反代时，同一张图的域名变了、hash 也跟着变。
 * 清理时必须把这几条都认下来（旧的域名变体由缓存数据库额外兼容），
 * 否则"收藏的封面"会有一部分保护不到。
 */
export function imageCacheFileNames(input: {
  /** 原始地址（未改写） */
  raw: string
  /** 界面实际请求的地址（宽 400 的缩放路径） */
  sized: string
  /** 原图地址（去掉 /r/<宽>/ 前缀） */
  original: string
}): string[] {
  const out = new Set<string>()
  const add = (u: string): void => {
    if (!u) return
    out.add(`${imageCacheStem(u)}${imageCacheExt(u)}`)
  }
  add(input.sized)
  add(input.original)
  add(input.raw)
  return [...out]
}

/**
 * 同一张封面的**缩放宽度的候选地址**（V1.5.2）。
 *
 * 背景（用户报告）：番剧表/在线库的封面正常，但条目详情页同一张封面加载不出来。
 * 追查结果：卡片用的是 `/r/400/…`（已缓存，58KB），详情页用的是 `large`（`/pic/cover/l/…`，442KB，
 * 没有 `/r/` 前缀）——两者是**不同的缓存键**，而后者在部分网络下直连会被中断。
 *
 * 所以取图失败时按「800 → 400」降级重试：这两个尺寸在我们自己的图床上是稳定可用的，
 * 而且 400 往往已经在缓存里。降级成功的字节仍然按**原始地址**缓存，
 * 下次同一条 `large` 请求直接命中，不再重复下载。
 */
export function imageVariantUrls(url: string, widths: number[] = [800, 400]): string[] {
  const out: string[] = []
  let u: URL
  try {
    u = new URL(String(url ?? ''))
  } catch {
    return out
  }
  const m = /^(.*?)(\/pic\/cover\/.*)$/i.exec(u.pathname)
  if (!m) return out
  const prefix = m[1].replace(/\/r\/\d+$/, '') // 若已有 /r/400 前缀先剥掉
  const rest = m[2]
  for (const w of widths) {
    const width = Math.round(w)
    if (!Number.isFinite(width) || width <= 0) continue
    out.push(`${u.origin}${prefix}/r/${width}${rest}${u.search}`)
  }
  return out
}

/** 只取 hash 部分（清理时按"文件名不含扩展名"比对，兼容 .img/.jpg 混用） */
export function imageCacheStems(names: readonly string[]): string[] {
  return names.map((name) => name.replace(/\.[a-z0-9]+$/i, ''))
}
