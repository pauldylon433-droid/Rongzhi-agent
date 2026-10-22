import { Router } from 'express'
import { ok, badRequest, parseMonth, parsePagination } from './helpers.js'
import { listTransactions } from '../services/transactions.js'

// 入账状态筛选仅接受这两个枚举值；全部时不传参数（status = undefined）
const ALLOWED_STATUS = ['posted', 'pending']

export function createTransactionsRouter(db, demoUserId) {
  const router = Router()

  router.get('/', (req, res) => {
    let month
    if (req.query.month !== undefined) {
      month = parseMonth(req.query.month)
      if (!month) {
        return badRequest(res, 'month 参数格式应为 YYYY-MM（月份 01-12）')
      }
    }

    let status
    if (req.query.status !== undefined) {
      // 仅接受单个 posted / pending；数组（重复参数）、非法值或空值一律 400
      if (typeof req.query.status !== 'string' || !ALLOWED_STATUS.includes(req.query.status)) {
        return badRequest(res, 'status 仅支持 posted / pending')
      }
      status = req.query.status
    } else if (req.query['status[]'] !== undefined) {
      // Express 5 简单查询解析把 status[]=xxx 解析为「status[]」键；数组形式同样拒绝
      return badRequest(res, 'status 仅支持 posted / pending')
    }

    const pagination = parsePagination(req.query)
    if (pagination.error) {
      return badRequest(res, pagination.error)
    }

    const { rows, total } = listTransactions(db, demoUserId, {
      month,
      status,
      limit: pagination.limit,
      offset: pagination.offset,
    })

    ok(res, rows, { total, limit: pagination.limit, offset: pagination.offset })
  })

  return router
}
