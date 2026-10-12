/*
 * galPng —— 最小 PNG 编解码 + alpha 合成（纯 Node zlib，零第三方依赖）。
 *
 * 为什么自己写：立绘的「按坐标数据合成差分立绘」需要三步
 *   解码碎片 PNG → 按坐标/不透明度叠加 → 再编码成一张 PNG，
 * 而项目里既不合适也没必要引入图像库：
 *   · `@dynamicaaa/rpx`（已 npm view 核实存在）带 `@dynamicaaa/pyrunner`（便携 Python 运行时）+
 *     chalk/ora/yargs，是 CLI 形态，塞进 Electron 44 得不偿失；
 *   · sharp / canvas 都要带原生产物（node-gyp / prebuild），与「不打包、只出源码」的约束冲突。
 * PNG 本身只用到 zlib 解压 + 反滤波 + CRC32，自己实现最稳，也方便只读约束（见下）。
 *
 * ★ 安全红线：本文件纯内存计算，不读游戏文件（字节由调用方以只读方式取出），
 *   不写任何游戏目录，只产出 Buffer 交给上层写进 Sakana 自己的保存目录。
 */

import { deflateSync, inflateSync } from 'node:zlib'

export interface PngImage {
  width: number
  height: number
  /** RGBA8，长度 = width*height*4 */
  rgba: Buffer
}

const CRC_TABLE = ((): Int32Array => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA8 → PNG（全 filter 0，压缩级别 6：立绘面积大，级别高一点文件小很多） */
export function encodePng(img: PngImage): Buffer {
  const { width, height, rgba } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function paeth(a: number, b: number, c: number): number {
  const pa = Math.abs(b - c)
  const pb = Math.abs(a - c)
  const pc = Math.abs(a + b - 2 * c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * PNG → RGBA8。
 * 支持 8 位 灰度/RGB/调色板/灰度+alpha/RGBA，以及 1/2/4 位调色板（老式立绘素材常见）；
 * 隔行扫描与 16 位深直接返回 null（调用方跳过该层并统计，不猜）。
 */
export function decodePng(buf: Buffer): PngImage | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let p = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  let trns: Buffer | null = null
  const idat: Buffer[] = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      trns = data
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    p += 12 + len
  }
  if (!width || !height || interlace !== 0 || !idat.length) return null
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (!chans) return null
  if (bitDepth !== 8 && !(colorType === 3 && bitDepth <= 8)) return null
  if (colorType === 3 && !palette) return null

  const bpp = Math.max(1, Math.ceil((chans * bitDepth) / 8))
  const stride = Math.ceil((width * chans * bitDepth) / 8)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  if (raw.length < (stride + 1) * height) return null

  const plane = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = plane.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? plane.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      const v = line[x]
      if (ft === 0) cur[x] = v
      else if (ft === 1) cur[x] = (v + a) & 0xff
      else if (ft === 2) cur[x] = (v + b) & 0xff
      else if (ft === 3) cur[x] = (v + ((a + b) >> 1)) & 0xff
      else if (ft === 4) cur[x] = (v + paeth(a, b, c)) & 0xff
      else return null
    }
  }

  const rgba = Buffer.alloc(width * height * 4)
  const sample = (row: number, i: number): number => {
    if (bitDepth === 8) return plane[row * stride + i]
    const per = 8 / bitDepth
    const byte = plane[row * stride + Math.floor(i / per)]
    const shift = 8 - bitDepth * ((i % per) + 1)
    return (byte >> shift) & ((1 << bitDepth) - 1)
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 6) {
        const i = y * stride + x * 4
        rgba[o] = plane[i]
        rgba[o + 1] = plane[i + 1]
        rgba[o + 2] = plane[i + 2]
        rgba[o + 3] = plane[i + 3]
      } else if (colorType === 2) {
        const i = y * stride + x * 3
        rgba[o] = plane[i]
        rgba[o + 1] = plane[i + 1]
        rgba[o + 2] = plane[i + 2]
        rgba[o + 3] = 255
      } else if (colorType === 0) {
        const i = y * stride + x
        rgba[o] = rgba[o + 1] = rgba[o + 2] = plane[i]
        rgba[o + 3] = 255
      } else if (colorType === 4) {
        const i = y * stride + x * 2
        rgba[o] = rgba[o + 1] = rgba[o + 2] = plane[i]
        rgba[o + 3] = plane[i + 1]
      } else {
        const idx = sample(y, x)
        const pi = idx * 3
        if (pi + 2 >= palette!.length) return null
        rgba[o] = palette![pi]
        rgba[o + 1] = palette![pi + 1]
        rgba[o + 2] = palette![pi + 2]
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255
      }
    }
  }
  return { width, height, rgba }
}

