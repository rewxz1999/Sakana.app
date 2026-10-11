import { createHash } from 'node:crypto'

/**
 * 由资源地址算出 BitTorrent infohash。
 *
 * 为什么需要它：qBittorrent 5.x 的 `/torrents/add` 是**异步**的（实测返回 202 +
 * `{"pending_count":1,"added_torrent_ids":[]}`，拿不到 hash），重复添加时它又什么都不返回
 * （实测与首次添加的响应一模一样）。老代码只能靠「添加前后比对 torrents/info」猜，
 * 一旦该种子已经在 qb 里（重复下载 / 用户手动加过 / 上次失败但 qb 里留着），就永远猜不到，
 * 任务会卡在 0% 且 downloaderId 为空 —— 删除、暂停也跟着失效。
 *
 * 有了 infohash 就能确定性识别：先查 qb 是否已有该 hash，有就直接复用，没有才新增。
 */

/** 磁力链接里的 infohash（btih 的 40 位 hex 形式；base32 形式极少见，识别不了就返回空串） */
export function infohashFromMagnet(uri: string): string {
  const m = /xt=urn:btih:([0-9a-fA-F]{40})/i.exec(uri)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 跳过 bencode 里的一个值，返回它的结束偏移。
 * 只按语法跳（不构造对象）：i…e / l…e / d…e / <长度>:<字节>。
 */
function skipValue(buf: Buffer, i: number): number {
  const c = buf[i]
  if (c === 0x69) {
    const e = buf.indexOf(0x65, i)
    return e < 0 ? -1 : e + 1
  }
  if (c === 0x6c || c === 0x64) {
    let p = i + 1
    while (p < buf.length && buf[p] !== 0x65) {
      p = skipValue(buf, p)
      if (p < 0) return -1
    }
    return p < buf.length ? p + 1 : -1
  }
  const colon = buf.indexOf(0x3a, i)
  if (colon < 0) return -1
  const len = parseInt(buf.toString('ascii', i, colon), 10)
  if (!Number.isFinite(len) || len < 0) return -1
  return colon + 1 + len
}

/**
 * 计算 .torrent 的 infohash：bencode 顶层字典里 `info` 值那段**原始字节**的 SHA-1
 * （BitTorrent 规范要求对原始字节求哈希，不能反序列化再序列化）。
 */
export function infohashOfTorrent(buf: Buffer): string {
  if (buf.length === 0 || buf[0] !== 0x64) return ''
  let p = 1
  while (p < buf.length && buf[p] !== 0x65) {
    const keyColon = buf.indexOf(0x3a, p)
    if (keyColon < 0) return ''
    const keyEnd = skipValue(buf, p)
    if (keyEnd < 0) return ''
    const key = buf.toString('ascii', keyColon + 1, keyEnd)
    const valEnd = skipValue(buf, keyEnd)
    if (valEnd < 0) return ''
    if (key === 'info') {
      return createHash('sha1').update(buf.subarray(keyEnd, valEnd)).digest('hex')
    }
    p = valEnd
  }
  return ''
}

/** 由资源地址取 infohash：磁力直接解析，.torrent 地址则下载种子后计算（失败返回空串） */
export function infohashFromUrl(url: string, fetchTorrent?: (url: string) => Promise<Buffer>): Promise<string> {
  if (url.startsWith('magnet:')) return Promise.resolve(infohashFromMagnet(url))
  if (!fetchTorrent) return Promise.resolve('')
  return fetchTorrent(url)
    .then((buf) => infohashOfTorrent(buf))
    .catch(() => '')
}
