import { useEffect, useState } from 'react'
import { imgUrl, localImgUrl } from '@/lib/format'

/** 图片组件：经 sakana-img 协议加载（主进程带 UA/Referer + 磁盘缓存），失败显示渐变占位 */
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
  const [failed, setFailed] = useState(false)
  const url = src ? (local ? localImgUrl(src) : imgUrl(src)) : ''

  useEffect(() => {
    setFailed(false)
  }, [url])

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
      onError={() => setFailed(true)}
      className={`select-none object-cover ${rounded} ${className}`}
    />
  )
}