/**
 * 把一个碎片按 source-over 叠加到画布上。
 * `scale`（默认 1）用于「该级别是缩小版」的情况：坐标表给的尺寸 / 碎片实际尺寸就是缩放比，
 * 用最近邻缩放（立绘碎片是像素风以外的写实图，最近邻在做工上够用，且不必引入重采样代码）。
 */
export function blit(
  dst: PngImage,
  src: PngImage,
  left: number,
  top: number,
  opacity = 255,
  scale = 1
): void {
  const dw = dst.width
  const dh = dst.height
  const sw = scale === 1 ? src.width : Math.max(1, Math.round(src.width * scale))
  const sh = scale === 1 ? src.height : Math.max(1, Math.round(src.height * scale))
  for (let y = 0; y < sh; y++) {
    const ty = top + y
    if (ty < 0 || ty >= dh) continue
    const sy = scale === 1 ? y : Math.min(src.height - 1, Math.floor(y / scale))
    for (let x = 0; x < sw; x++) {
      const tx = left + x
      if (tx < 0 || tx >= dw) continue
      const sx = scale === 1 ? x : Math.min(src.width - 1, Math.floor(x / scale))
      const s = (sy * src.width + sx) * 4
      let sa = src.rgba[s + 3]
      if (sa === 0) continue
      if (opacity < 255) sa = Math.round((sa * opacity) / 255)
      if (sa === 0) continue
      const d = (ty * dw + tx) * 4
      if (sa === 255) {
        dst.rgba[d] = src.rgba[s]
        dst.rgba[d + 1] = src.rgba[s + 1]
        dst.rgba[d + 2] = src.rgba[s + 2]
        dst.rgba[d + 3] = 255
        continue
      }
      const ia = 255 - sa
      dst.rgba[d] = Math.round((src.rgba[s] * sa + dst.rgba[d] * ia) / 255)
      dst.rgba[d + 1] = Math.round((src.rgba[s + 1] * sa + dst.rgba[d + 1] * ia) / 255)
      dst.rgba[d + 2] = Math.round((src.rgba[s + 2] * sa + dst.rgba[d + 2] * ia) / 255)
      dst.rgba[d + 3] = Math.max(dst.rgba[d + 3], sa)
    }
  }
}

/** 用像素包围盒裁掉四周全透明的边（立绘合成后能省下大量空白） */
export function cropToContent(img: PngImage, alphaMin = 8): PngImage {
  let minX = img.width
  let minY = img.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[row + x * 4 + 3] > alphaMin) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || maxY < 0) return img
  if (minX === 0 && minY === 0 && maxX === img.width - 1 && maxY === img.height - 1) return img
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    img.rgba.copy(out, y * w * 4, ((y + minY) * img.width + minX) * 4, ((y + minY) * img.width + minX + w) * 4)
  }
  return { width: w, height: h, rgba: out }
}

/** 不透明像素占比（合成结果的自检指标：太低说明坐标或缩放出错，界面据此如实提示） */
export function opaqueRatio(img: PngImage, alphaMin = 8): number {
  let n = 0
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > alphaMin) n++
  return n / (img.width * img.height)
}
