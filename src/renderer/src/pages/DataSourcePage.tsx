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
      : [settings.bangumiBase || 'https://bangumi.vip']
  return { main: settings.bangumiBase || mirrors[0], mirrors }
}

/**
 * 数据源配置小窗口（/datasource）
 *
 * 界面只允许改「API 地址」：图片地址由反代 API 的响应自带（新反代会返回它自己的图片域名），
 * 不再让用户手填。内置反代的**真实地址与 PSK 不进入渲染层**：
 *   · 地址留空 = 使用主进程内置的双端点（api-1 / api-2），设置页只显示"已隐藏"；
 *   · 输入框用 password 类型，已保存的地址不回填，避免打开设置页就等于把地址展示一遍；
 *   · 测试结果只显示 `内置反代 api-1` / `镜像站 1` 这类标签，不显示真实 URL。
 */
export function DataSourcePage() {
  const { settings, save, loaded } = useSettings()
  const [main, setMain] = useState('')
  const [mirrors, setMirrors] = useState<string[]>([])
  const [customApi, setCustomApi] = useState('')
  /** 用户是否动过输入框：没动过时保存要保留已存的自定义地址，而不是把它清空 */
  const [customApiTouched, setCustomApiTouched] = useState(false)
  const [results, setResults] = useState<{ url: string; ok: boolean; ms: number; error?: string }[] | null>(null)
  const [testing, setTesting] = useState(false)

  const savedCustomApi = (settings.bangumiCustomApi ?? '').trim()
  const hasCustomApi = savedCustomApi.length > 0

  useEffect(() => {
    if (!loaded) return
    const d = derive(settings)
    setMain(d.main)
    setMirrors(d.mirrors)
    // 地址默认隐藏：不把已保存的值塞进输入框；用户输入新值才会覆盖
    setCustomApi('')
    setCustomApiTouched(false)
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
    /*
     * 保存时的 API 地址：
     * - 用户没动输入框 → 保留已存的自定义地址（可能是空 = 内置双反代）；
     * - 用户动过 → 用输入值；清空即回到内置双反代。
     */
    const api = customApiTouched
      ? customApi.trim().replace(/\/+$/, '')
      : savedCustomApi.replace(/\/+$/, '')
    if (clean.length === 0 && !api) {
      toast.warn('请至少保留一个数据源（或填写自建反代地址）')
      return
    }
    /*
     * 自定义 API 地址只写 `bangumiCustomApi`，不混进公共镜像列表：
     * 混进去会让它被当成普通镜像参与竞速/展示，也等于在设置文件里多存一份地址。
     */
    const list = api ? clean.filter((s) => s !== api) : clean
    const m = list[0] || main.trim() || 'https://bangumi.vip'
    save({
      dataSources: { main: m, mirrors: list },
      bangumiBase: m,
      bangumiMirrors: list,
      bangumiCustomApi: api,
      // 图片地址由 API 响应自带；旧字段原样保留（内置旧域名在启动迁移时已清掉）
      bangumiCustomImg: settings.bangumiCustomImg ?? ''
    })
    setMain(m)
    setMirrors(list)
    setCustomApi('')
    setCustomApiTouched(false)
    toast.success(api ? '已保存，并使用你填写的 API 反代' : '已保存，使用内置双反代')
  }

  return (
    <SubPage
      icon={Database}
      title="数据源配置"
      desc="内置双反代与镜像站；API 地址可改，地址与密钥默认隐藏"
      actions={
        <Button size="sm" icon={Save} onClick={doSave}>
          保存
        </Button>
      }
    >
      <Card title="默认数据源" desc="两套自建反代平级，按当前在途请求数自动分担">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5">
            <span className="text-xs text-accent">API 反代</span>
            <span className="text-[11px] text-accent">
              {hasCustomApi ? '自定义 · 地址已隐藏 ✓' : '内置双端点 · 地址已隐藏 ✓'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5">
            <span className="text-xs text-accent">图片地址</span>
            <span className="text-[11px] text-accent">由 API 响应自动返回 ✓</span>
          </div>
          <div className="text-[11px] leading-relaxed text-faint">
            番剧表、搜索、番剧详情与<span className="text-dim">所有封面图片</span>都优先使用自建反代；
            两个端点谁在途请求少就用谁，其中一个失败会自动切到另一个。
            图片地址不需要手填 —— 反代返回的图片 URL 会直接使用。
          </div>
        </div>
      </Card>

      {/* 高级：自定义 API 地址（默认隐藏；只在需要换地址时展开） */}
      <Card title="高级" desc="仅在反代域名变更时需要修改">
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] text-faint hover:text-dim">
            展开自定义 API 地址（一般无需修改）
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-faint">API 反代地址</span>
              <Input
                type="password"
                autoComplete="off"
                value={customApi}
                onChange={(e) => {
                  setCustomApi(e.target.value)
                  setCustomApiTouched(true)
                }}
                placeholder={
                  hasCustomApi
                    ? '已配置（地址已隐藏）；输入新地址可替换'
                    : '留空使用内置双反代（地址已隐藏）'
                }
              />
            </label>
            <div className="text-[11px] leading-relaxed text-faint">
              留空 = 使用内置双反代；填写 = 只使用你填的地址（可用空格/逗号分隔多个）。
              地址不会出现在日志或界面里。
              <br />
              图片地址不用填：反代 API 的响应会带上它自己的图片域名。
            </div>
            {/* 地址默认不回填，所以必须留一个「恢复内置」的出口，否则清空后无法找回默认端点 */}
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCustomApi('')
                  setCustomApiTouched(true)
                  toast.info('已设为使用内置双反代，点「保存」生效')
                }}
              >
                恢复内置双反代
              </Button>
            </div>
          </div>
        </details>
      </Card>

      {/* 当前主数据源 */}
      <Card title="当前主数据源" desc="日历、条目详情、搜索与全部图片">
        <div className="flex flex-col gap-2">
          <div className="break-all rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5 text-xs text-accent">
            {hasCustomApi ? 'Bangumi（自定义反代 · 地址已隐藏）' : 'Bangumi（内置双反代 · 地址已隐藏）'}
          </div>
          <div className="text-[11px] leading-relaxed text-faint">
            {hasCustomApi ? (
              <>
                当前只使用你填写的 API 反代。反代失败时应用会提示你检查地址，不会在后台偷偷换源。
              </>
            ) : (
              <>
                内置两个端点平级调度：优先发给当前在途请求较少的那个，失败自动切另一个。
                下面的 {mirrors.filter(Boolean).length} 个公共镜像只在端点常量异常时兜底，正常不会参与竞速。
              </>
            )}
          </div>
        </div>
      </Card>

      {/* 镜像站列表 */}
      <Card title="公共镜像站" desc="反代不可用时的后备；地址不属于内置反代，可以正常显示/编辑">
        <div className="flex flex-col gap-2">
          {mirrors.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-[68px] shrink-0 text-[11px] text-faint">镜像 {i + 1}</span>
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
              <Input value={m} onChange={(e) => updateMirror(i, e.target.value)} placeholder="https://bangumi.vip" />
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
            <div className="py-4 text-center text-xs text-faint">暂无公共镜像，点击下方「+ 新增镜像」开始添加</div>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" icon={CirclePlus} onClick={addMirror}>
            新增镜像
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

      {/* 测试结果（只显示安全标签，不显示地址） */}
      {results ? (
        <Card title="连接测试结果" desc="按当前设置逐个测试可用性与延迟（地址已隐藏）">
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
          主数据源用于日历与条目请求；公共镜像（bangumi.vip 等）自动解析页面数据，API 型镜像走 v0 JSON 接口。
          反代与公共镜像不会在用户不知情的情况下互相切换。保存后会同步写入 dataSources.main / dataSources.mirrors
          与兼容字段 bangumiBase / bangumiMirrors；内置反代地址与密钥不会写入设置文件。
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
