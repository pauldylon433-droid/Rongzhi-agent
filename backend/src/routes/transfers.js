// 模拟转账路由：创建 / 查看 / 确认 / 取消 / 强验证。身份与数据归属由服务端演示用户固定，
// 客户端不能指定付款账户、收款人、风险级别之外的字段；确认/验证不接受重新指定金额或收款人。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import {
  listRecipients, createTransfer, getTransfer, confirmTransfer, cancelTransfer, TransferError,
} from '../services/transfers.js'
import { verifyAndConfirmTransfer, VerificationError } from '../services/verification.js'
import { loadVerificationKey } from '../lib/verification-key.js'
import { createRateLimiter } from '../lib/rate-limit.js'

const CONFIRM_MSG = {
  expired: '转账单已过期，未扣款',
  cancelled: '转账单已取消',
  needs_verification: '当日累计转账金额已超限，需要强验证：请使用交易密码与动态验证码验证后确认',
  failed: '转账单校验失败，未扣款',
}

const CANCEL_MSG = {
  expired: '转账单已过期',
  completed: '已完成的转账单不能取消',
  failed: '该转账单已失败，不能取消',
}

const VERIFY_MSG = {
  expired: '转账单已过期，未扣款',
  cancelled: '转账单已取消，不能验证',
  completed: '转账单已完成',
  failed: '转账单校验失败，未扣款',
  pending: '该转账单无需强验证，请直接确认',
}

// 强验证接口基础限流（内存态），与持久化失败计数锁定职责分开
const verifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 })

export function createTransfersRouter(db, demoUserId) {
  const router = Router()

  // 虚构收款人列表
  router.get('/recipients', (req, res) => {
    ok(res, listRecipients(db))
  })

  // 创建转账单（不扣款）
  router.post('/', (req, res) => {
    const body = req.body || {}
    const allowed = ['recipient_id', 'amount_cents', 'remark']
    const extra = Object.keys(body).filter((k) => !allowed.includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)

    try {
      const op = createTransfer(db, demoUserId, {
        recipientId: body.recipient_id,
        amountCents: body.amount_cents,
        remark: body.remark,
      })
      ok(res, op)
    } catch (e) {
      if (e instanceof TransferError) return badRequest(res, e.message)
      throw e
    }
  })

  // 查看转账单
  router.get('/:refNo', (req, res) => {
    const op = getTransfer(db, demoUserId, req.params.refNo)
    if (!op) return res.status(404).json({ success: false, message: '转账单不存在' })
    ok(res, op)
  })

  // 确认并执行（要求明确确认；不接受重新指定金额或收款人）
  router.post('/:refNo/confirm', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'confirm')
    if (extra.length) return badRequest(res, `确认请求不允许提交字段：${extra.join('、')}`)
    if (body.confirm !== true) return badRequest(res, '必须明确确认（confirm: true）')

    const r = confirmTransfer(db, demoUserId, req.params.refNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
    if (r.outcome === 'completed') return ok(res, r.op)
    return res.status(409).json({ success: false, message: CONFIRM_MSG[r.outcome] || '转账单当前状态不可确认', data: r.op })
  })

  // 取消转账单（不扣款）
  router.post('/:refNo/cancel', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'cancel')
    if (extra.length) return badRequest(res, `取消请求不允许提交字段：${extra.join('、')}`)

    const r = cancelTransfer(db, demoUserId, req.params.refNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
    if (r.outcome === 'cancelled') return ok(res, r.op)
    return res.status(409).json({ success: false, message: CANCEL_MSG[r.outcome] || '转账单当前状态不可取消', data: r.op })
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
      const r = verifyAndConfirmTransfer(
        db, demoUserId, req.params.refNo, { password, totp },
        { encryptionKey: loadVerificationKey() },
      )
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '转账单不存在' })
      if (r.outcome === 'completed') return ok(res, r.op)
      return res.status(409).json({ success: false, message: VERIFY_MSG[r.outcome] || '转账单当前状态不可验证', data: r.op })
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
