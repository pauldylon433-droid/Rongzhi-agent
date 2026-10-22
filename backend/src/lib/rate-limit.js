// 极简内存态固定窗口限流，用于强验证接口的基础请求限流。
// 与持久化的失败计数锁定（services/verification.js 的 verification_failures 表）职责分开：
// 本模块只做「单位时间最多多少次请求」，不计入失败、不锁定，重启即清零。
export function createRateLimiter({ windowMs = 60 * 1000, max = 10 } = {}) {
  const hits = new Map() // key -> { count, resetAt }
  return function limit(key) {
    const now = Date.now()
    const cur = hits.get(key)
    if (!cur || now >= cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return { allowed: true }
    }
    cur.count += 1
    if (cur.count > max) {
      return { allowed: false, retryAfterMs: Math.max(0, cur.resetAt - now) }
    }
    return { allowed: true }
  }
}
