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

    const asOf = new Date().toISOString()
    const data = monthlyAnalytics(db, demoUserId, { ...month, asOf })
    ok(res, data)
  })

  return router
}
