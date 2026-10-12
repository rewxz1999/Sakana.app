import { useCallback, useEffect, useState } from 'react'
import { History, RefreshCw, Trash2 } from 'lucide-react'
import type { DanmakuFetchRecord } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/app'
import { Card } from '@/components/SettingsShell'
import { Badge, Button, Spinner } from '@/components/ui'

/**
 * 「弹幕数据源获取记录」（V1.1.2，用户要求）。
 *
 * ## 为什么要有这一块
 *
 * 用户的场景是「在设置里测试巴哈姆特，搜《败犬女主太多了》《学生会也有洞》都能搜到，
 * 但实际播放时却没看到从数据源拿到的弹幕」。数据源那条链在此之前是完全**黑**的：
 * 界面只显示"这批弹幕来自哪里"，而"这一集到底有没有去要过、用的哪个关键词、要了多久、
 * 为什么没要到"一个都看不到 —— 只能靠猜（我第一轮就猜错了方向）。
 *
 * 所以这里把每一次尝试原样列出来，尤其是**关键词**那一栏：
 * 巴哈姆特只认番剧的**日文名/繁体名**，如果记录里显示去搜的是简体中文名，
 * 那就一眼能看出问题出在"别名没带上"，而不是"源坏了"。
 *
 * 记录由主进程在每次加载弹幕时写入（`danmakuFetchLog.ts`），只留最近 200 条。
 * 这一块默认折叠：它是排障用的，平时不该占地方。
 */
export function DanmakuFetchLogCard(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DanmakuFetchRecord[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await api.danmaku.fetchLog()
    setLoading(false)
    if (!r.ok) {
      toast.error(`读取获取记录失败：${r.error}`)
      return
    }
    setRecords(r.data ?? [])
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const clear = async (): Promise<void> => {
    const r = await api.danmaku.fetchLogClear()
    if (!r.ok) {
      toast.error(`清空失败：${r.error}`)
      return
    }
    setRecords([])
    toast.success(`已清空 ${r.data.removed} 条获取记录`)
  }

  const okCount = records.filter((x) => x.ok).length

  return (
    <Card
      title="获取记录"
      desc="每次去弹幕数据源要弹幕的结果：用的哪个关键词、花多久、拿到多少条、为什么没拿到（排障用）"
    >
      <div className="mb-2 flex items-center gap-2">
        <Button
          size="sm"
          variant={open ? 'soft' : 'outline'}
          icon={History}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '查看获取记录'}
        </Button>
        {records.length > 0 ? (
          <Badge tone="neutral">
            {records.length} 条 · 成功 {okCount}
          </Badge>
        ) : null}
      </div>
      {!open ? (
        <div className="text-[11px] leading-relaxed text-faint">
          播放时如果没看到数据源的弹幕，先看这里：
          <span className="text-dim">关键词</span>那一栏如果是简体中文名，说明这次没带上日文/繁体别名
          （巴哈姆特只认日文名与繁体名），而不是源本身有问题。
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="soft" icon={RefreshCw} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void clear()} disabled={records.length === 0}>
              清空记录
            </Button>
          </div>
          {loading && records.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-xs text-dim">
              <Spinner size={14} /> 正在读取…
            </div>
          ) : records.length === 0 ? (
            <div className="py-4 text-center text-xs text-faint">
              还没有记录。进播放器播一集，或在上面的数据源里点「测试」，这里就会出现条目。
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-elev2 text-faint">
                  <tr>
                    <th className="px-2 py-1.5 font-normal">时间</th>
                    <th className="px-2 py-1.5 font-normal">番剧 / 集</th>
                    <th className="px-2 py-1.5 font-normal">数据源</th>
                    <th className="px-2 py-1.5 font-normal">关键词</th>
                    <th className="px-2 py-1.5 font-normal">结果</th>
                    <th className="px-2 py-1.5 font-normal">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={`${r.at}-${i}`} className="border-t border-border/60 align-top">
                      <td className="whitespace-nowrap px-2 py-1.5 text-faint">
                        {new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false })}
                        <div className="text-[10px] opacity-70">
                          {r.trigger === 'play' ? '播放自动' : r.trigger === 'test' ? '测试按钮' : '手动'}
                        </div>
                      </td>
                      <td className="max-w-[9rem] px-2 py-1.5">
                        <div className="truncate text-dim" title={r.title}>
                          {r.title || '(无标题)'}
                        </div>
                        <div className="text-[10px] text-faint">第 {r.episode} 集</div>
                      </td>
                      <td className="max-w-[8rem] truncate px-2 py-1.5 text-dim" title={r.sourceName}>
                        {r.sourceName}
                      </td>
                      <td className="max-w-[10rem] px-2 py-1.5">
                        <span className={r.keyword ? 'text-text' : 'text-faint'}>{r.keyword || '(没走到搜索)'}</span>
                      </td>
                      <td className="max-w-[16rem] px-2 py-1.5">
                        {r.ok ? (
                          <span className="text-ok">{r.count} 条</span>
                        ) : (
                          <span className="text-warn">失败</span>
                        )}
                        <div className="truncate text-[10px] text-faint" title={r.detail}>
                          {r.detail}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-faint">
                        {r.ms > 0 ? `${(r.ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
