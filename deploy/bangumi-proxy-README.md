# Bangumi 自建反代（Cloudflare Worker）部署说明

公共镜像（`bangumi.pro` / `bangumi.lol` / 直连 `api.bgm.tv`）在当前网络下已全部不可用，
因此 Sakana 支持把你自己的反代地址作为**最高优先级数据源**。

> 本目录下的 `bangumi-proxy-worker.js` 来自上游仓库
> [Yuri-NagaSaki/bangumi-proxy](https://github.com/Yuri-NagaSaki/bangumi-proxy)（原样保存，6189 字节）。
> 上游更新时重新下载覆盖即可。

---

## 一、部署 Worker（3 步）

1. **改配置**：打开 `deploy/bangumi-proxy-worker.js`，把开头两行改成你的域名：

   ```js
   const API_HOST = "api.yourdomain.com"; // 代理 api.bgm.tv（API）
   const IMG_HOST = "img.yourdomain.com"; // 代理 lain.bgm.tv（图片）
   ```

   域名随便取、不必是 `api.` 开头，只要这里填对「哪个是 API、哪个是图片」。

2. **创建并粘贴**：Cloudflare Dashboard → **Workers & Pages** → **创建应用程序** → **创建 Worker**，
   把改好的整个文件内容粘进去 → **部署**。

3. **绑定自定义域名**：进入该 Worker → **Settings → Domains & Routes → Add Custom Domain**，
   把 `API_HOST` 与 `IMG_HOST` 两个域名都绑上去（两个域名都要绑，否则对应角色识别不到）。

部署完成后访问 `https://api.yourdomain.com/__health`，应返回识别到的角色（api/img）与上游信息。
看到 `api.bgm.tv` 就说明通了。

---

## 二、在 Sakana 里启用

**设置 → 数据源配置 → 自建反代（推荐，Cloudflare Worker）**：

| 字段 | 填什么 | 作用 |
| --- | --- | --- |
| API 反代地址 | `https://api.yourdomain.com` | 作为**最高优先级数据源**，强制按 `/v0/…` JSON 路径请求；保存后自动跳过已知被墙的 `bangumi.pro` |
| 图片反代地址 | `https://img.yourdomain.com` | 把封面 `lain.bgm.tv` 地址按原路径改写到你的图片域名 |

填好后点右上角**保存**，再点「测试连接」应能看到 `1/1 可用`。

> 该 Worker 本身也会把 API 响应体里的 `lain.bgm.tv` 图片地址改写成 `IMG_HOST`，
> 所以图片反代字段在多数情况下是**冗余保险**（例如你另外用 CDN 代理图片时才需要）。

---

## 三、注意事项（重要）

- **只代理 API 与图片**：不要把 `bgm.tv` 主站网页纳入反代。网页镜像流量大且易被识别，
  会导致你的服务器 IP 被墙（上游 README 也明确警告）。
- **隐私**：公开的反代端点不要转发 `Authorization` / `Cookie`。需要登录的操作请直连官方 API。
  本项目的数据源请求不携带用户凭据，反代只用于公开的日历 / 条目 / 搜索接口。
- **CORS**：Worker 已内置 CORS 头与 `OPTIONS` 预检处理。Sakana 的数据请求与图片加载都在
  主进程完成（不受浏览器同源策略限制），因此 CORS 只是额外保险。
- **限流**：Cloudflare 免费版 Worker 每天 10 万次请求，日常使用（日历 + 条目 + 封面）远低于该上限；
  封面有 30 天 CDN 缓存。
- **换域名**：以后换域名只需改设置页里的地址，不需要重新打包应用。

---

## 四、排障

| 现象 | 处理 |
| --- | --- |
| 应用仍提示「所有 bangumi 镜像均不可访问」 | 确认设置页两个地址已保存；点「测试连接」看具体失败原因（超时/HTTP 状态码） |
| `/__health` 返回角色不对 | 该域名没绑定到 Worker，或 `API_HOST`/`IMG_HOST` 写反了 |
| 日历能出来但封面是灰块 | 图片反代域名未绑定或 `IMG_HOST` 填错；也可能是封面本身 404（老番常见） |
| 想回退到公共镜像 | 清空两个输入框并保存即可 |
