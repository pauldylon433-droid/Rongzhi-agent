// CloudBase 持久库模式 API 路由：前端契约与 SQLite 模式一致；所有业务数据来自固定 RPC。
// 写操作只发一次业务 RPC，由数据库函数在单事务内完成；读取使用只读快照并在后端做口径一致的派生计算。
import { Router } from 'express'
import { ok, badRequest, parseMonth, parsePagination } from './helpers.js'
import { loadCloudStore } from '../cloud/store.js'
import { CloudRpcError } from '../cloud/rpc-client.js'
import { verifyCredentialsCloud } from '../cloud/verification.js'
import { createCloudAuditTrail } from '../services/audit-trail.js'
import { createSecurityGuard, createCloudSecurityState, isSuspiciousError } from '../services/security-guard.js'
import { createWorkflowsRouter } from './workflows.js'
import { createWorkflowService, createCloudWorkflowStore, createCloudWorkflowOps } from '../services/workflow-plans.js'
import { securityGuardMiddleware } from './security.js'
import { createAuditRouter, auditRequestMiddleware } from './audit.js'
import { VerificationError } from '../services/verification.js'
import { AssistantError } from '../services/assistant.js'
import { loadVerificationKey } from '../lib/verification-key.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { hasAiKey, isPublicDemo, getPublicDemoConfig } from '../config.js'

const TRANSFER_CONFIRM_MSG = {
  expired: '转账单已过期，未扣款', cancelled: '转账单已取消',
  needs_verification: '本笔金额加今日已完成转账超过 1,000 元，需要强验证；本单尚未扣款，过期和未完成单不计入累计',
  failed: '转账单校验失败，未扣款',
}
const TRANSFER_CANCEL_MSG = {
  expired: '转账单已过期', completed: '已完成的转账单不能取消', failed: '该转账单已失败，不能取消',
}
const VERIFY_MSG = {
  expired: '操作单已过期，未执行', cancelled: '操作单已取消，不能验证', completed: '操作单已完成',
  failed: '操作单校验失败，未执行', pending: '该操作无需强验证，请直接确认',
  stale: '状态已变化，该操作单已失效，未执行', already: '目标状态已满足，无需重复操作',
  code_reused: '该动态验证码已在当前时间窗口内使用过，请等待下一个验证码',
}
const CARD_CONFIRM_MSG = {
  expired: '操作单已过期，未冻结', cancelled: '操作单已取消', failed: '操作单校验失败，未冻结',
  stale: '卡片状态已变化，该操作单已失效，未冻结', already: '该卡已处于冻结状态，无需重复操作',
  needs_verification: '该操作需要强验证，请用交易密码与动态验证码验证后确认',
}
const CARD_VERIFY_MSG = {
  expired: '操作单已过期，未解冻', cancelled: '操作单已取消，不能验证', completed: '操作单已完成',
  failed: '操作单校验失败，未解冻', stale: '卡片状态已变化，该操作单已失效，未解冻',
  already: '该卡已是正常状态，无需重复解冻', pending: '该操作无需强验证，请直接确认',
  code_reused: '该动态验证码已在当前时间窗口内使用过，请等待下一个验证码',
}
const SUB_CONFIRM_MSG = {
  expired: '操作单已过期，未执行', cancelled: '操作单已取消', failed: '操作单校验失败，未执行',
  stale: '订阅状态已变化，该操作单已失效，未执行', already: '该订阅已处于目标状态，无需重复操作',
  needs_verification: '该操作需要强验证，请用交易密码与动态验证码验证后确认',
}
const SUB_VERIFY_MSG = {
  expired: '操作单已过期，未恢复', cancelled: '操作单已取消，不能验证', completed: '操作单已完成',
  failed: '操作单校验失败，未恢复', stale: '订阅状态已变化，该操作单已失效，未恢复',
  already: '该订阅已是生效状态，无需重复恢复', pending: '该操作无需强验证，请直接确认',
  code_reused: '该动态验证码已在当前时间窗口内使用过，请等待下一个验证码',
}
const REPAY_VERIFY_MSG = {
  expired: '还款单已过期，未扣款', cancelled: '还款单已取消，不能验证', completed: '还款单已完成',
  failed: '还款单校验失败，未扣款', stale: '账单金额已变化，还款单已失效，请重新发起还款',
  code_reused: '该动态验证码已在当前时间窗口内使用过，请等待下一个验证码',
}
const SELECT_MSG = {
  bad_state: '当前任务状态不可选择订阅', not_found: '未找到该订阅',
  not_active: '该订阅当前不是生效状态，不能暂停', failed: '准备暂停单失败',
}
const LIFECYCLE_MSG = {
  bad_state: '当前任务状态不可执行此操作', not_found: '任务不存在', completed: '任务已完成',
  cancelled: '任务已取消', manual: '任务已转手动处理',
}

