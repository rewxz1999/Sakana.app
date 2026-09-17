import { useEffect, useState } from 'react'
import { Check, CirclePlus, Database, Link2, Save, Trash2, WifiOff } from 'lucide-react'
import { DEFAULT_SETTINGS } from '@shared/types'
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
        v0.2.7 附加：这里**不再展示反代地址**（用户要求）。
        应用默认就使用内置的反代（API + 图片）作为唯一数据源，
        界面只需要说明「默认使用 API 反代地址 / 图片反代地址」即可；
        地址本身归内置默认值管，需要改的时候再展开下面的高级项。
      */}
      <Card title="默认数据源" desc="番剧数据与图片默认都走内置反代，无需配置">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5">
            <span className="text-xs text-accent">API 反代地址</span>
            <span className="text-[11px] text-accent">默认使用 ✓</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5">
            <span className="text-xs text-accent">图片反代地址</span>
            <span className="text-[11px] text-accent">默认使用 ✓</span>
          </div>
          <div className="text-[11px] leading-relaxed text-faint">
            番剧表、搜索、番剧详情与<span className="text-dim">所有封面图片</span>都优先使用反代数据源；
            反代取不到数据时会提示你切换到下面的镜像站，不会在后台偷偷换源。
            镜像站在反代不可用（或未配置）时才会被使用，并且相互之间会自动切换。
          </div>
        </div>
      </Card>

      {/* 高级：自定义反代地址（默认收起，默认不显示具体地址） */}
      <Card title="高级" desc="仅在反代域名变更时需要修改">
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] text-faint hover:text-dim">
            展开自定义反代地址（一般无需修改）
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-faint">API 反代地址（Worker 的 API_HOST）</span>
              <Input
                value={customApi}
                onChange={(e) => setCustomApi(e.target.value)}
                placeholder="留空则使用内置默认地址"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-faint">图片反代地址（Worker 的 IMG_HOST）</span>
              <Input
                value={customImg}
                onChange={(e) => setCustomImg(e.target.value)}
                placeholder="留空则使用内置默认地址"
              />
            </label>
            <div className="text-[11px] leading-relaxed text-faint">
              部署方法见仓库 <code className="font-mono">deploy/bangumi-proxy-README.md</code>。
              图片反代会把 <code className="font-mono">lain.bgm.tv</code> 等图床地址按原路径改写到反代，并走按需缩放。
              <br />
              注意：两个地址都留空并保存，就会回到「镜像站」模式（那时番剧表底栏会显示镜像站地址）。
            </div>
            {/* 地址默认不显示，所以必须留一个「恢复默认」的出口，否则清空后无法找回内置反代 */}
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCustomApi(DEFAULT_SETTINGS.bangumiCustomApi ?? '')
                  setCustomImg(DEFAULT_SETTINGS.bangumiCustomImg ?? '')
                  toast.info('已填入内置默认反代地址，点「保存」生效')
                }}
              >
                恢复内置默认反代
              </Button>
            </div>
          </div>
        </details>
      </Card>

      {/* 当前主数据源 */}
      <Card title="当前主数据源" desc="日历、条目详情、搜索与全部图片">
        <div className="flex flex-col gap-2">
          <div className="break-all rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5 text-xs text-accent">
            {customApi.trim() ? 'Bangumi（自建反代 · 默认数据源）' : (main.trim() || '（未设置）')}
          </div>
          <div className="text-[11px] leading-relaxed text-faint">
            {customApi.trim() ? (
              <>
                反代拥有最高优先级：番剧表、条目详情、搜索、封面图片全部走它。
                下面的 {mirrors.filter(Boolean).length} 个镜像站
                <span className="text-dim">不会</span>被使用 ——
                反代失败时应用会提示你手动切换，而不会在后台偷偷换源。
              </>
            ) : (
              <>共 {mirrors.filter(Boolean).length} 个数据源；主数据源失败时会按下面的镜像顺序自动回退。</>
            )}
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
                } whitespace-nowrap `}
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
