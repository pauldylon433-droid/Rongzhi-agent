// 模拟转账路由：创建 / 查看 / 确认 / 取消。身份与数据归属由服务端演示用户固定，
// 客户端不能指定付款账户、收款人之外的字段；确认不接受重新指定金额或收款人。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import {
  listRecipients, createTransfer, getTransfer, confirmTransfer, cancelTransfer, TransferError,
} from '../services/transfers.js'

const CONFIRM_MSG = {
  expired: '转账单已过期，未扣款',
  cancelled: '转账单已取消',
  needs_verification: '当日累计转账金额已超限，需要强验证，本阶段尚未开放',
  failed: '转账单校验失败，未扣款',
}

const CANCEL_MSG = {
  expired: '转账单已过期',
  completed: '已完成的转账单不能取消',
  needs_verification: '该转账单需要强验证，不能取消',
  failed: '该转账单已失败，不能取消',
}

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

  return router
}
