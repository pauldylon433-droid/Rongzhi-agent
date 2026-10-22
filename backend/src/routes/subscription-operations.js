// 订阅与代扣操作路由：创建（暂停/取消/恢复操作单）/ 查看 / 确认（暂停·取消）/ 取消 / 强验证（恢复）。
// 身份与数据归属由服务端演示用户固定；客户端不能指定订阅之外的动作/风险级别/验证状态；
// 确认不接受重新指定订阅或动作，验证只接受交易密码与动态验证码。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import {
  createSubscriptionOperation, getSubscriptionOperation, confirmSubscriptionOperation,
  cancelSubscriptionOperation, SubscriptionOpError,
} from '../services/subscription-operations.js'
import { verifyAndConfirmSubscriptionResume, VerificationError } from '../services/verification.js'
import { loadVerificationKey } from '../lib/verification-key.js'
import { createRateLimiter } from '../lib/rate-limit.js'

const CONFIRM_MSG = {
  expired: '操作单已过期，未执行',
  cancelled: '操作单已取消',
  failed: '操作单校验失败，未执行',
  stale: '订阅状态已变化，该操作单已失效，未执行',
  already: '该订阅已处于目标状态，无需重复操作',
  needs_verification: '该操作需要强验证，请用交易密码与动态验证码验证后确认',
}

const CANCEL_MSG = {
  expired: '操作单已过期',
  completed: '已完成的操作单不能取消',
  failed: '该操作单已失效，不能取消',
}

const VERIFY_MSG = {
  expired: '操作单已过期，未恢复',
  cancelled: '操作单已取消，不能验证',
  completed: '操作单已完成',
  failed: '操作单校验失败，未恢复',
  stale: '订阅状态已变化，该操作单已失效，未恢复',
  already: '该订阅已是生效状态，无需重复恢复',
  pending: '该操作无需强验证，请直接确认',
}

// 强验证接口基础限流（内存态），与持久化失败计数锁定职责分开
const verifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 })

export function createSubscriptionOperationsRouter(db, demoUserId) {
  const router = Router()

  // 创建订阅操作单（暂停 / 取消 / 恢复，不改变订阅状态）
  router.post('/', (req, res) => {
    const body = req.body || {}
    const allowed = ['subscription_id', 'action']
    const extra = Object.keys(body).filter((k) => !allowed.includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)

    try {
      const op = createSubscriptionOperation(db, demoUserId, { subscriptionId: body.subscription_id, action: body.action })
      ok(res, op)
    } catch (e) {
      if (e instanceof SubscriptionOpError) return badRequest(res, e.message)
      throw e
    }
  })

  // 查看操作单
  router.get('/:refNo', (req, res) => {
    const op = getSubscriptionOperation(db, demoUserId, req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '操作单不存在' })
    ok(res, op)
  })

  // 确认并执行暂停 / 取消（要求明确确认；不接受重新指定订阅或动作）
  router.post('/:refNo/confirm', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'confirm')
    if (extra.length) return badRequest(res, `确认请求不允许提交字段：${extra.join('、')}`)
    if (body.confirm !== true) return badRequest(res, '必须明确确认（confirm: true）')

    const r = confirmSubscriptionOperation(db, demoUserId, req.params.refNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
    if (r.outcome === 'completed') return ok(res, r.op)
    return res.status(409).json({ success: false, message: CONFIRM_MSG[r.outcome] || '操作单当前状态不可确认', data: r.op })
  })

  // 取消操作单（不改变订阅状态）
  router.post('/:refNo/cancel', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)

    const r = cancelSubscriptionOperation(db, demoUserId, req.params.refNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
    if (r.outcome === 'cancelled') return ok(res, r.op)
    return res.status(409).json({ success: false, message: CANCEL_MSG[r.outcome] || '操作单当前状态不可取消', data: r.op })
  })

  // 强验证确认恢复（交易密码 + 动态验证码）：仅服务端演示用户；客户端不能指定 userId / 风险级别 / 「已验证」。
  router.post('/:refNo/verify', (req, res) => {
    const lim = verifyLimiter(demoUserId)
    if (!lim.allowed) {
      res.set('Retry-After', String(Math.ceil(lim.retryAfterMs / 1000)))
      return res.status(429).json({ success: false, message: '请求过于频繁，请稍后重试' })
    }

    const body = req.body || {}
    const allowed = ['password', 'totp']
    const extra = Object.keys(body).filter((k) => !allowed.includes(k))
    if (extra.length) return badRequest(res, `验证请求不允许提交字段：${extra.join('、')}`)
    const password = typeof body.password === 'string' ? body.password : ''
    const totp = typeof body.totp === 'string' ? body.totp : ''
    if (!password || !totp) return badRequest(res, '请提供交易密码与动态验证码')

    try {
      const r = verifyAndConfirmSubscriptionResume(
        db, demoUserId, req.params.refNo, { password, totp },
        { encryptionKey: loadVerificationKey() },
      )
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '操作单不存在' })
      if (r.outcome === 'completed') return ok(res, r.op)
      return res.status(409).json({ success: false, message: VERIFY_MSG[r.outcome] || '操作单当前状态不可验证', data: r.op })
    } catch (e) {
      if (e instanceof VerificationError) {
        const status = {
          not_bound: 409, no_key: 503, decrypt_failed: 503, locked: 423, bad_credentials: 401, code_reused: 409,
        }[e.code] || 400
        return res.status(status).json({ success: false, message: e.message, code: e.code })
      }
      throw e
    }
  })

  return router
}
