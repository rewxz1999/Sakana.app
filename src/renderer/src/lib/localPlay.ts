import type { LocalTargetInput } from '@shared/types'
import { api } from './api'

/**
 * 进入本地播放前的目录解析（订阅卡片 / 下载卡片共用）。
 *
 * 产品要求（v0.2.9 修复）：从卡片点「本地播放」必须**直接用下载目录**开始播放，
 * 不能再弹文件夹选择框。目录由主进程按「下载任务记录 → 订阅记录 → 下载根目录/番剧名」推导，
 * 规则与下载器建目录时完全一致（见 main/services/downloader/localCleanup.ts）。
 *
 * 目录不存在或没有视频文件时返回明确原因（调用方 toast），不再静默什么都不做。
 */
export async function resolveLocalPlay(
  input: LocalTargetInput
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const r = await api.downloads.localDir(input)
  if (!r.ok) return { ok: false, error: r.error }
  if (!r.data.exists) {
    return { ok: false, error: `本地还没有这部番剧的文件：${r.data.dir}` }
  }
  if (r.data.videos === 0) {
    return { ok: false, error: `文件夹里没有可播放的视频文件：${r.data.dir}` }
  }
  return { ok: true, dir: r.data.dir }
}
