# 搜索页底部轮播图（内置素材）

v0.3.9 起，搜索页空态最底部那排轮播图改用**仓库内置图片**，不再依赖本机的外部目录。

| 仓库文件 | 原始文件名（用户提供的素材） |
| --- | --- |
| `fish-1.png` | `deepseek大肥鱼.png` |
| `fish-2.gif` | `deepseek大肥鱼表情1.gif` |
| `fish-3.gif` | `deepseek大肥鱼表情2.gif` |
| `fish-4.gif` | `deepseek大肥鱼表情3.gif` |
| `fish-5.gif` | `deepseek大肥鱼表情4.gif` |

素材来源与署名：**蓝色大肥鱼.com**（界面上常驻显示 `图片来源：蓝色大肥鱼.com`）。

## 为什么改成内置

v0.3.8 之前，渲染层存的是本机绝对路径（`D:\ME\表情包\…`），再经 `api.showcase.importImages()`
复制进应用数据目录才能显示 —— 因为 `sakana-img://local` 协议只放行 media.ts 注册过的白名单目录。

那套做法有两个硬伤：

1. **换一台机器就全空**：路径来自用户本机，别人 clone 下来跑，这几张图必然不存在，
   轮播区只能静默隐藏（代码里为此写了一整条降级链路）；
2. **要复制一份 17MB 的副本**进用户数据目录，且每次都得靠 localStorage 缓存路径。

现在图片跟着构建产物走（`import fish1 from '@/assets/search-carousel/fish-1.png'`），
Vite 会把它们输出到 `out/renderer/assets/`，随安装包分发，**任何机器上都有图**，
也不再需要白名单、`importImages` 与路径缓存。

## 注意

这几个文件合计约 17MB（`fish-4.gif` 单个约 9.9MB），是为了**保持素材原样**（没有重新编码，
避免 GIF 调色板重编码带来的画质损失）。若要压缩仓库体积，请重新编码后同步更新本文件。
