// 可疑行为检测与范围锁定。
// 计数 / 锁定 / 到期判断使用按可信 scope 索引的独立持久状态（SQLite 表 / 云端 RPC），
// 不依赖审计事件列表的最近 N 条，因此不会因其它 scope 的事件洪泛而被挤出。
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

// 本地 SQLite 持久状态：单条事务内完成「读当前锁定 → 窗口计数 → 写锁定」。
export function createLocalSecurityState(db) {
  const selectOne = db.prepare('SELECT * FROM security_scope_state WHERE scope_key = ? AND kind = ?')
  const selectLock = db.prepare('SELECT max(locked_until_ms) AS until FROM security_scope_state WHERE scope_key = ?')
  const upsert = db.prepare(
    `INSERT INTO security_scope_state (scope_key, kind, window_start_ms, count, locked_until_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key, kind) DO UPDATE SET
       window_start_ms = excluded.window_start_ms, count = excluded.count,
       locked_until_ms = excluded.locked_until_ms, updated_at_ms = excluded.updated_at_ms`,
  )
  return {
    async lockedUntil(scopeKey, nowMs) {
      const row = selectLock.get(scopeKey)
      const until = Number(row && row.until) || 0
      return until > nowMs ? until : 0
    },
    async record(scopeKey, kind, config, nowMs) {
      return db.transaction(() => {
        const lockedRow = selectLock.get(scopeKey)
        const lockedUntil = Number(lockedRow && lockedRow.until) || 0
        if (lockedUntil > nowMs) {
          return { locked: true, count: config.threshold, locked_until: new Date(lockedUntil).toISOString() }
        }
        const row = selectOne.get(scopeKey, kind)
        // 锁定已到期或窗口已过期：重新开始计数，避免解锁瞬间再次触发。
        const expired = row && ((row.locked_until_ms && row.locked_until_ms <= nowMs)
          || nowMs - Number(row.window_start_ms) >= config.windowMs)
        const windowStart = expired || !row ? nowMs : Number(row.window_start_ms)
        const count = expired || !row ? 1 : Number(row.count) + 1
        const until = count >= config.threshold ? nowMs + config.lockMs : null
        upsert.run(scopeKey, kind, windowStart, count, until, nowMs)
        return { locked: until != null, count,
          locked_until: until != null ? new Date(until).toISOString() : null }
      })()
    },
  }
}

// 云端持久状态：固定 RPC，数据库函数原子 upsert（多实例共享同一状态）。
export function createCloudSecurityState({ client, userId }) {
  return {
    async lockedUntil(scopeKey) {
      const r = await client.write('security', 'check', { scope_key: scopeKey }, userId)
      if (!r || r.allowed !== false) return 0
      const t = Date.parse(r.locked_until)
      return Number.isFinite(t) ? t : 0
    },
    async record(scopeKey, kind, config) {
      const r = await client.write('security', 'record', {
        scope_key: scopeKey, kind, window_ms: config.windowMs,
        threshold: config.threshold, lock_ms: config.lockMs,
      }, userId)
      return {
        locked: r && r.locked === true,
        count: r && Number(r.count) || 0,
        locked_until: r && r.locked_until ? r.locked_until : null,
      }
    },
  }
}

export function createSecurityGuard({ stateStore, auditTrail, scopeKey, config = getSecurityConfig(), now = () => Date.now() }) {
  if (!stateStore) throw new Error('安全状态存储未配置')
  const scope = String(scopeKey || 'unknown')
  async function lockedUntil() {
    if (!config.enabled) return 0
    return stateStore.lockedUntil(scope, now())
  }
  async function assertAllowed() {
    if (!config.enabled) return { allowed: true }
    const until = await lockedUntil()
    return until ? { allowed: false, locked_until: new Date(until).toISOString(), scope_key: scope } : { allowed: true }
  }
  async function record(kind, detail = {}) {
    if (!config.enabled) return { locked: false, count: 0 }
    const label = `anomaly_${String(kind).slice(0, 60)}`
    // 计数与锁定以持久状态为唯一依据；审计写入失败不能解除或绕过锁定。
    const result = await stateStore.record(scope, label, config, now())
    try {
      await auditTrail.record({
        event_id: randomUUID(), category: 'security', action: label,
        result: result.locked ? 'locked' : 'detected',
        detail: { scope_key: scope, count: result.count, ...detail },
      })
      if (result.locked) {
        await auditTrail.record({
          category: 'security', action: 'scope_locked', result: 'locked',
          detail: { scope_key: scope, locked_until: result.locked_until, reason: kind,
            count: result.count, window_ms: config.windowMs },
        })
      }
    } catch (e) {
      // 审计事件只用于可观察性；状态已落库，这里只记录脱敏错误，不改变锁定结果。
      console.error('[安全] 审计事件写入失败（锁定状态已生效）：', e && e.message ? e.message : e)
    }
    return { locked: result.locked, count: result.count, locked_until: result.locked_until, scope_key: scope }
  }
  return { scopeKey: scope, assertAllowed, record }
}

export function createModelBreaker({ threshold = 3, cooldownMs = 60000, now = () => Date.now(),
  onStateChange = null } = {}) {
  let failures = 0
  let openUntil = 0
  function snapshot() {
    return { failures, open: now() < openUntil, open_until: openUntil ? new Date(openUntil).toISOString() : null }
  }
  return {
    // 只有真正的模型调用失败才计入熔断；本地配额 / 并发 / 限流拒绝由调用方在进入前处理。
    async call(fn, args) {
      if (now() < openUntil) {
        const err = new Error('模型服务暂时熔断，请稍后重试')
        err.code = 'model_breaker'
        err.retry_after_ms = Math.max(0, openUntil - now())
        throw err
      }
      try {
        const r = await fn(args)
        if (failures !== 0 || openUntil !== 0) {
          failures = 0; openUntil = 0
          try { onStateChange?.(snapshot()) } catch { /* ignore */ }
        }
        return r
      } catch (e) {
        failures += 1
        if (failures >= threshold) {
          openUntil = now() + cooldownMs
          const err = new Error('模型服务暂时熔断，请稍后重试')
          err.code = 'model_breaker'
          err.retry_after_ms = cooldownMs
          err.cause = e
          try { onStateChange?.(snapshot()) } catch { /* ignore */ }
          throw err
        }
        throw e
      }
    },
    stats: snapshot,
  }
}
