import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import type { SaveDirsInfo } from '@shared/api'
import { api } from '@/lib/api'
import { toast, useSettings } from '@/stores/app'
import { Button, Input } from '@/components/ui'
import { Card, SubPage } from '@/components/SettingsShell'

/** 三个可改保存位置；baseDir 由主进程决定，不在这里编辑 */
type Draft = Pick<SaveDirsInfo, 'downloadDir' | 'screenshotDir' | 'galDir'>

const DIR_KEYS = ['downloadDir', 'screenshotDir', 'galDir'] as const

const EMPTY_INFO: SaveDirsInfo = { baseDir: '', downloadDir: '', screenshotDir: '', galDir: '' }

/** 只把「草稿与当前生效目录不同」的项放进 patch，避免无意义地重写设置 */
function patchOf(draft: Draft, info: SaveDirsInfo): Partial<SaveDirsInfo> {
  const patch: Partial<SaveDirsInfo> = {}
  for (const k of DIR_KEYS) {
    const next = draft[k].trim()
    if (next && next !== info[k]) patch[k] = next
  }
  return patch
}

function DirRow({
  title,
  desc,
  draft,
  effective,
  onPick
}: {
  title: string
  desc: string
  draft: string
  /** 主进程当前真正在用的目录（保存成功后由 info 回读刷新） */
  effective: string
  onPick: () => void
}) {
  const pending = draft.trim() !== '' && draft.trim() !== effective
  return (
    <Card title={title} desc={desc}>
      <div className="flex gap-2">
        <Input value={draft} readOnly placeholder="未设置" />
        <Button variant="outline" icon={FolderOpen} onClick={onPick}>
          选择目录
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-relaxed">
        <span className="text-faint">当前生效：</span>
        <span className="break-all font-mono text-text">{effective || '未设置'}</span>
        {/* 草稿与生效值不一致时给出显式提示：此时尚未写入，点「保存」才会生效 */}
        {pending ? <span className="text-warn">（未保存）</span> : null}
      </div>
    </Card>
  )
}

/**
 * 文件保存配置小窗口（/save-dirs）
 * 缓存目录已独立为「缓存设置」窗口（/cache-settings）。
 *
 * v0.2.4：过去「选择目录」会立刻本地 setState + 写设置，界面显示的值不等于主进程真正在用的值，
 * 于是出现「文件夹改了、文件还存到老位置」的问题。现在统一为：
 * 选择目录只改草稿 → 点「保存」调用 api.saveDirs.set（主进程建目录 + 写设置 + 同步下载器/媒体白名单）
 * → 回读 api.saveDirs.info 覆盖界面状态，保证显示的就是生效值。
 */
export function SaveDirsPage() {
  // 设置 store 里也缓存了 downloadDir/screenshotDir，其它页面会读它；
  // 保存后重新 load 一次，避免渲染层仍拿着旧目录
  const reloadSettings = useSettings((s) => s.load)
  const [info, setInfo] = useState<SaveDirsInfo>(EMPTY_INFO)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Draft>({ downloadDir: '', screenshotDir: '', galDir: '' })
  const [saving, setSaving] = useState(false)

  /** 读取主进程真实生效的目录，并把草稿重置为它（唯一的展示数据来源） */
  const refresh = useCallback(async (): Promise<SaveDirsInfo | null> => {
    const r = await api.saveDirs.info()
    if (!r.ok) {
      toast.error(`读取保存目录失败：${r.error}`)
      return null
    }
    setInfo(r.data)
    setDraft({ downloadDir: r.data.downloadDir, screenshotDir: r.data.screenshotDir, galDir: r.data.galDir })
    setLoaded(true)
    return r.data
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 选择目录：只写进草稿，不落盘、不通知主进程 */
  const pick = async (key: keyof Draft): Promise<void> => {
    const r = await api.dialog.pickDir()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if (!r.data) return // 用户取消
    const dir = r.data
    setDraft((d) => ({ ...d, [key]: dir }))
  }

  const patch = patchOf(draft, info)
  const dirty = Object.keys(patch).length > 0

  const onSave = async (): Promise<void> => {
    if (!dirty) {
      toast.info('保存目录没有变化')
      return
    }
    setSaving(true)
    const r = await api.saveDirs.set(patch)
    if (!r.ok) {
      setSaving(false)
      toast.error(`保存目录失败：${r.error}`)
      return
    }
    // set 已在主进程建目录并同步运行中的下载器/媒体白名单；这里再回读一次，
    // 用主进程的返回值覆盖界面状态，而不是信任本地草稿
    const latest = await refresh()
    await reloadSettings()
    setSaving(false)
    if (latest) toast.success('保存目录已更新并立即生效')
  }

  const openBase = async (): Promise<void> => {
    if (!info.baseDir) return
    const r = await api.app.openPath(info.baseDir)
    if (!r.ok) toast.error(r.error)
    else if (r.data) toast.error(r.data)
  }

  return (
    <SubPage
      icon={FolderOpen}
      title="文件保存配置"
      desc="番剧下载 / 番剧截图 / galgame 截图保存位置（选择后点「保存」立即生效）"
      maxWidth="max-w-xl"
      actions={
        <Button size="sm" icon={Save} loading={saving} disabled={!dirty} onClick={() => void onSave()}>
          保存
        </Button>
      }
    >
      {loaded ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3">
          <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-dim">
            所有未配置的保存位置已自动创建于：
            <span className="break-all font-mono text-xs text-accent">{info.baseDir}</span>
          </div>
          <Button size="sm" variant="soft" icon={FolderOpen} onClick={() => void openBase()}>
            打开文件夹
          </Button>
        </div>
      ) : null}

      <DirRow
        title="番剧下载保存位置"
        desc="番剧下载文件根目录，下载时自动创建「番剧名」子文件夹"
        draft={draft.downloadDir}
        effective={info.downloadDir}
        onPick={() => void pick('downloadDir')}
      />
      <DirRow
        title="番剧截图保存位置"
        desc="播放器截屏（截图按钮）保存位置"
        draft={draft.screenshotDir}
        effective={info.screenshotDir}
        onPick={() => void pick('screenshotDir')}
      />
      <DirRow
        title="galgame 截图保存位置"
        desc="galgame 截图助手抓取的游戏窗口画面保存位置"
        draft={draft.galDir}
        effective={info.galDir}
        onPick={() => void pick('galDir')}
      />

      <p className="text-center text-[11px] leading-relaxed text-faint">
        「选择目录」只修改待保存的值，点击右上角「保存」后才写入并立即同步给下载器与截图服务。
        <br />
        图片与封面缓存目录请在「缓存设置」窗口中调整。
      </p>
    </SubPage>
  )
}