function cloudFailure(res, e, fallback = '云端数据库暂不可用，请稍后重试') {
  if (e instanceof CloudRpcError) {
    if (e.sqlState === '22023') return badRequest(res, e.message || '参数不合法')
    console.error('[CloudBase] RPC 失败：', e.rawCode || e.status || 'network', e.message)
    return res.status(503).json({ success: false, message: fallback })
  }
  if (e instanceof VerificationError) {
    // 业务交易凭据错误不能再次触发浏览器 Basic Auth 挑战；仅网站访问认证使用 401。
    const status = { not_bound: 409, no_key: 503, decrypt_failed: 503, locked: 423,
      bad_credentials: isPublicDemo() ? 403 : 401, code_reused: 409 }[e.code] || 400
    return res.status(status).json({ success: false, message: e.message, code: e.code })
  }
  throw e
}

export function createCloudRouter({ client, demoUserId, assistant = null }) {
  const router = Router()
  const verifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 })
  const publicDemo = isPublicDemo()
  const publicCfg = getPublicDemoConfig()
  const chatLimiter = publicDemo && publicCfg.aiEnabled
    ? createRateLimiter({ windowMs: 60 * 1000, max: publicCfg.aiRateLimitPerMin })
    : null

  const load = () => loadCloudStore({ client, userId: demoUserId })
  const auditTrail = createCloudAuditTrail({ client, userId: demoUserId })
  const workflowService = createWorkflowService({
    store: createCloudWorkflowStore({ client, userId: demoUserId }),
    ops: createCloudWorkflowOps({ client, userId: demoUserId }), audit: auditTrail,
  })
  // 先请求上下文 / 审计、再安全检查、最后业务路由：/workflows 与其它敏感写入口保护一致。
  const securityState = createCloudSecurityState({ client, userId: demoUserId })
  router.use(auditRequestMiddleware(auditTrail))
  router.use(securityGuardMiddleware((scope) => createSecurityGuard({
    stateStore: securityState, auditTrail, scopeKey: scope,
  })))
  router.use('/workflows', createWorkflowsRouter(workflowService))
  const write = (domain, op, payload = {}) => client.write(domain, op, payload, demoUserId)

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  // —— 受保护审计时间线：按数据库条件过滤 / 分页（不依赖快照最近 2000 条）——
  router.use('/audit', createAuditRouter((filters) => auditTrail.query(filters)))

  // —— 只读：账户 / 流水 / 银行卡 / 订阅 / 统计 ——
  router.get('/accounts', wrap(async (req, res) => {
    ok(res, (await load()).accounts())
  }))

  router.get('/transactions', wrap(async (req, res) => {
    let month
    if (req.query.month !== undefined) {
      month = parseMonth(req.query.month)
      if (!month) return badRequest(res, 'month 参数格式应为 YYYY-MM（月份 01-12）')
    }
    let status
    if (req.query.status !== undefined) {
      if (typeof req.query.status !== 'string' || !['posted', 'pending'].includes(req.query.status)) {
        return badRequest(res, 'status 仅支持 posted / pending')
      }
      status = req.query.status
    } else if (req.query['status[]'] !== undefined) {
      return badRequest(res, 'status 仅支持 posted / pending')
    }
    let accountId
    if (req.query.account_id !== undefined) {
      if (typeof req.query.account_id !== 'string' || !/^\d+$/.test(req.query.account_id) || Number(req.query.account_id) < 1) {
        return badRequest(res, 'account_id 必须是正整数')
      }
      accountId = Number(req.query.account_id)
    }
    const pg = parsePagination(req.query)
    if (pg.error) return badRequest(res, pg.error)
    try {
      const { rows, total } = (await load()).transactions({ month, status, accountId, limit: pg.limit, offset: pg.offset })
      ok(res, rows, { total, limit: pg.limit, offset: pg.offset })
    } catch (e) { return cloudFailure(res, e) }
  }))

  router.get('/cards', wrap(async (req, res) => { ok(res, (await load()).cards()) }))
  router.get('/subscriptions', wrap(async (req, res) => { ok(res, (await load()).subscriptions()) }))

  router.get('/analytics/monthly', wrap(async (req, res) => {
    if (req.query.month === undefined) return badRequest(res, 'month 参数必填，格式为 YYYY-MM')
    const month = parseMonth(req.query.month)
    if (!month) return badRequest(res, 'month 参数格式应为 YYYY-MM（月份 01-12）')
    let accountId
    if (req.query.account_id !== undefined) {
      if (typeof req.query.account_id !== 'string' || !/^\d+$/.test(req.query.account_id) || Number(req.query.account_id) < 1) {
        return badRequest(res, 'account_id 必须是正整数')
      }
      accountId = Number(req.query.account_id)
    }
    try {
      const asOf = new Date().toISOString()
      ok(res, (await load()).analytics({ ...month, asOf, accountId }))
    } catch (e) { return cloudFailure(res, e) }
  }))

  router.get('/activity', wrap(async (req, res) => {
    const VALID = ['transfer', 'card_op', 'subscription_op', 'repayment', 'task']
    const { type, status } = req.query
    if (type !== undefined && (typeof type !== 'string' || !VALID.includes(type))) {
      return badRequest(res, `type 仅支持：${VALID.join('、')}`)
    }
    if (status !== undefined && typeof status !== 'string') return badRequest(res, 'status 必须为字符串')
    const pg = parsePagination(req.query)
    if (pg.error) return badRequest(res, pg.error)
    try {
      await write('task', 'reconcile_all', {})
      const { rows, total } = (await load()).activity({ type: type || null, status: status || null, limit: pg.limit, offset: pg.offset })
      ok(res, rows, { total, limit: pg.limit, offset: pg.offset })
    } catch (e) { return cloudFailure(res, e) }
  }))

  // —— 强验证状态 ——
  router.get('/verification/status', wrap(async (req, res) => {
    ok(res, (await load()).verificationStatus())
  }))

  // —— 转账 ——
  router.get('/transfers/recipients', wrap(async (req, res) => {
    const store = await load()
    ok(res, (store.snapshot.transfer_recipients || []).map((r) => ({ id: r.id, name: r.name, masked_account: r.masked_account })))
  }))

  router.post('/transfers', wrap(async (req, res) => {
    const body = req.body || {}
    const allowed = ['recipient_id', 'amount_cents', 'remark', 'from_account_id']
    const extra = Object.keys(body).filter((k) => !allowed.includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    if (body.from_account_id === undefined || body.from_account_id === null) return badRequest(res, '请选择付款账户（from_account_id）')
    try {
      const r = await write('transfer', 'create', body)
      const store = await load()
      ok(res, store.transferOp(r.ref_no))
    } catch (e) { return cloudFailure(res, e, '创建转账单失败') }
  }))

  router.get('/transfers/:refNo', wrap(async (req, res) => {
    const op = (await load()).transferOp(req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '转账单不存在' })
    ok(res, op)
  }))

  router.post('/transfers/:refNo/confirm', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'confirm')
    if (extra.length) return badRequest(res, `确认请求不允许提交字段：${extra.join('、')}`)
    if (body.confirm !== true) return badRequest(res, '必须明确确认（confirm: true）')
    try {
      const r = await write('transfer', 'confirm', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
      const store = await load()
      const view = store.transferOp(req.params.refNo)
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: TRANSFER_CONFIRM_MSG[r.outcome] || '转账单当前状态不可确认', data: view })
    } catch (e) { return cloudFailure(res, e, '确认转账失败') }
  }))

  router.post('/transfers/:refNo/cancel', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('transfer', 'cancel', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
      const view = (await load()).transferOp(req.params.refNo)
      if (r.outcome === 'cancelled') return ok(res, view)
      return res.status(409).json({ success: false, message: TRANSFER_CANCEL_MSG[r.outcome] || '转账单当前状态不可取消', data: view })
    } catch (e) { return cloudFailure(res, e, '取消转账失败') }
  }))

  router.post('/transfers/:refNo/verify', wrap(async (req, res) => {
    // 转账验证视图与其他域一致，单独实现以返回完整操作单
    const lim = verifyLimiter(String(demoUserId))
    if (!lim.allowed) {
      res.set('Retry-After', String(Math.ceil(lim.retryAfterMs / 1000)))
      return res.status(429).json({ success: false, message: '请求过于频繁，请稍后重试' })
    }
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['password', 'totp'].includes(k))
    if (extra.length) return badRequest(res, `验证请求不允许提交字段：${extra.join('、')}`)
    const password = typeof body.password === 'string' ? body.password : ''
    const totp = typeof body.totp === 'string' ? body.totp : ''
    if (!password || !totp) return badRequest(res, '请提供交易密码与动态验证码')
    try {
      const { matchedStep } = await verifyCredentialsCloud({ client, userId: demoUserId, password, totp, encryptionKey: loadVerificationKey() })
      const r = await write('transfer', 'verify', { ref_no: req.params.refNo, matched_step: matchedStep })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
      const view = (await load()).transferOp(req.params.refNo)
      if (r.outcome === 'locked') return res.status(423).json({ success: false, code: 'locked', message: '强验证已锁定，请稍后重试', locked_until: r.locked_until, data: view })
      if (r.outcome === 'code_reused') return res.status(409).json({ success: false, code: 'code_reused', message: VERIFY_MSG.code_reused, data: view })
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: VERIFY_MSG[r.outcome] || '转账单当前状态不可验证', data: view })
    } catch (e) { return cloudFailure(res, e, '强验证执行失败') }
  }))

  // —— 银行卡操作 ——
  router.post('/card-operations', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['card_id', 'action'].includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('card', 'create', body)
      ok(res, (await load()).cardOpByRef(r.ref_no))
    } catch (e) { return cloudFailure(res, e, '创建银行卡操作单失败') }
  }))
  router.get('/card-operations/:refNo', wrap(async (req, res) => {
    const op = (await load()).cardOpByRef(req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '操作单不存在' })
    ok(res, op)
  }))
  router.post('/card-operations/:refNo/confirm', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'confirm')
    if (extra.length) return badRequest(res, `确认请求不允许提交字段：${extra.join('、')}`)
    if (body.confirm !== true) return badRequest(res, '必须明确确认（confirm: true）')
    try {
      const r = await write('card', 'confirm', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).cardOpByRef(req.params.refNo)
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: CARD_CONFIRM_MSG[r.outcome] || '操作单当前状态不可确认', data: view })
    } catch (e) { return cloudFailure(res, e, '确认银行卡操作失败') }
  }))
  router.post('/card-operations/:refNo/cancel', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('card', 'cancel', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).cardOpByRef(req.params.refNo)
      if (r.outcome === 'cancelled') return ok(res, view)
      return res.status(409).json({ success: false, message: CARD_CONFIRM_MSG[r.outcome] || '操作单当前状态不可取消', data: view })
    } catch (e) { return cloudFailure(res, e, '取消银行卡操作失败') }
  }))
  router.post('/card-operations/:refNo/verify', wrap(async (req, res) => {
    const lim = verifyLimiter(String(demoUserId))
    if (!lim.allowed) {
      res.set('Retry-After', String(Math.ceil(lim.retryAfterMs / 1000)))
      return res.status(429).json({ success: false, message: '请求过于频繁，请稍后重试' })
    }
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['password', 'totp'].includes(k))
    if (extra.length) return badRequest(res, `验证请求不允许提交字段：${extra.join('、')}`)
    const password = typeof body.password === 'string' ? body.password : ''
    const totp = typeof body.totp === 'string' ? body.totp : ''
    if (!password || !totp) return badRequest(res, '请提供交易密码与动态验证码')
    try {
      const { matchedStep } = await verifyCredentialsCloud({ client, userId: demoUserId, password, totp, encryptionKey: loadVerificationKey() })
      const r = await write('card', 'verify', { ref_no: req.params.refNo, matched_step: matchedStep })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).cardOpByRef(req.params.refNo)
      if (r.outcome === 'locked') return res.status(423).json({ success: false, code: 'locked', message: '强验证已锁定，请稍后重试', locked_until: r.locked_until, data: view })
      if (r.outcome === 'code_reused') return res.status(409).json({ success: false, code: 'code_reused', message: VERIFY_MSG.code_reused, data: view })
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: r.reason || CARD_VERIFY_MSG[r.outcome] || '操作单当前状态不可验证', data: view })
    } catch (e) { return cloudFailure(res, e, '强验证执行失败') }
  }))

  // —— 订阅操作 ——
  router.post('/subscription-operations', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['subscription_id', 'action', 'to_account_id'].includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('subscription', 'create', body)
      ok(res, (await load()).subscriptionOpByRef(r.ref_no))
    } catch (e) { return cloudFailure(res, e, '创建订阅操作单失败') }
  }))
  router.get('/subscription-operations/:refNo', wrap(async (req, res) => {
    const op = (await load()).subscriptionOpByRef(req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '操作单不存在' })
    ok(res, op)
  }))
  router.post('/subscription-operations/:refNo/confirm', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'confirm')
    if (extra.length) return badRequest(res, `确认请求不允许提交字段：${extra.join('、')}`)
    if (body.confirm !== true) return badRequest(res, '必须明确确认（confirm: true）')
    try {
      const r = await write('subscription', 'confirm', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).subscriptionOpByRef(req.params.refNo)
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: r.reason || SUB_CONFIRM_MSG[r.outcome] || '操作单当前状态不可确认', data: view })
    } catch (e) { return cloudFailure(res, e, '确认订阅操作失败') }
  }))
  router.post('/subscription-operations/:refNo/cancel', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('subscription', 'cancel', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).subscriptionOpByRef(req.params.refNo)
      if (r.outcome === 'cancelled') return ok(res, view)
      return res.status(409).json({ success: false, message: SUB_CONFIRM_MSG[r.outcome] || '操作单当前状态不可取消', data: view })
    } catch (e) { return cloudFailure(res, e, '取消订阅操作失败') }
  }))
  router.post('/subscription-operations/:refNo/verify', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['password', 'totp'].includes(k))
    if (extra.length) return badRequest(res, `验证请求不允许提交字段：${extra.join('、')}`)
    const password = typeof body.password === 'string' ? body.password : ''
    const totp = typeof body.totp === 'string' ? body.totp : ''
    if (!password || !totp) return badRequest(res, '请提供交易密码与动态验证码')
    try {
      const { matchedStep } = await verifyCredentialsCloud({ client, userId: demoUserId, password, totp, encryptionKey: loadVerificationKey() })
      const r = await write('subscription', 'verify', { ref_no: req.params.refNo, matched_step: matchedStep })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      const view = (await load()).subscriptionOpByRef(req.params.refNo)
      if (r.outcome === 'locked') return res.status(423).json({ success: false, code: 'locked', message: '强验证已锁定，请稍后重试', locked_until: r.locked_until, data: view })
      if (r.outcome === 'code_reused') return res.status(409).json({ success: false, code: 'code_reused', message: VERIFY_MSG.code_reused, data: view })
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: r.reason || SUB_VERIFY_MSG[r.outcome] || '操作单当前状态不可验证', data: view })
    } catch (e) { return cloudFailure(res, e, '强验证执行失败') }
  }))

  // —— 信用卡还款 ——
  router.post('/repayments', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['statement_id', 'from_account_id', 'scope', 'credit_account_id'].includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    const scope = body.scope === undefined ? 'statement' : body.scope
    if (!['statement', 'all_posted'].includes(scope)) return badRequest(res, 'scope 仅支持 statement / all_posted')
    if (scope === 'statement' && body.statement_id === undefined) return badRequest(res, '请提供账单编号（statement_id）')
    if (scope === 'all_posted' && body.statement_id !== undefined) return badRequest(res, '全部结清模式不接受账单编号（statement_id）')
    try {
      const r = await write('repayment', 'create', { ...body, scope })
      ok(res, (await load()).repaymentByRef(r.ref_no))
    } catch (e) { return cloudFailure(res, e, '创建还款单失败') }
  }))
  router.get('/repayments/:refNo', wrap(async (req, res) => {
    const op = (await load()).repaymentByRef(req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '还款单不存在' })
    ok(res, op)
  }))
  router.post('/repayments/:refNo/cancel', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)
    try {
      const r = await write('repayment', 'cancel', { ref_no: req.params.refNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '还款单不存在' })
      const view = (await load()).repaymentByRef(req.params.refNo)
      if (r.outcome === 'cancelled') return ok(res, view)
      return res.status(409).json({ success: false, message: REPAY_VERIFY_MSG[r.outcome] || '还款单当前状态不可取消', data: view })
    } catch (e) { return cloudFailure(res, e, '取消还款单失败') }
  }))
  router.post('/repayments/:refNo/verify', wrap(async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['password', 'totp'].includes(k))
    if (extra.length) return badRequest(res, `验证请求不允许提交字段：${extra.join('、')}`)
    const password = typeof body.password === 'string' ? body.password : ''
    const totp = typeof body.totp === 'string' ? body.totp : ''
    if (!password || !totp) return badRequest(res, '请提供交易密码与动态验证码')
    try {
      const { matchedStep } = await verifyCredentialsCloud({ client, userId: demoUserId, password, totp, encryptionKey: loadVerificationKey() })
      const r = await write('repayment', 'verify', { ref_no: req.params.refNo, matched_step: matchedStep })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '还款单不存在' })
      const view = (await load()).repaymentByRef(req.params.refNo)
      if (r.outcome === 'locked') return res.status(423).json({ success: false, code: 'locked', message: '强验证已锁定，请稍后重试', locked_until: r.locked_until, data: view })
      if (r.outcome === 'code_reused') return res.status(409).json({ success: false, code: 'code_reused', message: VERIFY_MSG.code_reused, data: view })
      if (r.outcome === 'completed') return ok(res, view)
      return res.status(409).json({ success: false, message: r.reason || REPAY_VERIFY_MSG[r.outcome] || '还款单当前状态不可验证', data: view })
    } catch (e) { return cloudFailure(res, e, '强验证执行失败') }
  }))

  // —— 信用卡查询 ——
  router.get('/credit/accounts', wrap(async (req, res) => { ok(res, (await load()).creditAccounts()) }))
  router.get('/credit/accounts/:id', wrap(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) return badRequest(res, '信用账户 id 不合法')
    const found = (await load()).creditAccounts().find((c) => c.id === id)
    if (!found) return res.status(404).json({ success: false, message: '信用账户不存在' })
    ok(res, found)
  }))
  router.get('/credit/accounts/:id/statements', wrap(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) return badRequest(res, '信用账户 id 不合法')
    const store = await load()
    if (!store.creditAccounts().some((c) => c.id === id)) return res.status(404).json({ success: false, message: '信用账户不存在' })
    ok(res, store.statements(id))
  }))
  router.get('/credit/statements/:statementId', wrap(async (req, res) => {
    const id = Number(req.params.statementId)
    if (!Number.isSafeInteger(id) || id <= 0) return badRequest(res, '账单 id 不合法')
    const detail = (await load()).statementDetail(id)
    if (!detail) return res.status(404).json({ success: false, message: '账单不存在' })
    ok(res, detail)
  }))

  // —— 助手会话（AI 默认关闭；会话读取 / 切换不调用模型）——
  router.post('/assistant/chat', wrap(async (req, res) => {
    if (publicDemo && !publicCfg.aiEnabled) {
      return res.status(503).json({ success: false, message: '公网演示环境未开启 AI 助手；查询与手动操作仍可使用' })
    }
    if (!hasAiKey() && !assistant) {
      return res.status(503).json({ success: false, message: 'AI 助手尚未配置模型密钥，请在环境变量配置后重启后端' })
    }
    if (!assistant) {
      return res.status(503).json({ success: false, message: '云端 AI 助手未启用；查询与手动操作仍可使用' })
    }
    if (chatLimiter) {
      const lim = chatLimiter(req.ip || 'unknown')
      if (!lim.allowed) {
        res.set('Retry-After', String(Math.ceil(lim.retryAfterMs / 1000)))
        return res.status(429).json({ success: false, message: 'AI 请求过于频繁，请稍后重试' })
      }
    }
    const body = req.body || {}
    const forbidden = Object.keys(body).filter((k) => !['message', 'sessionId', 'selectedCardId'].includes(k))
    if (forbidden.length) {
      return badRequest(res, `不允许提交字段：${forbidden.join('、')}（客户端只能提交 message、sessionId 与 selectedCardId）`)
    }
    if (typeof body.message !== 'string' || body.message.trim() === '') return badRequest(res, 'message 不能为空')
    if (body.message.length > 2000) return badRequest(res, 'message 过长（最多 2000 字符）')
    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return badRequest(res, 'sessionId 必须是字符串')
    if (typeof body.sessionId === 'string' && body.sessionId.trim() === '') return badRequest(res, 'sessionId 不能是空白字符串')
    if (body.selectedCardId !== undefined && body.selectedCardId !== null) {
      if (typeof body.selectedCardId !== 'number' || !Number.isSafeInteger(body.selectedCardId) || body.selectedCardId <= 0) {
        return badRequest(res, 'selectedCardId 必须是正整数')
      }
    }
    try {
      const result = await assistant.chat({
        message: body.message.trim(),
        sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined,
        selectedCardId: typeof body.selectedCardId === 'number' ? body.selectedCardId : null,
        requestId: res.locals.requestId,
      })
      const suspicious = (result.toolRecords || []).filter((t) => t.status === 'error' && isSuspiciousError(t.error))
      if (suspicious.length && req.securityGuard) {
        let locked = false
        for (const t of suspicious) {
          const rr = await req.securityGuard.record('invalid_tool', { tool: t.name, error: String(t.error).slice(0, 120) })
          if (rr.locked) locked = true
        }
        if (locked) res.setHeader('X-Security-Lock', '1')
      }
      ok(res, result)
    } catch (e) {
      if (e instanceof AssistantError) {
        if (e.code === 'locked') return res.status(409).json({ success: false, message: e.message })
        if (e.code === 'bad_card') return res.status(400).json({ success: false, message: e.message })
        if (e.code === 'credential_detected') return res.status(400).json({ success: false, code: 'credential_detected', message: e.message })
        if (e.code === 'ai_quota') return res.status(429).json({ success: false, message: e.message })
        if (e.code === 'model') {
          console.error('[助手] 模型调用失败（脱敏）：', e.message)
          return res.status(502).json({ success: false, message: '模型服务暂不可用，请稍后重试' })
        }
        if (e.code === 'breaker') {
          if (e.retry_after_ms) res.set('Retry-After', String(Math.ceil(e.retry_after_ms / 1000)))
          return res.status(503).json({ success: false, code: 'model_breaker', message: '模型服务暂时熔断，请稍后重试' })
        }
      }
      console.error('[助手] 未预期错误：', e && e.message ? e.message : e)
      return res.status(500).json({ success: false, message: '助手服务内部错误' })
    }
  }))
  router.get('/assistant/current', wrap(async (req, res) => { ok(res, (await load()).currentConversation()) }))
  router.get('/assistant/conversations', wrap(async (req, res) => { ok(res, (await load()).listConversations()) }))
  router.post('/assistant/conversations/:id/select', wrap(async (req, res) => {
    const r = await write('chat', 'select', { session_id: req.params.id })
    if (r.outcome === 'not_found') return badRequest(res, '会话不存在或已失效')
    ok(res, (await load()).conversation(req.params.id))
  }))
  router.post('/assistant/new', wrap(async (req, res) => {
    await write('chat', 'new', {})
    ok(res, { sessionId: null })
  }))

  // —— 跨场景任务 ——
  router.get('/agent-tasks/recent', wrap(async (req, res) => {
    try {
      await write('task', 'reconcile_all', {})
      ok(res, (await load()).recentTasks())
    } catch (e) { return cloudFailure(res, e, '读取最近任务失败') }
  }))
  router.get('/agent-tasks/:taskNo', wrap(async (req, res) => {
    try {
      const r = await write('task', 'reconcile', { task_no: req.params.taskNo })
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
      const task = (await load()).taskByNo(req.params.taskNo)
      if (!task) return res.status(404).json({ success: false, message: '任务不存在' })
      ok(res, task)
    } catch (e) { return cloudFailure(res, e, '读取任务失败') }
  }))
  for (const [route, op] of [['select', 'select'], ['pause', 'pause'], ['resume', 'resume'], ['cancel', 'cancel'], ['manual', 'manual']]) {
    router.post(`/agent-tasks/:taskNo/${route}`, wrap(async (req, res) => {
      const body = req.body || {}
      const allowed = op === 'select' ? ['subscription_id'] : []
      const extra = Object.keys(body).filter((k) => !allowed.includes(k))
      if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
      const payload = { task_no: req.params.taskNo }
      if (op === 'select') payload.subscription_id = body.subscription_id
      try {
        const r = await write('task', op, payload)
        if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: op === 'select' ? '任务不存在' : LIFECYCLE_MSG.not_found })
        if (op === 'select') {
          if (r.outcome === 'selected') return ok(res, (await load()).taskByNo(req.params.taskNo))
          return res.status(409).json({ success: false, message: SELECT_MSG[r.outcome] || '当前状态不可选择订阅', data: (await load()).taskByNo(req.params.taskNo) })
        }
        if (['paused', 'completed', 'waiting_selection', 'waiting_confirmation', 'cancelled', 'manual'].includes(r.outcome)) {
          return ok(res, (await load()).taskByNo(req.params.taskNo))
        }
        return res.status(409).json({ success: false, message: LIFECYCLE_MSG[r.outcome] || '当前状态不可执行此操作', data: (await load()).taskByNo(req.params.taskNo) })
      } catch (e) { return cloudFailure(res, e, '任务操作失败') }
    }))
  }

  return router
}
