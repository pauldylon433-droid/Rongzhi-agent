// 结构化审计时间线：请求 / 会话 / 计划 / 工具 / 操作单 / 回执关联。
// 只记录可观察的业务决策与结果，不记录模型思维链；密码、验证码、种子、API Key、
// 加密密钥、哈希盐等一律脱敏；模型生成的沙箱代码只记录长度与 SHA-256，不落原文。
import { createHash, randomUUID } from 'node:crypto'

const SECRET_KEY = /(password|passwd|totp|secret|api[_-]?key|access[_-]?key|authorization|credential|salt|hash|token)/i
const SENSITIVE_KEY = /(card_number|masked_card_number|account_number|id_card|phone|email)/i

// 不依赖键名的自由文本脱敏：常见的密钥格式与「标签 = 值」写法直接替换。
// 这不是「识别所有任意秘密」的承诺，只是对已知敏感模式的显式清理。
const TEXT_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED:api-key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, '[REDACTED:access-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/((?:api[ _-]?key|access[ _-]?key|secret|token|password|passwd|密码|口令|验证码|动态码|totp|种子)(?:[^\S\r\n]{0,6})(?::|：|=|是|为|is)(?:[^\S\r\n]{0,6}))([^\s,，;；。]{3,})/gi,
    '$1[REDACTED]'],
]

export function scrubFreeText(text) {
  let out = String(text)
  for (const [re, replacement] of TEXT_PATTERNS) out = out.replace(re, replacement)
  return out
}

function sanitizeValue(value, key = '', depth = 0) {
  if (depth > 4) return '[depth-limit]'
  if (value == null) return value
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '[REDACTED]'
    if (key === 'code') {
      return `[sandbox-code sha256=${createHash('sha256').update(value).digest('hex')} chars=${value.length}]`
    }
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
    const scrubbed = scrubFreeText(value)
    return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, key, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = '[REDACTED]'
      else out[k] = sanitizeValue(v, k, depth + 1)
    }
    return out
  }
  return String(value)
}

export function sanitizeDetail(detail) {
  return sanitizeValue(detail && typeof detail === 'object' ? detail : {})
}

function normalizeEvent(userId, event) {
  return {
    event_id: typeof event.event_id === 'string' && event.event_id ? event.event_id : randomUUID(),
    user_id: userId,
    request_id: event.request_id || null,
    session_id: event.session_id || null,
    plan_id: event.plan_id || null,
    tool_call_id: event.tool_call_id || null,
    operation_ref: event.operation_ref || null,
    category: String(event.category || 'general').slice(0, 60),
    action: String(event.action || 'event').slice(0, 120),
    result: event.result == null ? null : String(event.result).slice(0, 60),
    risk_level: event.risk_level == null ? null : String(event.risk_level).slice(0, 20),
    detail: sanitizeDetail(event.detail),
  }
}

// 本地 SQLite 实现。record 为 async 以与 CloudBase 适配层保持同一接口。
export function createAuditTrail(db) {
  const insert = db.prepare(
    `INSERT INTO audit_events
      (event_id, user_id, request_id, session_id, plan_id, tool_call_id, operation_ref,
       category, action, result, risk_level, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertFailure = db.prepare(
    `INSERT INTO audit_trace_failures (request_id, payload_json, error, attempts, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  return {
    // 异步请求追踪写入失败时的可核查补偿记录（本地库）。不改变业务事务。
    async recordFailure(event, error, attempts = 1) {
      const e = normalizeEvent(event && event.user_id, event || {})
      insertFailure.run(
        e.request_id || null, JSON.stringify(e, (k, v) => (k === 'detail' ? sanitizeDetail(v) : v)),
        String(error && error.message ? error.message : error).slice(0, 500), attempts,
        new Date().toISOString(),
      )
    },
    async record(event) {
      const e = normalizeEvent(event.user_id, event)
      const createdAt = new Date().toISOString()
      insert.run(
        e.event_id, e.user_id, e.request_id, e.session_id, e.plan_id, e.tool_call_id, e.operation_ref,
        e.category, e.action, e.result, e.risk_level, JSON.stringify(e.detail), createdAt,
      )
      return { ...e, created_at: createdAt }
    },
    list({ event_id, request_id, session_id, plan_id, operation_ref, tool_call_id, category, status, limit = 100, offset = 0 } = {}) {
      const where = []
      const params = []
      if (event_id) { where.push('event_id = ?'); params.push(event_id) }
      if (tool_call_id) { where.push('tool_call_id = ?'); params.push(tool_call_id) }
      if (request_id) { where.push('request_id = ?'); params.push(request_id) }
      if (session_id) { where.push('session_id = ?'); params.push(session_id) }
      if (plan_id) { where.push('plan_id = ?'); params.push(plan_id) }
      if (operation_ref) { where.push('operation_ref = ?'); params.push(operation_ref) }
      if (category) { where.push('category = ?'); params.push(category) }
      if (status) { where.push('result = ?'); params.push(status) }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const rows = db.prepare(
        `SELECT event_id, user_id, request_id, session_id, plan_id, tool_call_id, operation_ref,
                category, action, result, risk_level, detail_json, created_at
           FROM audit_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ).all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0))
      return rows.map((r) => {
        let detail = {}
        try { detail = JSON.parse(r.detail_json || '{}') } catch { detail = {} }
        const { detail_json, ...rest } = r
        return { ...rest, detail }
      })
    },
  }
}

// CloudBase 实现：固定 RPC audit/event；读取使用按条件的 audit/query RPC（不再依赖快照最近 2000 条）。
export function createCloudAuditTrail({ client, userId }) {
  return {
    async query(filters = {}) {
      const r = await client.queryAudit(filters, userId)
      return (r && Array.isArray(r.rows)) ? r.rows : []
    },
    // 云端没有独立的本地文件可写：补偿写入一条独立的追踪失败审计事件；
    // 若审计通道本身不可用，只能记录脱敏日志（见调用方）。
    async recordFailure(event, error, attempts = 1) {
      const e = normalizeEvent(userId, event || {})
      await client.write('audit', 'event', {
        request_id: e.request_id, session_id: e.session_id,
        category: 'audit_trace', action: 'write_failed', result: 'error',
        detail: { attempts, error: String(error && error.message ? error.message : error).slice(0, 200),
          original_action: e.action, original_category: e.category },
      }, userId)
    },
    async record(event) {
      const e = normalizeEvent(userId, event)
      await client.write('audit', 'event', {
        event_id: e.event_id,
        request_id: e.request_id,
        session_id: e.session_id,
        plan_id: e.plan_id,
        tool_call_id: e.tool_call_id,
        operation_ref: e.operation_ref,
        category: e.category,
        action: e.action,
        result: e.result,
        risk_level: e.risk_level,
        detail: e.detail,
        created_at: new Date().toISOString(),
      }, userId)
      return e
    },
  }
}

export function newRequestId() {
  return randomUUID()
}
