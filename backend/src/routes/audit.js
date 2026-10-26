// 受保护的审计时间线查询 / 导出。
// 默认不暴露：未配置 AUDIT_ACCESS_TOKEN 时返回 404；配置后必须携带
// Authorization: Bearer <AUDIT_ACCESS_TOKEN> 或 X-Audit-Token。
// 不输出任何密码、验证码、TOTP 种子、API Key 或加密主密钥。
import { Router } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { ok, badRequest, parsePagination } from './helpers.js'
import { newRequestId } from '../services/audit-trail.js'

function digest(v) {
  return createHash('sha256').update(String(v)).digest()
}
function tokenOk(req) {
  const expected = process.env.AUDIT_ACCESS_TOKEN
  if (!expected) return null
  const header = String(req.headers.authorization || '')
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] || String(req.headers['x-audit-token'] || '')
  if (!bearer) return false
  return timingSafeEqual(digest(bearer), digest(expected))
}
function requireAuditAccess(req, res, next) {
  const result = tokenOk(req)
  if (result === null) return res.status(404).json({ success: false, message: '接口不存在' })
  if (!result) return res.status(401).json({ success: false, message: '审计访问令牌无效' })
  return next()
}

function parseFilters(req) {
  const filters = {}
  for (const key of ['event_id', 'request_id', 'session_id', 'plan_id', 'operation_ref', 'tool_call_id', 'category', 'status']) {
    const v = req.query[key]
    if (v !== undefined) {
      if (typeof v !== 'string' || v.length > 120) return { error: `${key} 参数不合法` }
      filters[key] = v
    }
  }
  const pg = parsePagination(req.query)
  if (pg.error) return { error: pg.error }
  return { filters: { ...filters, limit: pg.limit, offset: pg.offset } }
}

export function createAuditRouter(source) {
  const list = typeof source === 'function' ? source : (filters) => source.list(filters)
  const router = Router()
  router.use(requireAuditAccess)
  router.get('/timeline', async (req, res) => {
    const parsed = parseFilters(req)
    if (parsed.error) return badRequest(res, parsed.error)
    const rows = await list(parsed.filters)
    ok(res, rows, { count: rows.length, limit: parsed.filters.limit, offset: parsed.filters.offset })
  })
  router.get('/export', async (req, res) => {
    const parsed = parseFilters(req)
    if (parsed.error) return badRequest(res, parsed.error)
    const rows = await list({ ...parsed.filters, limit: 500, offset: 0 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    res.set('Content-Disposition', `attachment; filename="audit-timeline-${stamp}.json"`)
    res.set('Content-Type', 'application/json; charset=utf-8')
    res.send(JSON.stringify({
      exported_at: new Date().toISOString(),
      note: '审计导出仅含可观察业务决策；密码、验证码、种子与密钥已脱敏。',
      filters: { ...parsed.filters, limit: 500, offset: 0 },
      events: rows,
    }, null, 2))
  })
  return router
}

// 可恢复的请求追踪：失败重试一次；仍失败则写入可核查的失败记录（本地表 / 云端独立审计事件）。
export async function recordTracedEvent(trail, event) {
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await trail.record(event); return true } catch (e) { last = e }
  }
  try {
    if (typeof trail.recordFailure === 'function') await trail.recordFailure(event, last, 2)
  } catch (e) {
    console.error('[审计] 请求追踪失败补偿记录也失败：', e && e.message ? e.message : e)
  }
  console.error('[审计] 请求追踪写入失败（重试 2 次）：', last && last.message ? last.message : last)
  return false
}

// Express 中间件：为状态变更请求记录请求级审计；不读取 / 记录请求体中的凭据。
export function auditRequestMiddleware(trail) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
    const id = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 120
      ? req.headers['x-request-id']
      : newRequestId()
    res.locals.requestId = id
    res.setHeader('X-Request-Id', id)
    const started = Date.now()
    res.on('finish', () => {
      const sid = req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : null
      const opRef = req.params?.refNo || req.params?.taskNo || null
      recordTracedEvent(trail, {
        request_id: id || null, session_id: sid, operation_ref: opRef,
        category: 'api', action: `${req.method} ${(req.baseUrl + req.path).replace(/\/+$/, '') || '/'}`,
        result: String(res.statusCode),
        detail: { status_code: res.statusCode, duration_ms: Date.now() - started },
      }).catch((e) => console.error('[审计] 请求事件写入失败：', e && e.message ? e.message : e))
    })
    return next()
  }
}
