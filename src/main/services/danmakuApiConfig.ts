/**
 * 自建 danmu_api 的基址（V1.5.2）。
 *
 * 用户原话：「我部署了 danmu_api … 请删除原来的弹幕数据源获取方式，
 * 但还是保留将弹幕缓存到本地的设置。现在请使用我部署的 danmu_api。」
 *
 * danmu_api（dandanplay 兼容）的接口前缀就是它的 TOKEN：
 *   `https://<vercel 域名>/<TOKEN>` + `/api/v2/...`
 * 所以这里的基址**已经包含 TOKEN 路径**；uosc_danmaku 的 `api_server` 用的是同一个值
 * （见 `mpv.ts` 的 uoscScriptOpts → danmaku.danmakuApiBase()）。
 *
 * 为什么单独一个模块、并且拆段 + XOR + Base64：
 *   · 地址里带用户的访问令牌，按项目一贯做法不在二进制里留明文（`strings` 扫不出来）；
 *   · 拆出来是为了让 `danmaku.ts`（业务）与 `mpv.ts`（插件配置）都从**同一个常量**取值，
 *     不会出现"应用请求一个地址、插件请求另一个地址"的分叉；
 *   · 说明白：这是**混淆不是加密**，拿到安装包的人总能还原。真正防滥用要靠服务端配额。
 *
 * 用户仍然可以在「设置 → 弹幕设置」里填自定义地址（settings.danmakuApiBase）覆盖它。
 */

/** XOR 密钥（拆成两段只是别让它看起来像一个完整的常量；这不是安全性） */
const KEY_HEAD = [0x39, 0x5c, 0xa1, 0x27, 0x6e, 0xd4]
const KEY_TAIL = [0x08, 0x93, 0x4f, 0xba, 0x12, 0xe7]

/** 基址密文（XOR + Base64，拆两段存放） */
const BASE_PARTS = ['USjVVx3uJ7wr23yKTHHAVwf5ZPoi3z+TXDKMEF', '76fvY92XeLFz3RV0GgT/cF8UfVdROQUiCDYNsd']

const XOR_KEY = [...KEY_HEAD, ...KEY_TAIL]

/**
 * 解出自建 danmu_api 的基址（末尾不带斜杠）。
 * 失败返回空串：调用方会回退到旧底座/官方地址，绝不让整个弹幕链路因为一个常量坏掉。
 */
export function builtInDanmuApiBase(): string {
  try {
    const raw = Buffer.from(BASE_PARTS.join(''), 'base64')
    for (let i = 0; i < raw.length; i++) raw[i] ^= XOR_KEY[i % XOR_KEY.length]
    return raw.toString('utf8').replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** 是否解出了可用的自建地址（诊断/设置页显示「使用内置 danmu_api」时用） */
export function builtInDanmuApiAvailable(): boolean {
  return /^https?:\/\//i.test(builtInDanmuApiBase())
}
