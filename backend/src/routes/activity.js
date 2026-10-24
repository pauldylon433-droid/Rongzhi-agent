// 业务活动聚合路由：只读统一列表（转账 / 银行卡 / 订阅 / 跨场景任务）。
// 支持 type / status 筛选与 limit / offset 分页；不改变建单、确认、验证与执行链路。
import { Router } from 'express'
import { ok, badRequest, parsePagination } from './helpers.js'
import { listActivity } from '../services/activity.js'

const VALID_TYPES = ['transfer', 'card_op', 'subscription_op', 'repayment', 'task']

export function createActivityRouter(db, demoUserId) {
  const router = Router()

  router.get('/', (req, res) => {
    const { type, status } = req.query
    if (type !== undefined && (typeof type !== 'string' || !VALID_TYPES.includes(type))) {
      return badRequest(res, `type 仅支持：${VALID_TYPES.join('、')}`)
    }
    if (status !== undefined && typeof status !== 'string') {
      return badRequest(res, 'status 必须为字符串')
    }
    const pg = parsePagination(req.query)
    if (pg.error) return badRequest(res, pg.error)

    try {
      const { rows, total } = listActivity(db, demoUserId, {
        type: type || null,
        status: status || null,
        limit: pg.limit,
        offset: pg.offset,
      })
      ok(res, rows, { total, limit: pg.limit, offset: pg.offset })
    } catch (e) {
      console.error('[活动] 读取业务记录失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '读取业务记录失败' })
    }
  })

  return router
}
