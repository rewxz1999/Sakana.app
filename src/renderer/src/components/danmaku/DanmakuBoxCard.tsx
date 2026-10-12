import { useState } from 'react'
import { Download, ExternalLink, Search } from 'lucide-react'
import type { DanmakuBoxEntry } from '@shared/types'
import { api } from '@/lib/api'
import { Button, Input } from '@/components/ui'
import { Card } from '@/components/SettingsShell'
import { toast } from '@/stores/app'

/**
 * 「弹幕盒子」检索与下载（V1.1）。
 *
 * ## 站点结构是**真抓过**的（不是猜的）
 * `danmubox.github.io` 是纯静态站，**没有搜索 API**：它的检索索引是一批加密的静态文件
 * （`/list/index` 给出 12 个分片名，每个分片是 Base64 的 AES-256-ECB 密文），
 * 站点自己的搜索就是"把所有分片拉下来解密、在客户端做子串匹配"。
 * 主进程的 `danmuboxSearch` 复刻了这套做法（并把分片缓存 24 小时），所以这个卡片能真搜。
 *
 * ## 实测边界（界面必须如实告诉用户，不能装作万能）
 * - 索引共 **4299 条**，年份集中在 2013–2021（2020 年 467 条最多）；
 * - 用户授权的两部番（《败北女角太多了》《学生会也有洞》）在索引里**都是 0 条命中**
 *   —— 这两部是 2024/2026 的新番，索引里没有。所以新番请用巴哈姆特那条源。
 * - 包是 7z，由 Windows 自带的 `tar.exe`(bsdtar) 解压，解开是 B 站 XML。
 */
export function DanmakuBoxCard(): React.ReactElement {
  const [kw, setKw] = useState('')
  const [searching, setSearching] = useState(false)
  const [entries, setEntries] = useState<DanmakuBoxEntry[] | null>(null)
  const [searchedKw, setSearchedKw] = useState('')
  /** 每条要下载到第几集（默认 1） */
  const [episodeOf, setEpisodeOf] = useState<Record<string, string>>({})
  /** 落库用的番剧名（默认取条目名，用户可改成播放时用来匹配的名字） */
  const [titleOf, setTitleOf] = useState<Record<string, string>>({})
  const [downloading, setDownloading] = useState<string | null>(null)

  async function search(): Promise<void> {
    const k = kw.trim()
    if (!k) {
      toast.warn('请输入番剧名（弹幕盒子是 2019–2021 的存档，老番更容易命中）')
      return
    }
    setSearching(true)
    const r = await api.danmaku.boxSearch(k)
    setSearching(false)
    if (!r.ok) {
      toast.error(`搜索失败：${r.error}`)
      return
    }
    setEntries(r.data)
    setSearchedKw(k)
    if (r.data.length === 0) {
      toast.warn(`「${k}」在弹幕盒子里没有命中（它的索引只到 2021 年，新番基本搜不到）`)
    }
  }

  async function download(entry: DanmakuBoxEntry): Promise<void> {
    const episode = Math.max(1, Math.trunc(Number(episodeOf[entry.name] ?? '1') || 1))
    const title = (titleOf[entry.name] ?? '').trim() || entry.name
    setDownloading(entry.name)
    const r = await api.danmaku.boxDownload(entry, { title, episode, sourceId: 'danmubox' })
    setDownloading(null)
    if (!r.ok) {
      toast.error(`下载失败：${r.error}`)
      return
    }
    toast.success(
      `已存入本地弹幕库：${r.data.title} 第${r.data.episode}集（${r.data.count} 条，${Math.round(r.data.bytes / 1024)}KB）`
    )
  }

  return (
    <Card
      title="弹幕盒子（按番剧名搜索 → 下载到本地）"
      desc="danmubox.github.io：纯静态站，没有搜索 API —— 我们复刻了它自己的做法（拉加密索引→解密→客户端匹配），包下载后解压成 B 站 XML 存进本地弹幕库"
    >
      <div className="flex flex-wrap gap-2">
        <Input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
          placeholder="番剧名（建议用完整中文名，例如 妄想学生会）"
          className="h-9 min-w-[220px] flex-1 text-xs"
        />
        <Button icon={Search} loading={searching} onClick={() => void search()}>
          搜索
        </Button>
      </div>

      <div className="mt-2 rounded-lg bg-elev2/50 px-2.5 py-2 text-[11px] leading-relaxed text-faint">
        实测边界：索引共 <b className="text-dim">4299</b> 条，年份集中在 2013–2021（2020 年最多）。
        <b className="text-warn">新番基本搜不到</b> —— 新番请用上面的「巴哈姆特动画疯」数据源。
        如果你要的番在这里搜不到，可以直接用「数据源链接」填直链模板，或从别处下好 XML 放进本地弹幕库目录。
      </div>

      {entries ? (
        entries.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-faint">
            「{searchedKw}」没有命中。换个更短的关键词（例如只写主标题、去掉季数）再试。
          </div>
        ) : (
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] text-faint">
              「{searchedKw}」命中 {entries.length} 条（按名称长度与大小排序，短的更像正片）
            </div>
            <div className="max-h-[320px] overflow-y-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-elev2 text-faint">
                  <tr>
                    <th className="px-2 py-1 font-medium">条目名</th>
                    <th className="px-2 py-1 font-medium whitespace-nowrap">来源</th>
                    <th className="px-2 py-1 font-medium whitespace-nowrap">大小</th>
                    <th className="px-2 py-1 font-medium whitespace-nowrap">存为番剧名</th>
                    <th className="px-2 py-1 font-medium whitespace-nowrap">集</th>
                    <th className="px-2 py-1 font-medium whitespace-nowrap" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={`${e.repo}/${e.fileName}`} className="border-t border-border align-middle">
                      <td className="px-2 py-1.5">
                        <div className="max-w-[260px] truncate text-text" title={e.name}>
                          {e.name}
                        </div>
                        <div className="text-[10px] text-faint">
                          {e.repo}/{e.fileName}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-dim">{e.from}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-dim">
                        {Math.round(e.bytes / 1024)}KB
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={titleOf[e.name] ?? ''}
                          onChange={(ev) => setTitleOf((p) => ({ ...p, [e.name]: ev.target.value }))}
                          placeholder={e.name.length > 14 ? e.name.slice(0, 14) + '…' : e.name}
                          className="h-7 w-[150px] text-[11px]"
                          title="下载后存进弹幕库时用的番剧名（播放时按它匹配；留空用条目名）"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          min={1}
                          value={episodeOf[e.name] ?? '1'}
                          onChange={(ev) => setEpisodeOf((p) => ({ ...p, [e.name]: ev.target.value }))}
                          className="h-7 w-[56px] text-[11px]"
                          title="包内有多个分P时按这个集数挑文件；单文件包则原样取"
                        />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            icon={Download}
                            loading={downloading === e.name}
                            onClick={() => void download(e)}
                          >
                            下载
                          </Button>
                          <button
                            title="复制下载链接"
                            className="text-faint transition-colors hover:text-accent"
                            onClick={async () => {
                              // 走主进程的系统剪贴板（navigator.clipboard 在部分窗口/权限下不可靠）
                              const c = await api.clipboard.copyText(e.url)
                              if (c.ok && c.data) toast.success('下载链接已复制')
                              else toast.error(`复制失败：${c.ok ? '剪贴板拒绝写入' : c.error}`)
                            }}
                          >
                            <ExternalLink size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}
    </Card>
  )
}
