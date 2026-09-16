import { useEffect, useState } from 'react'
import { imgUrl, localImgUrl } from '@/lib/format'

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
  const base = src ? (local ? localImgUrl(src) : imgUrl(src)) : ''
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
