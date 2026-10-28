import { Router } from 'express'
import { ok, badRequest, parseMonth } from './helpers.js'
import { monthlyAnalytics } from '../services/analytics.js'

// 月度账单统计路由：只负责参数校验、用户范围与响应，统计逻辑在 services/analytics.js。
export function createAnalyticsRouter(db, demoUserId) {
  const router = Router()

  router.get('/monthly', (req, res) => {
    // month 必填
    if (req.query.month === undefined) {
      return badRequest(res, 'month 参数必填，格式为 YYYY-MM')
    }
    const month = parseMonth(req.query.month)
    if (!month) {
      return badRequest(res, 'month 参数格式应为 YYYY-MM（月份 01-12）')
    }

    // 借记卡选择驱动的按账户过滤：仅接受单个正整数账户 id（数组 / 非法值一律 400）
    let accountId
    if (req.query.account_id !== undefined) {
      if (typeof req.query.account_id !== 'string' || !/^\d+$/.test(req.query.account_id)) {
        return badRequest(res, 'account_id 必须是正整数')
      }
      accountId = Number(req.query.account_id)
      if (accountId < 1) return badRequest(res, 'account_id 必须是正整数')
    }

    const asOf = new Date().toISOString()
    const data = monthlyAnalytics(db, demoUserId, { ...month, asOf, accountId })
    ok(res, data)
  })

  return router
}
