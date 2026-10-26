// 可疑行为检测与范围锁定（基于持久化审计事件，不依赖提示词关键词）。
// 规则可配置；锁定按 scope_key（默认 IP / 会话）隔离，单个访客不会锁死整个共享服务。
// 与请求限流（内存）、强验证锁定（verification_failures）分开记录与恢复。
import { randomUUID } from 'node:crypto'

export const SUSPICIOUS_ERROR_RE = /(不允许提交字段|不接受额外参数|未知工具|不属于当前用户|越权|未授权|非法工具|非法参数|未找到该账户)/

export function getSecurityConfig() {
  const num = (name, fallback) => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    enabled: process.env.SECURITY_ANOMALY_ENABLED !== '0',
    windowMs: num('SECURITY_ANOMALY_WINDOW_SECONDS', 300) * 1000,
    threshold: num('SECURITY_ANOMALY_THRESHOLD', 5),
    lockMs: num('SECURITY_ANOMALY_LOCK_SECONDS', 900) * 1000,
  }
}

export function isSuspiciousError(message) {
  return SUSPICIOUS_ERROR_RE.test(String(message || ''))
}

export function createSecurityGuard({ auditTrail, listEvents, scopeKey, config = getSecurityConfig(), now = () => Date.now() }) {
  const scope = String(scopeKey || 'unknown')
  async function events() {
    if (!config.enabled) return []
    const rows = await listEvents({ category: 'security', limit: 500 })
    return (rows || []).filter((e) => e.detail && e.detail.scope_key === scope)
  }
  async function lockedUntil() {
    const rows = await events()
    let until = 0
    for (const e of rows) {
      if (e.action === 'scope_locked' && e.detail?.locked_until) {
        const t = Date.parse(e.detail.locked_until)
        if (Number.isFinite(t) && t > until) until = t
      }
    }
    return until > now() ? until : 0
  }
  async function assertAllowed() {
    if (!config.enabled) return { allowed: true }
    const until = await lockedUntil()
    return until ? { allowed: false, locked_until: new Date(until).toISOString(), scope_key: scope } : { allowed: true }
  }
  async function record(kind, detail = {}) {
    if (!config.enabled) return { locked: false, count: 0 }
    const active = await lockedUntil()
    if (active) return { locked: true, locked_until: new Date(active).toISOString(), count: config.threshold, scope_key: scope }
    const eventId = randomUUID()
    await auditTrail.record({
      event_id: eventId, category: 'security', action: `anomaly_${String(kind).slice(0, 60)}`,
      result: 'detected', detail: { scope_key: scope, ...detail },
    })
    const rows = await events()
    const since = now() - config.windowMs
    const count = rows.filter((e) => e.action === `anomaly_${String(kind).slice(0, 60)}`
      && Date.parse(e.created_at) >= since).length
    if (count >= config.threshold) {
      const until = new Date(now() + config.lockMs).toISOString()
      await auditTrail.record({
        category: 'security', action: 'scope_locked', result: 'locked',
        detail: { scope_key: scope, locked_until: until, reason: kind, count, window_ms: config.windowMs },
      })
      return { locked: true, locked_until: until, count, scope_key: scope }
    }
    return { locked: false, count, scope_key: scope }
  }
  return { scopeKey: scope, assertAllowed, record }
}

export function createModelBreaker({ threshold = 3, cooldownMs = 60000, now = () => Date.now() } = {}) {
  let failures = 0
  let openUntil = 0
  return {
    async call(fn, args) {
      if (now() < openUntil) {
        const err = new Error('模型服务暂时熔断，请稍后重试')
        err.code = 'model_breaker'
        err.retry_after_ms = Math.max(0, openUntil - now())
        throw err
      }
      try {
        const r = await fn(args)
        failures = 0
        return r
      } catch (e) {
        failures += 1
        if (failures >= threshold) openUntil = now() + cooldownMs
        throw e
      }
    },
    stats: () => ({ failures, open: now() < openUntil, open_until: openUntil ? new Date(openUntil).toISOString() : null }),
  }
}
