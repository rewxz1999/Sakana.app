import { useEffect, useState } from 'react'
import { Image, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { localImgUrl } from '@/lib/format'
import { toast } from '@/stores/app'
import { Button } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

export function NavBgPage() {
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void api.navBg.get().then((r) => {
      if (r.ok) setPath(r.data.path)
    })
  }, [])

  const pick = async (): Promise<void> => {
    setLoading(true)
    const r = await api.navBg.pick()
    setLoading(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (r.data.ok && r.data.path) {
      setPath(r.data.path)
      toast.success('导航栏背景已设置')
    } else if (r.data.error) {
      toast.error(r.data.error)
    }
  }

  const clear = async (): Promise<void> => {
    const r = await api.navBg.set('')
    if (r.ok) {
      setPath('')
      toast.success('背景已清除')
    } else {
      toast.error(r.error)
    }
  }

  return (
    <SubPage
      icon={Image}
      title="导航栏背景"
      desc="为左侧导航栏设置自定义背景图片"
      maxWidth="max-w-lg"
      actions={
        <>
          <Button size="sm" icon={Image} loading={loading} onClick={() => void pick()}>
            选择图片
          </Button>
          <Button size="sm" variant="outline" icon={Trash2} disabled={!path} onClick={() => void clear()}>
            清除背景
          </Button>
        </>
      }
    >
      {path ? (
        <div className="overflow-hidden rounded-xl border border-border bg-elev1">
          <div className="h-40 w-full bg-cover bg-center" style={{ backgroundImage: `url("${localImgUrl(path)}")` }} />
          <div className="truncate px-4 py-2 text-[11px] text-faint">{path}</div>
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-border bg-elev2/40 text-xs text-faint">
          未设置背景
        </div>
      )}

      <Card>
        <div className="text-[11px] leading-relaxed text-faint">
          支持 PNG / JPG / GIF / WEBP，大小 ≤ 8MB，尺寸 400×200 ~ 4096×4096，超限会引起界面卡顿。
          背景图会铺满左侧导航栏，并叠加半透明遮罩以保证文字可读；gif / webp 动图由浏览器自然播放。
        </div>
      </Card>
    </SubPage>
  )
}
