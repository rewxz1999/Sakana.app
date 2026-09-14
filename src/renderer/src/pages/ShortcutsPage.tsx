import { useEffect, useState } from 'react'
import { Keyboard, RotateCcw } from 'lucide-react'
import { SHORTCUTS, useShortcuts } from '@/stores/shortcuts'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

const KEY_LABEL: Record<string, string> = {
  ' ': '空格',
  Escape: 'Esc',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓'
}

function keyLabel(k: string): string {
  return KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k)
}

/**
 * 播放器快捷键编辑面板（无页面外壳）。
 * 设置主页面不再提供独立入口，本面板现在渲染在「播放器设置」窗口内。
 */
export function ShortcutsPanel() {
  const { map, loaded, setKey } = useShortcuts()
  const [capturing, setCapturing] = useState<string | null>(null)

  useEffect(() => {
    void useShortcuts.getState().load()
  }, [])

  // 按键捕获
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      setKey(capturing, e.key)
      toast.success(`已绑定：${keyLabel(e.key)}`)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, setKey])

  const resetAll = (): void => {
    for (const s of SHORTCUTS) setKey(s.action, s.defaultKey)
    toast.success('已恢复默认快捷键')
  }

  return (
    <div className="flex flex-col gap-2">
      {SHORTCUTS.map((s) => (
        <div key={s.action} className="flex items-center gap-4 rounded-xl border border-border bg-elev2/40 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{s.label}</div>
            <div className="text-[11px] text-faint">{s.desc}</div>
          </div>
          <button
            onClick={() => setCapturing(s.action)}
            className={`min-w-[92px] rounded-lg border px-3 py-1.5 text-center text-xs font-semibold transition-colors ${
              capturing === s.action
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-elev2 text-dim hover:border-accent hover:text-text'
            }`}
          >
            {capturing === s.action ? '请按键…' : keyLabel(map[s.action] ?? s.defaultKey)}
          </button>
        </div>
      ))}
      {!loaded ? <div className="py-4 text-center text-xs text-faint">加载中…</div> : null}
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="text-[11px] text-faint">点击任一行的按键区域，然后按下新按键完成绑定（Esc 取消）</span>
        <Button size="sm" variant="outline" icon={RotateCcw} onClick={resetAll}>
          恢复默认
        </Button>
      </div>
    </div>
  )
}

/** 独立页面包装（/shortcuts 路由保留，主设置页已不再提供入口） */
export function ShortcutsPage() {
  return (
    <SubPage icon={Keyboard} title="播放器快捷键" desc="自定义播放器控件快捷键绑定">
      <Card>
        <ShortcutsPanel />
      </Card>
    </SubPage>
  )
}
