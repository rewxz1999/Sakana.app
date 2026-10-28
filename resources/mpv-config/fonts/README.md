# 播放器字体资源

## uosc_icons.otf

uosc 控制栏的图标字体（ligature 字体：输入 `play_arrow` 这样的名字，GSUB 会替换成对应字形）。

- **来源**：uosc 5.13 自带的 `MaterialIconsRound-Regular`（Material Icons Round，Apache License 2.0）。
- **V1.5.2 改造**：把其中 68 个常用图标的轮廓替换成 **Material Symbols Rounded**
  （Google，Apache License 2.0），其余字形与全部 GSUB ligature 原样保留。
  字形名、cmap、PostScript 名（`MaterialIconsRound-Regular`，uosc 在 `lib/ass.lua` 里硬编码）
  都不变，所以对 uosc 是**无感替换**。
- **为什么这样做**：用户要求美化控制栏图标；Material Symbols Rounded 是 Material Icons Round
  的官方后继，曲线更少毛刺、光学尺寸更统一，而 uosc 只认 ligature 名字，换字体文件是唯一
  不 fork uosc 的改法。
- **可复现**：仓库里带了两支脚本（需要 Node 与 Python + fontTools）：
  ```bash
  node .e2e/icon-font/fetch-icons.mjs   # 从 jsDelivr 抓 Material Symbols Rounded 的单个 SVG
  python .e2e/icon-font/build-font.py   # 解析 path、写回 CFF 字形，输出到 %TEMP%/uosc_icons.otf
  ```
  `build-font.py` 会逐个打印替换结果与 bbox（空轮廓/超出 em 框都会被明确报出来），
  不会静默产出坏字体。要回滚直接用 git 恢复本文件即可。

## uosc_textures.ttf

uosc 的纹理字体（spinner 等），未改动。
