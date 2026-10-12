import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Camera, FolderOpen, Hammer, Keyboard, ScanLine, Users, Wand2 } from 'lucide-react'
import type { GalToolsConfig } from '@shared/types'
import { DEFAULT_GAL_TOOLS } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Badge, Button, Input, Switch } from '@/components/ui'

const DEFAULTS = DEFAULT_GAL_TOOLS

/** 快捷键显示名 */
function accelLabel(accel: string): string {
  return accel
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl') return 'Ctrl'
      if (k === 'Control') return 'Ctrl'
      if (k === 'Alt') return 'Alt'
      if (k === 'Shift') return 'Shift'
      if (k === 'Space') return '空格'
      return k
    })
    .join('+')
}

function GhostCard({ icon: Icon, name, desc }: { icon: typeof Camera; name: string; desc: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-elev1/50 p-4 opacity-70">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-elev2 text-faint">
          <Icon size={15} />
        </div>
        <span className="text-sm font-medium">{name}</span>
        <Badge className="ml-auto whitespace-nowrap" tone="neutral">开发中</Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-faint">{desc}</p>
    </div>
  )
}

export function GalgameToolsPage() {
  const navigate = useNavigate()
  const [cfg, setCfg] = useState<GalToolsConfig>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [saving, setSaving] = useState(false)
  const hotkeyRef = useRef<HTMLInputElement>(null)
  const lastSavedDirRef = useRef('')

  useEffect(() => {
    void api.gal.toolsGet().then((r) => {
      if (r.ok) {
        setCfg({ ...DEFAULTS, ...r.data })
        lastSavedDirRef.current = r.data.dir ?? ''
        setLoaded(true)
      } else {
        toast.error(r.error)
        setLoaded(true)
      }
    })
  }, [])

  /** 写回配置（渲染层乐观更新 + 主进程持久化/应用快捷键） */
  const persist = useCallback(
    async (patch: Partial<GalToolsConfig>, quiet = false) => {
      const next = { ...cfg, ...patch }
      setCfg(next)
      setSaving(true)
      const r = await api.gal.toolsSet(patch)
      setSaving(false)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setCfg({ ...DEFAULTS, ...r.data })
      if (!quiet) toast.success('配置已保存')
    },
    [cfg]
  )

  /** 快捷键录入：keydown 组合键 → CommandOrControl+Shift+G 风格 */
  const onHotkeyKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const k = e.key
      // 纯修饰键按下不作为组合
      if (['Control', 'Alt', 'Shift', 'Meta', 'Command', 'CapsLock', 'Tab', 'Escape'].includes(k)) {
        if (k === 'Escape') {
          setCapturing(false)
          hotkeyRef.current?.blur()
        }
        return
      }
      const parts: string[] = []
      if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      let key = k
      if (key === ' ') key = 'Space'
      else if (/^[a-z]$/.test(key)) key = key.toUpperCase()
      else if (/^F\d{1,2}$/i.test(key)) key = key.toUpperCase()
      // 其它修饰键类按键（数字键、符号等）也允许，但纯符号/字母必须带修饰键，避免误触
      if (/^([A-Z0-9]|Space)$/.test(key) && parts.length === 0) return
      if (!/^[A-Z0-9]$|^F\d{1,2}$|^Space$|^Arrow|^Numpad|^Media/.test(key) && key.length === 1) return
      const accel = [...parts, key].join('+')
      await persist({ hotkey: accel })
      setCapturing(false)
      toast.success(`快捷键已设为 ${accelLabel(accel)}`)
      hotkeyRef.current?.blur()
    },
    [persist]
  )

  const pickDir = useCallback(async () => {
    const r = await api.gal.pickDir()
    if (r.ok && r.data) {
      const dir = r.data
      lastSavedDirRef.current = dir
      setCfg((c) => ({ ...c, dir }))
      void persist({ dir }, true)
    }
  }, [persist])

  const shotNow = useCallback(async () => {
    setSaving(true)
    const r = await api.gal.screenshotNow()
    setSaving(false)
    if (r.ok) toast.success(`已截图并保存: ${r.data}`)
    else toast.error(r.error)
  }, [])

  return (
    <div className="relative h-full overflow-y-auto px-5 py-4">
      <div className="flex items-center gap-3">
        {api.window.isSmallWindow ? null : (
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-xs text-dim hover:text-text whitespace-nowrap"
          >
            <ArrowLeft size={14} /> 返回
          </button>
        )}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">Galgame 工具</h1>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent whitespace-nowrap">galgame 助手</span>
          </div>
          <p className="mt-0.5 text-xs text-faint">配置截图快捷方式，游戏内随时截图不打断</p>
        </div>
      </div>

      <div className="mt-4 flex max-w-3xl flex-col gap-4 pb-10">
        {/* galgame 助手（原「截图助手」）开关 */}
        <section className="rounded-xl border border-border bg-elev1 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Camera size={15} className="text-accent" /> galgame 助手
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
                开启后注册全局快捷键，只截取正在运行的 galgame 窗口画面（保存为 PNG）。
              </p>
            </div>
            <Switch
              checked={cfg.screenshotEnabled}
              disabled={!loaded}
              onChange={(v) => void persist({ screenshotEnabled: v })}
            />
          </div>
        </section>

        {/* 隐藏悬浮按钮 */}
        <section className="rounded-xl border border-border bg-elev1 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Wand2 size={15} className="text-accent" /> 隐藏悬浮拍摄按钮
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
                开启后不显示屏幕角落的小相机悬浮窗，仅用快捷键截图。
              </p>
            </div>
            <Switch
              checked={cfg.hideIcon}
              disabled={!loaded || !cfg.screenshotEnabled}
              onChange={(v) => void persist({ hideIcon: v })}
            />
          </div>
        </section>

        {/* 快捷键 */}
        <section className="rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Keyboard size={15} className="text-accent" /> 截图快捷键
            </div>
            <p className="mt-0.5 text-[11px] text-faint">点击输入框后按下组合键（需带 Ctrl/Alt/Shift，Esc 取消）</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={hotkeyRef}
              readOnly
              value={capturing ? '请按下快捷键…' : accelLabel(cfg.hotkey || DEFAULTS.hotkey)}
              disabled={!cfg.screenshotEnabled}
              className={`h-9 w-56 cursor-pointer rounded-lg border px-3 text-center text-sm font-semibold outline-none transition-colors disabled:opacity-40 ${
                capturing ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-elev2 text-text'
              }`}
              onFocus={() => setCapturing(true)}
              onBlur={() => setCapturing(false)}
              onKeyDown={onHotkeyKeyDown}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCapturing(true)
                hotkeyRef.current?.focus()
              }}
            >
              重新设置
            </Button>
          </div>
          {saving ? <div className="mt-2 text-[10px] text-faint">保存中…</div> : null}
        </section>

        {/* 保存根目录：截图 / bgm / 立绘 / cg 都挂在它下面，所以这里要说清是"根目录"而不只是截图 */}
        <section className="rounded-xl border border-border bg-elev1 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <FolderOpen size={15} className="text-accent" /> galgame 保存根目录
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-faint">
            截图、BGM、立绘、CG 都按
            <span className="text-dim"> 根目录\游戏名\种类\文件 </span>
            存放（种类 = 截图 / bgm / 立绘 / cg）。例如截图是
            <span className="text-dim"> CLANNAD\截图\CLANNAD_20260917_143512.png</span>，
            立绘是 <span className="text-dim">CLANNAD\立绘\ひなた_001.png</span>（角色名+序号，差分合成结果）。
            游戏名里的非法字符会自动替换为下划线；改这里会同时改变截图/BGM/立绘/CG 的落盘位置，
            旧版直接放在「游戏名」目录下的截图会在下一次截图时自动迁进「截图」子目录（不会并存两套）。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={cfg.dir}
              placeholder="未设置（默认用户目录 screenshots/galgame）"
              className="flex-1"
              onChange={(e) => setCfg((c) => ({ ...c, dir: e.target.value }))}
              onBlur={() => {
                const v = cfg.dir.trim()
                if (v !== lastSavedDirRef.current) {
                  lastSavedDirRef.current = v
                  void persist({ dir: v }, true)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <Button variant="outline" icon={FolderOpen} onClick={() => void pickDir()}>
              选择目录
            </Button>
            <Button variant="soft" icon={Camera} onClick={() => void shotNow()}>
              试截一张
            </Button>
          </div>
        </section>

        {/* 更多工具占位 */}
        <div className="mt-2">
          <div className="mb-2 text-xs font-semibold text-dim">更多工具正在开发…</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <GhostCard
              icon={Users}
              name="角色立绘提取"
              desc="已上线：在「galgame 库」里右键游戏卡片 →「解包（引擎检测 / 曲名映射 / 立绘 CG）」，面板里可提取立绘（按坐标合成差分立绘）与 CG"
            />
            <GhostCard icon={ScanLine} name="文本提取" desc="提取游戏内文本 / 存档" />
            <GhostCard icon={Hammer} name="制作 galgame，也许能做出来？" desc="制作自己的 galgame" />
          </div>
        </div>
      </div>
    </div>
  )
}
