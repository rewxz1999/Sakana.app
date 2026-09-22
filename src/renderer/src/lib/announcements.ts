import deepseekThanks from '@/assets/deepseek-2.png'

/**
 * 启动公告（v0.2.8 附加）。
 *
 * 每次启动弹一次，内容是**本次版本的更新内容**与**开发者寄语**；
 * 勾选「不再提示」后以后启动不再弹 —— 但**版本变了就无视该勾选**再弹一次
 * （判断依据是 `settings.announcementSeenVersion` 与当前版本是否一致）。
 *
 * 新增一个版本时，在下面按版本号加一条即可；找不到当前版本的条目就不弹。
 */
export interface Announcement {
  version: string
  /** 更新内容（一行一条，越短越好） */
  notes: string[]
  /** 开发者寄语（一行一条） */
  messages: string[]
  /** 配图（可省略） */
  image?: string
}

export const ANNOUNCEMENTS: Announcement[] = [
  {
    // v0.3.0（用户给定文案：开发者寄语「感谢大家的使用，0.3版本将会更加完善」；
    // 更新说明「修复了部分已知问题」；图片不变 —— 沿用 DeepSeek 那张）
    version: '0.3.0',
    notes: ['修复了部分已知问题'],
    messages: ['感谢大家的使用，0.3 版本将会更加完善'],
    image: deepseekThanks
  },
  {
    // v0.2.9 最后更新（用户给定的文案：
    // 更新内容：1.优化了ui 2.项目趋于稳定；开发者寄语：大力感谢kazumi、deepseek；图片不变）
    version: '0.2.9',
    notes: ['优化了 UI', '项目趋于稳定'],
    messages: ['大力感谢 kazumi、deepseek'],
    image: deepseekThanks
  },
  {
    version: '0.2.8',
    notes: ['增加了弹幕'],
    messages: ['感谢大家的使用', '其实没有 deepseek 我做不出这个项目'],
    image: deepseekThanks
  }
]

/** 取当前版本的公告内容（没有则返回 null，不弹窗） */
export function announcementFor(version: string): Announcement | null {
  return ANNOUNCEMENTS.find((a) => a.version === version) ?? null
}
