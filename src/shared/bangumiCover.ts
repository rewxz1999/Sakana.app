/**
 * bangumi 封面地址 → subject id（V1.5.2 图片兜底用）。
 *
 * 单独放在 shared 里是为了能脱离 Electron 断言：图片兜底完全依赖这个正则，
 * 错一位就会把 A 番的封面换成 B 番的，比"没兜底"更糟。
 *
 * 只认 `/pic/cover/<尺寸>/<xx>/<yy>/<id>_<文件名>.<ext>`：
 *   · `/pic/crt/`（角色图）、`/pic/icon/`（头像）里也带数字，但语义不是"这张图属于哪部番"，
 *     拿它去查备用源只会换成错误封面，所以一律不认；
 *   · 查询串（`?x=1`）不影响取 id，但这里要求路径结尾就是图片名 —— 带查询串的 URL 先由调用方剥掉。
 */
export function subjectIdFromCoverUrl(url: string): number | null {
  const m = /\/pic\/cover\/[^/]+\/[^/]+\/[^/]+\/(\d{3,9})_[^/]*\.(?:jpg|jpeg|png|webp)$/i.exec(
    String(url ?? '').trim()
  )
  if (!m) return null
  const id = Number(m[1])
  return Number.isFinite(id) && id > 0 ? id : null
}
