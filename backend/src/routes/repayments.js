// 信用卡还款路由：创建（还款准备）/ 查看 / 取消 / 强验证确认（交易密码 + 动态验证码）。
// 还款恒为红色强验证（无黄色普通确认）：全部还款均需显式确认 + 交易密码 + TOTP，不开放「跳过验证」。
// 身份与归属由服务端演示用户固定；客户端不能指定付款账户 / 账单之外的字段；确认时不接受重新指定金额或账单。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import {
  createRepaymentOperation, getRepaymentOperation, cancelRepaymentOperation, CreditError,
} from '../services/credit.js'
import { verifyAndConfirmRepayment, VerificationError } from '../services/verification.js'
import { loadVerificationKey } from '../lib/verification-key.js'
import { createRateLimiter } from '../lib/rate-limit.js'

const VERIFY_MSG = {
  expired: '还款单已过期，未扣款',
  cancelled: '还款单已取消，不能验证',
  completed: '还款单已完成',
  failed: '还款单校验失败，未扣款',
  stale: '账单金额已变化，还款单已失效，请重新发起还款',
}

const CANCEL_MSG = {
  expired: '还款单已过期',
  completed: '已完成的还款单不能取消',
  failed: '该还款单已失效，不能取消',
}

// 强验证接口基础限流（内存态），与持久化失败计数锁定职责分开
const verifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 })

export function createRepaymentsRouter(db, demoUserId) {
  const router = Router()

  // 创建还款操作单（还款准备：指定已出账账单 + 付款活期账户；不扣款、不冲抵）
  router.post('/', (req, res) => {
    const body = req.body || {}
    const allowed = ['statement_id', 'from_account_id']
    const extra = Object.keys(body).filter((k) => !allowed.includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)

    try {
      const op = createRepaymentOperation(db, demoUserId, {
        statementId: body.statement_id,
        fromAccountId: body.from_account_id,
      })
      ok(res, op)
    } catch (e) {
      if (e instanceof CreditError) return badRequest(res, e.message)
      throw e
    }
  })

  // 查看还款操作单（读取时惰性过期）
  router.get('/:refNo', (req, res) => {
    const op = getRepaymentOperation(db, demoUserId, req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '还款单不存在' })
    ok(res, op)
  })

  // 取消还款操作单（不扣款、不冲抵）
  router.post('/:refNo/cancel', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)

    const r = cancelRepaymentOperation(db, demoUserId, req.params.refNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '还款单不存在' })
    if (r.outcome === 'cancelled') return ok(res, r.op)
    return res.status(409).json({ success: false, message: CANCEL_MSG[r.outcome] || '还款单当前状态不可取消', data: r.op })
  })

  // 强验证确认（交易密码 + 动态验证码）：仅服务端演示用户；客户端不能指定 userId / 风险级别 / 「已验证」。
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
      const r = verifyAndConfirmRepayment(
        db, demoUserId, req.params.refNo, { password, totp },
        { encryptionKey: loadVerificationKey() },
      )
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '还款单不存在' })
      if (r.outcome === 'completed') return ok(res, r.op)
      const msg = r.reason ? r.reason : VERIFY_MSG[r.outcome] || '还款单当前状态不可验证'
      return res.status(409).json({ success: false, message: msg, data: r.op })
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
