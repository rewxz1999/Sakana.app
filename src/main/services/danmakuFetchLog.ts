import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { DanmakuFetchRecord } from '@shared/types'
import { log } from '../log'

/**
 * 「弹幕数据源获取记录」（V1.1.2，用户要求）。
 *
 * 用户的原话：「现在在弹幕设置中加上点击获取弹幕记录」。
 * 为什么需要它：数据源这条路是**黑的** —— 界面只显示"这批弹幕来自哪里"，
 * 但"什么时候去要过、用的哪个关键词、要了多久、为什么没要到"全都看不到，
 * 于是出现「我在设置里测试能搜到《败犬女主太多了》，可播放时就是没有源弹幕」这种问题时
 * 只能靠猜。这里把每一次尝试按行记下来，设置页里点开就能看。
 *
 * 落盘位置：`<数据根>/data/danmakuFetchLog.json`（与其它运行期数据在一起）。
 * 只留最近 N 条（默认 200），避免无限增长。记录结构见 `@shared/types` 的 `DanmakuFetchRecord`。
 */
export type { DanmakuFetchRecord }

const MAX_RECORDS = 200

function file(): string {
  return join(app.getPath('userData'), 'data', 'danmakuFetchLog.json')
}

export function readFetchLog(): DanmakuFetchRecord[] {
  try {
    const raw = readFileSync(file(), 'utf-8')
    const parsed = JSON.parse(raw) as { records?: DanmakuFetchRecord[] }
    return Array.isArray(parsed.records) ? parsed.records : []
  } catch {
    return []
  }
}

function write(records: DanmakuFetchRecord[]): void {
  try {
    const p = file()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify({ records }, null, 2), 'utf-8')
  } catch (err) {
    log.append('warn', 'danmaku', `写弹幕获取记录失败：${String((err as Error)?.message ?? err)}`)
  }
}

/** 追加一条记录（最新的在前；超过上限就丢最旧的） */
export function appendFetchRecord(rec: DanmakuFetchRecord): void {
  const list = readFetchLog()
  list.unshift(rec)
  write(list.slice(0, MAX_RECORDS))
}

export function clearFetchLog(): number {
  const n = readFetchLog().length
  write([])
  log.append('info', 'danmaku', `弹幕获取记录已清空（原 ${n} 条）`)
  return n
}

/** 记录文件在不在（界面提示用） */
export function fetchLogExists(): boolean {
  return existsSync(file())
}
