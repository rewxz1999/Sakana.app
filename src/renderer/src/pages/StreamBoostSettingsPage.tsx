import { Gauge } from 'lucide-react'
import { StreamBoostCard } from '@/components/StreamBoostCard'
import { SubPage } from '@/components/SettingsShell'

/**
 * 在线播放设置（/stream-boost-settings，v0.3.9 补充更新）。
 *
 * 用户原话：「在线播放设置也放在外面的播放与下载区域去作为单独的设置项」。
 * 之前这张卡是塞在「下载与播放」页里的（那一页管的是下载器与缓存目录现状），
 * 加速器自己有档位、实时状态、优化记录与对比图，塞在别人页面里既不好找也铺不开。
 *
 * 现在这一页只放加速器本身，内容全部来自 `StreamBoostCard`（档位 / 实时状态与速率 /
 * 优化记录与效果提升对比图）—— 与入口成对出现：设置总览「播放与下载」区域里那一行
 * （见 `SettingsPage.tsx` 的「在线播放设置」）点了就进这里，路由在 `App.tsx`。
 *
 * 设置字段仍是 `settings.streamBoost`（键名不变，老用户档位原样生效）。
 */
export function StreamBoostSettingsPage() {
  return (
    <SubPage
      icon={Gauge}
      title="在线播放设置"
      desc="在线播放加速器的档位、实时状态与速率，以及每次加速的真实效果记录与对比图"
      maxWidth="max-w-2xl"
    >
      <StreamBoostCard />
    </SubPage>
  )
}
