// 生成 Sakana 应用图标（64x64 粉色小鱼 PNG），写入 resources/icon.png
const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const W = 256
const H = 256

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return dx * dx + dy * dy <= 1
}
function inCircle(x, y, cx, cy, r) {
  return inEllipse(x, y, cx, cy, r, r)
}
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
  const d1 = sign(px, py, ax, ay, bx, by)
  const d2 = sign(px, py, bx, by, cx, cy)
  const d3 = sign(px, py, cx, cy, ax, ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

const PINK = [232, 84, 138]
const PINK_LIGHT = [244, 132, 168]
const DARK = [44, 36, 48]

const pixels = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let color = null
    let alpha = 0
    if (inEllipse(x + 0.5, y + 0.5, 112, 128, 84, 54)) color = PINK
    if (inTriangle(x + 0.5, y + 0.5, [188, 132], [244, 76], [244, 180])) color = PINK
    if (inEllipse(x + 0.5, y + 0.5, 60, 172, 20, 26)) color = PINK_LIGHT
    if (inCircle(x + 0.5, y + 0.5, 76, 108, 15)) color = [255, 255, 255]
    if (inCircle(x + 0.5, y + 0.5, 81, 113, 8)) color = DARK
    if (inCircle(x + 0.5, y + 0.5, 100, 36, 12)) color = [255, 255, 255]
    if (inCircle(x + 0.5, y + 0.5, 132, 18, 8)) color = [255, 255, 255]
    if (color) {
      alpha = color === [255, 255, 255] ? 210 : 255
      if (color[0] === 255 && color[1] === 255 && color[2] === 255) alpha = 210
      const idx = (y * W + x) * 4
      pixels[idx] = color[0]
      pixels[idx + 1] = color[1]
      pixels[idx + 2] = color[2]
      pixels[idx + 3] = alpha
    }
  }
}

// ---- PNG 编码 ----
const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// 原始扫描线：每行前加 filter 0
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0
  pixels.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = join(__dirname, '..', 'resources')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png)
console.log('written resources/icon.png', png.length, 'bytes')
