import dayjs from 'dayjs'

/** 远程图片 → sakana-img 协议（主进程带 UA/Referer 请求 + 磁盘缓存） */
export function imgUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('sakana-img://') || url.startsWith('data:')) return url
  const b64 = b64url(url)
  return `sakana-img://fetch/${b64}`
}

/** 本地图片（工具封面等） */
export function localImgUrl(path: string | null | undefined): string {
  if (!path) return ''
  return `sakana-img://local/${b64url(path)}`
}

/** 本地视频（支持 Range） */
export function localVideoUrl(path: string): string {
  return `sakana-media://local/${b64url(path)}`
}

/** 本地字幕（主进程实时转 WebVTT） */
export function localSubUrl(path: string): string {
  return `sakana-sub://local/${b64url(path)}`
}

function b64url(s: string): string {
  // 兼容中文与特殊字符
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 距今天数偏移后的周一起点 */
export function mondayOf(weekOffset: number): dayjs.Dayjs {
  const now = dayjs().add(weekOffset * 7, 'day')
  const dow = now.day() === 0 ? 7 : now.day() // 1=周一
  return now.subtract(dow - 1, 'day')
}

export function weekdayDate(weekOffset: number, weekdayId: number): dayjs.Dayjs {
  return mondayOf(weekOffset).add(weekdayId - 1, 'day')
}

export function fmtDate(d: dayjs.Dayjs): string {
  return d.format('MM月DD日')
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return dayjs(ts).format('YYYY-MM-DD HH:mm')
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return dayjs(ts).format('YYYY-MM-DD')
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mm = String(m).padStart(2, '0')
  const sss = String(ss).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${sss}` : `${m}:${sss}`
}

export function yearOf(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const y = parseInt(dateStr.slice(0, 4), 10)
  return Number.isNaN(y) ? null : y
}
