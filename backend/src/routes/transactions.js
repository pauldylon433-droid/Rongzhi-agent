import { Router } from 'express'
import { ok, badRequest, parseMonth, parsePagination } from './helpers.js'
import { listTransactions } from '../services/transactions.js'

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

    const pagination = parsePagination(req.query)
    if (pagination.error) {
      return badRequest(res, pagination.error)
    }

    const { rows, total } = listTransactions(db, demoUserId, {
      month,
      limit: pagination.limit,
      offset: pagination.offset,
    })

    ok(res, rows, { total, limit: pagination.limit, offset: pagination.offset })
  })

  return router
}
