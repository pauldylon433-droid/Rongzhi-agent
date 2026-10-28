// 公网演示 AI 调用护栏（仅在 PUBLIC_DEMO=1 且 PUBLIC_AI_ENABLED=1 时启用）。
//
// - 每次模型调用（含工具循环中的多次调用）都会经过本护栏，计入每日配额与并发计数；
// - 每日配额按服务器本地日期（UTC）切换，**重启后清零**（内存态，不持久化）；
// - 超过配额 / 并发上限时抛 AiError（kind=quota / concurrency），由助手层转成明确的 429；
// - 这是调用次数与并发限制，不是人民币费用硬上限：实际费用仍取决于模型定价与输入输出长度。
import { AiError } from './ai-client.js'

export function createAiGuard({ chatFn, dailyCallQuota, maxConcurrency, now = () => new Date() }) {
  if (typeof chatFn !== 'function') throw new Error('createAiGuard 需要注入 chatFn')
  if (!(dailyCallQuota > 0) || !(maxConcurrency > 0)) {
    throw new Error('AI 护栏需要正整数配额与并发上限')
  }
  let dayKey = null
  let used = 0
  let active = 0

  const dayOf = () => {
    const d = now()
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  async function guardedChatFn(args) {
    const k = dayOf()
    if (k !== dayKey) {
      dayKey = k
      used = 0
    }
    if (used >= dailyCallQuota) {
      throw new AiError('今日 AI 调用配额已用完，请明日再试（配额在服务重启后重置）', { kind: 'quota' })
    }
    if (active >= maxConcurrency) {
      throw new AiError('当前 AI 并发请求过多，请稍后重试', { kind: 'concurrency' })
    }
    used += 1
    active += 1
    try {
      return await chatFn(args)
    } finally {
      active -= 1
    }
  }

  return {
    chatFn: guardedChatFn,
    stats: () => ({ dayKey, used, active, dailyCallQuota, maxConcurrency }),
  }
}
