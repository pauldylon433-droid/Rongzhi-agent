// 月度账单统计（只读、可复用）。统计逻辑集中在服务层，HTTP 路由只负责参数、
// 用户范围与响应，后续 AI 工具可直接复用本函数，无需重写统计逻辑。
import { shanghaiMonthRange } from '../lib/shanghai.js'

// 统计某上海自然月的已入账收支、待入账与支出分类汇总。
//
// 口径：
// - 只把 status='posted' 且 transaction_at <= asOf（截至请求时刻已发生）的交易
//   计入已入账收支与笔数；
// - status='pending' 不计入已入账收入/支出/净收支，单独列出数量与金额；
// - 未来时间却标记 posted 的记录不计入已发生（应在报告中另行指出，不修改数据）。
//
// 参数：year/month 为已校验的上海年月（month 为 1-12）；asOf 为统计截止时刻（UTC ISO）。
export function monthlyAnalytics(db, userId, { year, month, asOf = new Date().toISOString() }) {
  const { start, end } = shanghaiMonthRange(year, month)

  // 按用户范围 + 上海自然月边界（左闭右开）聚合，不依赖分页、不受分页参数影响
  const rows = db
    .prepare(
      `SELECT direction, amount_cents, category, status, transaction_at
       FROM transactions
       WHERE user_id = ? AND transaction_at >= ? AND transaction_at < ?
       ORDER BY transaction_at DESC, id DESC`,
    )
    .all(userId, start, end)

  let incomeCents = 0
  let expenseCents = 0
  let postedCount = 0
  let pendingCount = 0
  let pendingAmountCents = 0
  const categoryMap = new Map()

  for (const r of rows) {
    if (r.status === 'pending') {
      pendingCount += 1
      pendingAmountCents += r.amount_cents
      continue
    }
    // status === 'posted'：未来时间（transaction_at > asOf）视为未发生，不计入已入账
    if (r.transaction_at > asOf) {
      continue
    }
    postedCount += 1
    if (r.direction === 'income') {
      incomeCents += r.amount_cents
    } else {
      expenseCents += r.amount_cents
      const entry = categoryMap.get(r.category) || { amount_cents: 0, count: 0 }
      entry.amount_cents += r.amount_cents
      entry.count += 1
      categoryMap.set(r.category, entry)
    }
  }

  const expenseByCategory = [...categoryMap.entries()]
    .map(([category, v]) => ({ category, amount_cents: v.amount_cents, count: v.count }))
    .sort((a, b) => b.amount_cents - a.amount_cents)

  return {
    month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    timezone: 'Asia/Shanghai',
    as_of: asOf,
    income_cents: incomeCents,
    expense_cents: expenseCents,
    net_cents: incomeCents - expenseCents,
    posted_count: postedCount,
    pending: { count: pendingCount, amount_cents: pendingAmountCents },
    expense_by_category: expenseByCategory,
  }
}
