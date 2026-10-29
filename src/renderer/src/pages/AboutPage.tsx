import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Info, XCircle } from 'lucide-react'
import type { CacheInfo, PlayerAssets, SaveDirsInfo } from '@shared/api'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'
// 应用图标：resources/icon.png 只是打包资源，渲染层无法直接引用，
// 因此把同一份图标复制为渲染层静态资源由 Vite 打包（与 sidebar-art.png 同一做法）。
import appIcon from '@/assets/app-icon.png'
/** v0.2.8：致谢 DeepSeek 的配图 */
import deepseekThanks from '@/assets/deepseek-1.png'

/** 版本号兜底（正常情况下由主进程 app.getVersion() 提供，避免多处硬编码漂移） */
const APP_VERSION_FALLBACK = '1.5.4'

/**
 * 项目作者（v0.2.12）。
 *
 * 名字**不在仓库里**：构建时由 `electron.vite.config.ts` 从被 gitignore 的
 * `sakana.local.json` 读到，再通过 `define` 注入成这个全局常量
 * （用户要求「关于页加上项目作者，但 git 上不要传作者名字」）。
 * 没配置时是空串，页面会整行隐藏 —— 所以源码与提交历史里都找不到这个名字。
 */
const PROJECT_AUTHOR: string = typeof __SAKANA_AUTHOR__ === 'string' ? __SAKANA_AUTHOR__ : ''

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-all text-right text-xs text-dim">{children}</span>
    </div>
  )
}

function AssetItem({ name, ok }: { name: string; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-dim">{name}</span>
      <span className="flex items-center gap-1 text-[11px]">
        {ok == null ? (
          <span className="text-faint">检测中…</span>
        ) : ok ? (
          <>
            <CheckCircle2 size={12} className="text-ok" />
            <span className="text-ok">已内置</span>
          </>
        ) : (
          <>
            <XCircle size={12} className="text-danger" />
            <span className="text-danger">未内置</span>
          </>
        )}
      </span>
    </div>
  )
}

