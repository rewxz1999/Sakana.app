import { inflateRawSync } from 'node:zlib'

/**
 * 极简 ZIP 读取器（v0.2.13）。
 *
 * 为什么自己写：增量补丁的解包原先调用系统的 `tar -x`（Windows 10+ 自带 bsdtar），
 * 但用户实测在「应用进程内」报 `EPERM, Permission denied`（同一个补丁、同一个目录，
 * 用 Node 单独跑却三次全过），说明问题出在应用进程特有的上下文 ——
 * 子进程创建、文件句柄、杀软扫描都可能是变量。补丁解包是**更新链路的关键一步**，
 * 不能依赖外部程序，所以改成纯 JS：读 EOCD → 中央目录 → 本地头 → inflateRawSync。
 *
 * 支持的形态与我们自己 `scripts/make-patch.js`（`tar -a -c` 生成的 zip）一致：
 * 存储（method 0）与 deflate（method 8）、UTF-8 文件名、无加密、无 zip64。
 * 遇到不支持的形态就明确报错，由调用方回落到完整安装包 —— 绝不猜着解。
 */

export interface ZipEntry {
  name: string
  data: Buffer
}

/** 4GB 上限哨兵（ZIP64 的标志）；我们的补丁远小于此，出现就说明不是我们的包 */
const ZIP64_SENTINEL = 0xffffffff

function findEocd(buf: Buffer): number {
  // EOCD 签名 0x06054b50；注释最长 65535 字节，所以从尾部往前扫
  const minPos = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 读取 zip 里的全部条目到内存。
 *
 * 选择「全读进内存」而不是边解边落盘，是为了让**校验与落盘彻底分开**：
 * 先在没有磁盘写入的前提下算完所有哈希，全部对得上才写文件 ——
 * 这样就不会出现「半个 app.asar 被写进安装目录」的情况。
 * 补丁本身只有几 MB（解包后约 30MB），内存代价可以接受。
 */
export function unzipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === ZIP64_SENTINEL || cdSize === ZIP64_SENTINEL || count === 0xffff) {
    throw new Error('不支持 ZIP64 格式的补丁包')
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip 中央目录越界（文件可能不完整）')

  const out: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${i + 1} 个中央目录项损坏`)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new Error(`不支持 ZIP64 条目：${name}`)
    }
    p += 46 + nameLen + extraLen + commentLen

    // 目录项跳过；本地头的 extra 字段长度可能与中央目录不同，必须重新读本地头
    if (name.endsWith('/')) continue
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地文件头损坏：${name}`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    if (raw.length !== compressedSize) throw new Error(`条目数据越界（文件可能不完整）：${name}`)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = inflateRawSync(raw)
    } else {
      throw new Error(`不支持的压缩方式 ${method}：${name}`)
    }
    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`条目解压后大小不符（期望 ${uncompressedSize}，实际 ${data.length}）：${name}`)
    }
    out.push({ name, data })
  }
  return out
}
