import { useEffect, useState } from 'react'
import { Copy, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { SubPage } from '@/components/SettingsShell'

export function LogsPage() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    const r = await api.logs.readFile()
    setLoading(false)
    if (r.ok) setText(r.data)
    else toast.error(r.error)
  }

  useEffect(() => {
    void load()
  }, [])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text)
    toast.success('已复制全部日志')
  }

  const clear = async (): Promise<void> => {
    const r = await api.logs.clear()
    if (r.ok) {
      setText('')
      toast.success('日志已清空')
    } else {
      toast.error(r.error)
    }
  }

  return (
    <SubPage
      icon={FileText}
      title="运行日志"
      desc="应用启动、网络请求、下载器与播放器的运行记录，可复制用于反馈（最多保留最近 1000 条）"
      maxWidth="max-w-4xl"
      actions={
        <>
          <Button size="sm" variant="outline" icon={RefreshCw} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
          <Button size="sm" variant="outline" icon={Copy} onClick={() => void copy()}>
            复制
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void clear()}>
            清空
          </Button>
        </>
      }
    >
      <div className="h-[58vh] min-h-[240px] overflow-hidden rounded-xl border border-border bg-elev2/60">
        <pre className="selectable h-full overflow-auto p-3 font-mono text-[11px] leading-relaxed text-text">
          {text || '暂无日志记录'}
        </pre>
      </div>
    </SubPage>
  )
}
