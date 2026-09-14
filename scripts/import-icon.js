// 从任意 PNG/JPG 导入应用图标 → resources/icon.png（正方形 256×256）
// 用法：electron scripts/import-icon.js "D:\path\to\icon.png"
// 说明：取代 scripts/gen-icon.js（那个是程序化绘制的兜底图标）
const { app, nativeImage } = require('electron')
const { writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const SRC = process.argv[2] || 'D:\\ME\\my go\\爱音1.png'
const SIZE = 256

app.whenReady().then(() => {
  if (!existsSync(SRC)) {
    console.error('源图片不存在:', SRC)
    app.exit(2)
    return
  }
  const img = nativeImage.createFromPath(SRC)
  if (img.isEmpty()) {
    console.error('无法解析源图片:', SRC)
    app.exit(3)
    return
  }
  const size = img.getSize()
  console.log('源图片:', `${size.width}x${size.height}`)

  // 先取居中正方形（避免缩放后变形），再缩放到目标尺寸
  const side = Math.min(size.width, size.height)
  const square =
    size.width === size.height
      ? img
      : img.crop({
          x: Math.floor((size.width - side) / 2),
          y: Math.floor((size.height - side) / 2),
          width: side,
          height: side
        })
  const out = square.resize({ width: SIZE, height: SIZE, quality: 'best' })
  const outSize = out.getSize()

  const dir = join(__dirname, '..', 'resources')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'icon.png')
  writeFileSync(target, out.toPNG())
  console.log('已写入', target, `${outSize.width}x${outSize.height}`, out.toPNG().length, 'bytes')
  app.exit(0)
})
