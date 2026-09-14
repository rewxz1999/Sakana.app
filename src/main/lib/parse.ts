// 资源标题/文件名解析工具（蜜柑计划 RSS 与本地文件共用）

const EP_RE = /第\s*(\d{1,4})\s*[话話集]/u
const EP_RE2 = /(?:^|[\s\[【（(])0*(\d{1,3})(?:\.5)?(?:v\d{1,2})?(?:[\s\]】）)]|$)/u
const EP_RE3 = /[Ee][Pp]?(\d{1,3})/u
const RES_RE = /(1080[pP]|720[pP]|2160[pP]|4K|480[pP])/u

export function parseGroup(title: string): string | null {
  const m = title.match(/^\s*\[([^\]]+)\]/) ?? title.match(/^\s*【([^】]+)】/)
  return m ? m[1].trim() : null
}

export function parseEpisode(title: string): number | null {
  const m = title.match(EP_RE) ?? title.match(EP_RE3) ?? title.match(EP_RE2)
  if (m) {
    const n = parseInt(m[1], 10)
    if (!Number.isNaN(n) && n > 0 && n < 2000) return n
  }
  return null
}

export function parseResolution(title: string): string | null {
  const m = title.match(RES_RE)
  return m ? m[1] : null
}

export function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Windows 合法文件夹名（方案 4.5：下载根目录下按番剧名建文件夹） */
export function safeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\s]+$/g, '')
      .trim() || '未知番剧'
  )
}

export function padEpisode(ep: number | null): string {
  return ep != null ? `第${String(ep).padStart(2, '0')}集` : '未知集数'
}
