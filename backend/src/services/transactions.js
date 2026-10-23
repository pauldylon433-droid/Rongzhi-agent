import { shanghaiMonthRange } from '../lib/shanghai.js'

const COLUMNS = `
  id, account_id, direction, amount_cents, category, merchant, description,
  transaction_at, posted_at, status, flow_kind, repayment_ref, created_at
`

// 交易流水查询（只读）。
// month 为 { year, month }（已解析）或 undefined；status 为 'posted' | 'pending' 或 undefined；
// accountId 为可选账户过滤（借记卡选择驱动按账户查看流水，恒与 user_id 叠加，天然限定本人账户）；
// 分页参数 limit/offset 已校验。
export function listTransactions(db, userId, { month, status, accountId, limit, offset }) {
  const conditions = ['user_id = ?']
  const params = [userId]

  if (month) {
    const { start, end } = shanghaiMonthRange(month.year, month.month)
    conditions.push('transaction_at >= ?', 'transaction_at < ?')
    params.push(start, end)
  }

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  if (accountId) {
    conditions.push('account_id = ?')
    params.push(accountId)
  }

  const where = conditions.join(' AND ')

  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM transactions WHERE ${where}`)
    .get(...params).total

  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM transactions
       WHERE ${where}
       ORDER BY transaction_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)

  return { rows, total }
}
