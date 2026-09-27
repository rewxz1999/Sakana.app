import { useEffect, useState } from 'react'
import { imgUrl, localImgUrl } from '@/lib/format'

/**
 * 图片地址 → sakana-img 协议地址。
 *
 * v0.3.5：加了一层**本地路径自动识别**。
 * 起因是「最XX的角色」新增了「右键格子添加本地图片」，那里存的是磁盘绝对路径，
 * 而 CoverImage 过去只认 `local` 这个布尔开关 —— 漏传就会走 `imgUrl()` 被当成远程地址
 * （`sakana-img://fetch/<base64 的 E:\…>`），主进程按 URL 取图必然失败，图片静默变占位。
 *
 * 判据与主进程 `media.isLocalImagePath` **逐字一致**（那边注释记着这条判据为什么不能
 * 写成"字母开头+可有可无的字符+冒号"：那样连 `E:` 也会被当成协议）。
 */
function looksLocal(p: string): boolean {
  if (!p) return false
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true
  return !/^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(p) && !/^(data|blob):/i.test(p)
}

function resolveImgSrc(src: string, local: boolean): string {
  if (local || looksLocal(src)) return localImgUrl(src)
  return imgUrl(src)
}

/**
 * 图片组件：经 sakana-img 协议加载（主进程带 UA/Referer + 磁盘缓存 + 图片反代改写），
 * 失败显示渐变占位。
 *
 * v0.2.7 附加：失败后**自动重试一次**。
 * 图片反代在并发加载（番剧表一屏十几张卡片）时会瞬时变慢或返回 5xx，
 * 而 CoverImage 过去一次 `onError` 就永久落到占位图 ——
 * 用户看到的就是「卡片/封面经常加载不出来」（刷新一次又好了）。
 * 现在隔一会儿用带重试标记的地址再取一次（主进程侧另有并发闸门 + 超时 + 重试）。
 */
export function CoverImage({
  src,
  local = false,
  alt = '',
  className = '',
  rounded = 'rounded-lg'
}: {
  src: string | null | undefined
  local?: boolean
  alt?: string
  className?: string
  rounded?: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const base = src ? resolveImgSrc(src, local) : ''
  const url = base && attempt > 0 ? `${base}${base.includes('?') ? '&' : '?'}retry=${attempt}` : base

  useEffect(() => {
    setAttempt(0)
    setFailed(false)
  }, [base])

  /** 重试也有上限：1.2 秒内仍失败就落到占位图，避免一直转圈 */
  useEffect(() => {
    if (attempt !== 1) return
    const t = window.setTimeout(() => setFailed(true), 1500)
    return () => window.clearTimeout(t)
  }, [attempt])

  if (!url || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-accent-soft via-elev2 to-elev3 text-faint ${rounded} ${className}`}
      >
        <span className="text-xl">🐟</span>
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={alt}
      draggable={false}
      loading="lazy"
      onError={() => {
        if (attempt === 0) setAttempt(1)
        else setFailed(true)
      }}
      onLoad={() => setFailed(false)}
      className={`select-none object-cover ${rounded} ${className}`}
    />
  )
}
