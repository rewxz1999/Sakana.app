import { useEffect, useState } from 'react'
import { Check, CirclePlus, Database, Link2, Save, Trash2, WifiOff } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { useSettings } from '@/stores/app'
import { toast } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

function derive(settings: AppSettings): { main: string; mirrors: string[] } {
  const ds = settings.dataSources
  if (ds && Array.isArray(ds.mirrors) && ds.mirrors.length > 0) {
    return { main: ds.main || ds.mirrors[0], mirrors: [...ds.mirrors] }
  }
  const mirrors =
    Array.isArray(settings.bangumiMirrors) && settings.bangumiMirrors.length > 0
      ? [...settings.bangumiMirrors]
      : [settings.bangumiBase || 'https://bangumi.pro']
  return { main: settings.bangumiBase || mirrors[0], mirrors }
}

/**
 * 数据源配置小窗口（/datasource）
 * 主数据源 + 镜像列表（数据源 1/2/3…）；保存时同步写入 dataSources 与 bangumiBase / bangumiMirrors。
 */
export function DataSourcePage() {
  const { settings, save, loaded } = useSettings()
  const [main, setMain] = useState('')
  const [mirrors, setMirrors] = useState<string[]>([])
  const [customApi, setCustomApi] = useState('')
  const [customImg, setCustomImg] = useState('')
  const [results, setResults] = useState<{ url: string; ok: boolean; ms: number; error?: string }[] | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!loaded) return
    const d = derive(settings)
    setMain(d.main)
    setMirrors(d.mirrors)
    setCustomApi(settings.bangumiCustomApi ?? '')
    setCustomImg(settings.bangumiCustomImg ?? '')
  }, [loaded, settings])

  const updateMirror = (i: number, value: string): void => {
    if (mirrors[i] === main) setMain(value)
    setMirrors((prev) => prev.map((m, idx) => (idx === i ? value : m)))
  }

  const removeMirror = (i: number): void => {
    const removed = mirrors[i]
    const next = mirrors.filter((_, idx) => idx !== i)
    setMirrors(next)
    if (main === removed) setMain(next[0] ?? '')
  }

  const addMirror = (): void => {
    setMirrors((prev) => [...prev, ''])
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    const r = await api.bangumi.testMirrors()
    setTesting(false)
    if (r.ok) setResults(r.data)
    else toast.error(r.error)
  }

  const doSave = (): void => {
    const clean = mirrors.map((s) => s.trim()).filter(Boolean)
    const api = customApi.trim().replace(/\/+$/, '')
    if (clean.length === 0 && !api) {
      toast.warn('请至少保留一个数据源（或填写自建反代地址）')
      return
    }
    let m = main.trim() || clean[0] || api
    // 填了自建反代就把它设为主数据源：公共镜像（bangumi.pro / bangumi.lol / api.bgm.tv）目前都可能不可达
    if (api) m = api
    else if (!clean.includes(m)) m = clean[0]
    const list = [m, ...clean.filter((s) => s !== m)]
    save({
      dataSources: { main: m, mirrors: list },
      bangumiBase: m,
      bangumiMirrors: list,
      bangumiCustomApi: api,
      bangumiCustomImg: customImg.trim().replace(/\/+$/, '')
    })
    setMain(m)
    setMirrors(list)
    toast.success(api ? '已保存，并使用自建反代作为主数据源' : '数据源已保存')
  }

  return (
    <SubPage
      icon={Database}
      title="数据源配置"
      desc="主数据源与镜像站列表（数据源 1/2/3…），保存后用于日历与条目请求"
      actions={
        <Button size="sm" icon={Save} onClick={doSave}>
          保存
        </Button>
      }
    >
      {/*
        自建反代（Cloudflare Worker）：公共镜像被墙后的唯一可靠通道。
        两个地址分别对应 Worker 里的 API_HOST / IMG_HOST 变量。
      */}
      <Card
        title="自建反代（推荐，Cloudflare Worker）"
        desc="公共镜像失败时使用；部署方法见仓库 deploy/bangumi-proxy-README.md"
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-faint">
              API 反代地址（Worker 的 API_HOST，如 https://api.yourdomain.com）
            </span>
            <Input
              value={customApi}
              onChange={(e) => setCustomApi(e.target.value)}
              placeholder="https://api.yourdomain.com"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-faint">
              图片反代地址（Worker 的 IMG_HOST，如 https://img.yourdomain.com）
            </span>
            <Input
              value={customImg}
              onChange={(e) => setCustomImg(e.target.value)}
              placeholder="https://img.yourdomain.com"
            />
          </label>
          <div className="text-[11px] leading-relaxed text-faint">
            填写 API 反代后，它会被**强制**当作 API 源使用（走 <code className="font-mono">/v0/…</code> JSON 路径，
            不要求域名以 <code className="font-mono">api.</code> 开头），并自动跳过已知被墙的 bangumi.pro。
            图片反代会把 <code className="font-mono">lain.bgm.tv</code> 的封面按原路径改写过去。两项留空即维持原公共镜像链。
          </div>
        </div>
      </Card>

      {/* 当前主数据源 */}
      <Card title="当前主数据源" desc="日历、条目详情与搜索优先使用该地址">
        <div className="flex flex-col gap-2">
          <div className="break-all rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5 font-mono text-xs text-accent">
            {main.trim() || '（未设置）'}
          </div>
          <div className="text-[11px] text-faint">
            共 {mirrors.filter(Boolean).length} 个数据源；主数据源失败时会按下面的镜像顺序自动回退。
          </div>
        </div>
      </Card>

      {/* 镜像站列表 */}
      <Card title="镜像站列表" desc="每个数据源可编辑地址；点「设为主」把它设为主数据源，删除不影响其它条目">
        <div className="flex flex-col gap-2">
          {mirrors.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-[68px] shrink-0 text-[11px] text-faint">数据源 {i + 1}</span>
              <button
                onClick={() => setMain(m)}
                title="设为主数据源"
                className={`flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-[11px] transition-colors ${
                  m === main && m !== ''
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-faint hover:border-accent/50'
                }`}
              >
                {m === main && m !== '' ? <Check size={12} /> : null}
                {m === main && m !== '' ? '主' : '设为主'}
              </button>
              <Input value={m} onChange={(e) => updateMirror(i, e.target.value)} placeholder="https://bangumi.pro" />
              <button
                onClick={() => removeMirror(i)}
                title="删除"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-faint transition-colors hover:border-danger hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {mirrors.length === 0 ? (
            <div className="py-4 text-center text-xs text-faint">暂无数据源，点击下方「+ 新增数据源」开始添加</div>
          ) : null}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" icon={CirclePlus} onClick={addMirror}>
            新增数据源
          </Button>
          <Button size="sm" variant="outline" icon={Link2} loading={testing} onClick={() => void runTest()}>
            测试连接
          </Button>
          {results ? (
            <span className="text-[11px] text-faint">
              {results.filter((r) => r.ok).length}/{results.length} 可用
            </span>
          ) : null}
        </div>
      </Card>

      {/* 测试结果 */}
      {results ? (
        <Card title="连接测试结果" desc="按当前设置逐个测试可用性与延迟">
          <div className="flex flex-col gap-1.5">
            {results.map((r) => (
              <div key={r.url} className="flex items-center gap-2 rounded-lg border border-border bg-elev2/50 px-3 py-2 text-[11px]">
                {r.ok ? <Check size={12} className="shrink-0 text-ok" /> : <WifiOff size={12} className="shrink-0 text-danger" />}
                <span className="line-clamp-1 flex-1 text-dim">{r.url}</span>
                <span className={r.ok ? 'text-ok' : 'text-danger'}>{r.ok ? `${r.ms}ms` : (r.error ?? '失败')}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="text-[11px] leading-relaxed text-faint">
          主数据源用于日历与条目请求；网页镜像（bangumi.pro 等）自动解析页面数据，API 镜像（api. 开头）走 v0 JSON
          接口，并行尝试、首个成功者生效。全部失败时应用会提示配置 VPN / 代理。保存后会同步写入
          dataSources.main / dataSources.mirrors 与兼容字段 bangumiBase / bangumiMirrors。
        </div>
        <div className="mt-3 flex justify-end">
          <Button icon={Save} onClick={doSave}>
            保存
          </Button>
        </div>
      </Card>
    </SubPage>
  )
}
