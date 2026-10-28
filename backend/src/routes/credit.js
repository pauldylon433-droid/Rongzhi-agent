// 信用卡查询路由（只读）：信用账户列表 / 单账户（额度汇总 + 账单列表）/ 账单列表 / 账单详情（消费明细 + 还款冲抵明细）。
// 身份与归属由服务端演示用户固定；信用账户不得作为对外付款账户（见 transfers.js），消费 / 入账 / 出账不暴露为写接口。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import { listCreditAccounts, listStatements, getStatementDetail } from '../services/credit.js'

function parseId(raw) {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function createCreditRouter(db, demoUserId) {
  const router = Router()

  // 全部信用账户（含关联卡片、额度汇总与账单列表）
  router.get('/accounts', (req, res) => {
    ok(res, listCreditAccounts(db, demoUserId))
  })

  // 单个信用账户（额度汇总 + 账单列表）
  router.get('/accounts/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (!id) return badRequest(res, '信用账户 id 不合法')
    const found = listCreditAccounts(db, demoUserId).find((c) => c.id === id)
    if (!found) return res.status(404).json({ success: false, message: '信用账户不存在' })
    ok(res, found)
  })

  // 某信用账户的账单列表
  router.get('/accounts/:id/statements', (req, res) => {
    const id = parseId(req.params.id)
    if (!id) return badRequest(res, '信用账户 id 不合法')
    const found = listCreditAccounts(db, demoUserId).find((c) => c.id === id)
    if (!found) return res.status(404).json({ success: false, message: '信用账户不存在' })
    ok(res, listStatements(db, demoUserId, id))
  })

  // 账单详情（账单视图 + 本期已入账消费明细 + 还款冲抵明细，可追溯）
  router.get('/statements/:statementId', (req, res) => {
    const sid = parseId(req.params.statementId)
    if (!sid) return badRequest(res, '账单 id 不合法')
    const detail = getStatementDetail(db, demoUserId, sid)
    if (!detail) return res.status(404).json({ success: false, message: '账单不存在' })
    ok(res, detail)
  })

  return router
}