export function AboutPage() {
  const { settings } = useSettings()

  /*
   * 应用图标的一次性自检（为什么留这一段）。
   *
   * 换封面图后出现过"应用图标看起来没显示"的反馈，而它在界面上有两种**长得一模一样**的成因：
   *   ① 图片根本没加载出来（路径 404 / 解码失败）→ `naturalWidth === 0`；
   *   ② 图片加载成功了，但源图是**不透明**的、底色接近纯白 → 在浅色主题下"融"进背景。
   * 只有读 `naturalWidth/naturalHeight` 才能把 ① 和 ② 分开。
   * 正常路径完全静默（不污染控制台），只在异常时打一条 warn —— 以后再出同类问题，
   * 打开控制台就能立刻确定是"没加载"还是"加载了但看不见"。
   */
  const iconChecked = useRef(false)
  const onIconLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    if (iconChecked.current) return
    iconChecked.current = true
    const img = e.currentTarget
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      console.warn('[AboutPage] 应用图标已触发 load 但解码尺寸为 0：', img.currentSrc || img.src)
    }
  }
  const onIconError = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    console.warn('[AboutPage] 应用图标加载失败（路径/解码问题）：', {
      src: img.currentSrc || img.src,
      naturalWidth: img.naturalWidth
    })
  }

  const [dataPath, setDataPath] = useState('')
  const [dirs, setDirs] = useState<SaveDirsInfo | null>(null)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [assets, setAssets] = useState<PlayerAssets | null>(null)
  const [version, setVersion] = useState(APP_VERSION_FALLBACK)
  useEffect(() => {
    void api.app.version().then((r) => {
      if (r.ok && r.data) setVersion(r.data)
    })
  }, [])

  useEffect(() => {
    void api.app.dataPath().then((r) => {
      if (r.ok) setDataPath(r.data)
    })
    void api.saveDirs.info().then((r) => {
      if (r.ok) setDirs(r.data)
    })
    void api.cache.info().then((r) => {
      if (r.ok) setCache(r.data)
    })
    void api.player.assets().then((r) => {
      if (r.ok) setAssets(r.data)
    })
  }, [])

  const openDataDir = async (): Promise<void> => {
    const r = await api.app.openDataDir()
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  /*
   * 走反代时统一显示「Bangumi」（v0.2.7 附加：界面上不摊开反代地址）。
   * 没配反代就显示当前镜像站地址 —— 那时用户确实需要知道自己在用哪面镜像。
   */
  const customApi = (settings.bangumiCustomApi ?? '').trim()
  // 只显示「内置 / 自定义」，不显示地址：内置双反代的地址与 PSK 是主进程隐藏项
  const mainSource = customApi ? 'Bangumi（自定义反代 · 地址已隐藏）' : 'Bangumi（内置双反代 · 地址已隐藏）'
  const mirrorCount = settings.dataSources?.mirrors?.length ?? settings.bangumiMirrors.length

  return (
    <SubPage icon={Info} title="关于 Sakana" desc="版本、数据来源、目录与内置组件信息" maxWidth="max-w-xl">
      {/* 版本 */}
      <div className="flex flex-col items-center gap-1 py-2 text-center">
        {/* 原本这里是一个 🐟 emoji 占位，改用打包内的应用封面图标，保证与任务栏/安装包图标一致 */}
        {/*
         * 为什么给图标加底板与描边：源图（resources/icon.png）是**不透明**的 512×512 真彩图，
         * 没有 alpha 通道，且其主背景色测出来是 rgb(248,248,246)，而本页 sakura 主题背景是
         * rgb(250,246,248) —— 差 2/255，肉眼完全同色。所以图标那 75% 的浅色底会"融"进页面，
         * 看起来就像没显示。给一块浅色底板 + 描边后，无论源图有没有透明通道都能看清边界。
         * 这是**不改图**的修法：一旦以后换成带 alpha 的图标，这段样式依然无害。
         */}
        <img
          src={appIcon}
          alt="Sakana 应用图标"
          width={80}
          height={80}
          draggable={false}
          className="h-20 w-20 select-none rounded-2xl border border-border bg-elev2 object-contain p-1 shadow-sm"
          onLoad={onIconLoad}
          onError={onIconError}
        />
        <div className="text-base font-bold">Sakana</div>
        <div className="text-xs text-faint">
          版本 v{version}
          <span className="ml-2 rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">测试版</span>
        </div>
        <div className="text-[11px] text-faint">番剧管理及播放桌面客户端</div>
        {/* 项目作者：用户要求「不需要太显眼」，所以只放一行浅色小字；未配置就整行不渲染 */}
        {PROJECT_AUTHOR ? (
          <div className="mt-1 text-[10px] tracking-wide text-faint/80">项目作者：{PROJECT_AUTHOR}</div>
        ) : null}
      </div>

      {/* 数据来源 */}
      <Card title="数据来源" desc="番剧数据、图片、弹幕与 galgame 数据来源（界面不显示内部地址）">
        <Row label="当前数据源">
          {mainSource}
          {customApi ? '（默认数据源）' : '（默认数据源 · 双端点分担）'}
        </Row>
        <div className="border-t border-border" />
        <Row label="镜像站数量">{mirrorCount} 个{customApi ? '（反代取不到数据时可手动切换）' : ''}</Row>
        <div className="border-t border-border" />
        <Row label="番剧数据">
          Bangumi：优先在线数据库（详情 / 番剧表日历），失败回退内置双反代或自定义反代；镜像站作为兜底
        </Row>
        <div className="border-t border-border" />
        <Row label="封面图片">在线图床（443 优先，失败换 8443）→ 内置图片反代；连续失败时用 AniList / Jikan / Kitsu 兜底</Row>
        <div className="border-t border-border" />
        <Row label="弹幕">自建 danmu_api（dandanplay 兼容接口）+ 本地缓存；只使用这一个弹幕源</Row>
        <div className="border-t border-border" />
        <Row label="附加在线源">
          Apple CMS 采集站 / 自托管 REST / AnimePahe / AllManga（仍属测试功能，入口在「测试」设置与条目详情页）
        </Row>
        <div className="border-t border-border" />
        <Row label="galgame 数据">月幕 galgame（ymgal.games）、VNDB；搜索只提供站点跳转</Row>
        <div className="border-t border-border" />
        <Row label="资源站">蜜柑计划（订阅 / 下载资源）</Row>
      </Card>

      {/* 目录 */}
      <Card title="目录" desc="数据、缓存与保存位置">
        <Row label="应用数据目录">
          <span className="font-mono text-[11px]">{dataPath || '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="缓存目录">
          <span className="font-mono text-[11px]">{cache?.dir ?? '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="下载目录">
          <span className="font-mono text-[11px]">{dirs?.downloadDir ?? '读取中…'}</span>
        </Row>
        <div className="border-t border-border" />
        <Row label="截图目录">
          <span className="font-mono text-[11px]">{dirs?.screenshotDir ?? '读取中…'}</span>
        </Row>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void openDataDir()}>
            打开数据目录
          </Button>
        </div>
      </Card>

      {/* 内置组件 */}
      <Card title="内置组件" desc="随安装包一同分发，无需额外安装">
        <AssetItem name="libmpv（播放内核）" ok={assets?.mpv ?? null} />
        <div className="border-t border-border" />
        <AssetItem name="FFmpeg（转码 / 在线流中转）" ok={assets?.ffmpeg ?? null} />
        <div className="border-t border-border" />
        <AssetItem name="aria2c（内置下载器 · 已调优）" ok={assets?.aria2 ?? null} />
        <div className="border-t border-border" />
        <Row label="uosc + uosc_danmaku">随播放器配置分发（Lua 控制栏 + 弹幕插件，含 Material Symbols 图标字体）</Row>
        <div className="border-t border-border" />
        <Row label="Anime4K 着色器">随包分发的官方 GLSL 着色器链（超分辨率 / 画质增强）</Row>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          外部组件需要自行安装：qBittorrent / Transmission（通过 WebUI / RPC 连接），
          以及可选的 yt-dlp + biliass（B 站弹幕脚本）。设置页会给出各自的配置位置。
        </p>
      </Card>

      {/* 技术栈 */}
      <Card title="技术栈">
        <div className="flex flex-wrap gap-1.5">
          {['Electron', 'React', 'TypeScript', 'Vite', 'Node.js', 'libmpv', 'aria2', 'FFmpeg'].map((t) => (
            <span key={t} className="rounded-full bg-elev2 px-2.5 py-0.5 text-[11px] text-dim whitespace-nowrap">
              {t}
            </span>
          ))}
        </div>
      </Card>

      {/* 致谢 + DeepSeek（v0.2.8 附加：用户要求的专门致谢与配图） */}
      <Card title="特别感谢 DeepSeek" desc="没有 DeepSeek，就没有这个项目">
        <div className="flex flex-col gap-3">
          <img
            src={deepseekThanks}
            alt="DeepSeek"
            draggable={false}
            className="w-full select-none rounded-xl border border-border object-cover"
          />
          <div className="text-xs leading-relaxed text-dim">
            这个项目的代码与界面都由 <span className="text-text">DeepSeek</span> 协助完成 ——
            从架构拆分、播放内核嵌入，到规则引擎与弹幕的每一个坑，都是在与它反复排查中解决的。
            衷心感谢 DeepSeek。
          </div>
        </div>
      </Card>

      <Card title="致谢">
        <ul className="flex flex-col gap-1 text-xs text-dim">
          <li>参考项目 Kazumi（在线播放规则引擎与规则仓库格式）</li>
          <li>galgame 数据来自月幕 galgame 与 VNDB</li>
          <li>番剧数据来自 Bangumi，资源来自蜜柑计划</li>
          <li>内置播放内核 libmpv、内置下载器 aria2、转码组件 FFmpeg</li>
        </ul>
      </Card>
    </SubPage>
  )
}
