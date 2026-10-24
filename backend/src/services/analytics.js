// 月度账单统计（只读、可复用）。统计逻辑集中在服务层，HTTP 路由只负责参数、
// 用户范围与响应，后续 AI 工具可直接复用本函数，无需重写统计逻辑。
import { shanghaiMonthRange } from '../lib/shanghai.js'

// 统计某上海自然月的已入账收支、待入账与收支分类汇总（收入分类 / 支出分类）。
//
// 口径：
// - 只把 status='posted' 且 transaction_at <= asOf（截至请求时刻已发生）的交易
//   计入已入账收支与笔数；
// - status='pending' 不计入已入账收入/支出/净收支，单独列出数量与金额；
// - flow_kind='repayment'（信用卡还款冲抵）既不计为收入也不计为支出（内部冲账，非消费/收入）；
// - 未来时间却标记 posted 的记录不计入已发生（应在报告中另行指出，不修改数据）。
//
// 参数：year/month 为已校验的上海年月（month 为 1-12）；asOf 为统计截止时刻（UTC ISO）；
// accountId 为可选账户过滤（借记卡选择驱动按账户查看月度统计，恒与 user_id 叠加，限定本人账户）。
export function monthlyAnalytics(db, userId, { year, month, asOf = new Date().toISOString(), accountId }) {
  const { start, end } = shanghaiMonthRange(year, month)

  // 按用户范围 + 上海自然月边界（左闭右开）聚合，不依赖分页、不受分页参数影响
  const conditions = ['user_id = ?', 'transaction_at >= ?', 'transaction_at < ?']
  const params = [userId, start, end]
  if (accountId) {
    conditions.push('account_id = ?')
    params.push(accountId)
  }
  const rows = db
    .prepare(
      `SELECT direction, amount_cents, category, status, transaction_at, flow_kind
       FROM transactions
       WHERE ${conditions.join(' AND ')}
       ORDER BY transaction_at DESC, id DESC`,
    )
    .all(...params)

  let incomeCents = 0
  let expenseCents = 0
  let repaymentCents = 0
  let postedCount = 0
  let pendingCount = 0
  let pendingAmountCents = 0
  const incomeMap = new Map()
  const expenseMap = new Map()

  for (const r of rows) {
    // 信用卡还款冲抵（内部冲账）：既不计为消费支出，也不计作收入，但单列展示
    if (r.flow_kind === 'repayment') {
      repaymentCents += r.amount_cents
      continue
    }
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
    const map = r.direction === 'income' ? incomeMap : expenseMap
    if (r.direction === 'income') {
      incomeCents += r.amount_cents
    } else {
      expenseCents += r.amount_cents
    }
    const entry = map.get(r.category) || { amount_cents: 0, count: 0 }
    entry.amount_cents += r.amount_cents
    entry.count += 1
    map.set(r.category, entry)
  }

  // 收入 / 支出各自分类汇总（同一口径：仅已入账 posted），按金额倒序
  const toSorted = (map) =>
    [...map.entries()]
      .map(([category, v]) => ({ category, amount_cents: v.amount_cents, count: v.count }))
      .sort((a, b) => b.amount_cents - a.amount_cents)

  const incomeByCategory = toSorted(incomeMap)
  const expenseByCategory = toSorted(expenseMap)

  return {
    month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    timezone: 'Asia/Shanghai',
    as_of: asOf,
    income_cents: incomeCents,
    expense_cents: expenseCents,
    repayment_cents: repaymentCents, // 信用卡还款（内部冲账）：单列，不计入收入 / 支出 / 净收支
    net_cents: incomeCents - expenseCents,
    posted_count: postedCount,
    pending: { count: pendingCount, amount_cents: pendingAmountCents },
    income_by_category: incomeByCategory,
    expense_by_category: expenseByCategory,
  }
}
