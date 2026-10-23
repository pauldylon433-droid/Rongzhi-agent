import { shanghaiMonthRange } from '../lib/shanghai.js'

const COLUMNS = `
  id, account_id, direction, amount_cents, category, merchant, description,
  transaction_at, posted_at, status, flow_kind, repayment_ref, created_at
`

// —— 交易后结余 / 可用额度（只读重建）——
//
// 口径：
// - 借记账户：记账时间 = 入账时间（posted_at）优先，否则交易发生时间（transaction_at）；同一时刻按 id 稳定排序。
//   结余 = 期初余额 + 截至该笔（含）已入账收支累计；待入账记录不影响已入账结余。
//   仅当「期初余额 + 全部已入账净额 = 当前余额」成立时视为可追溯；否则整账户返回不可追溯。
// - 信用账户：按事件时间线重放（消费占额 → 入账 → 还款），
//   交易后可用额度 = 信用额度 − 已入账未还 − 待入账占用（截至该事件）。
//   消费的入账时刻使用 posted_at（与出账/还款口径一致），未入账消费在发生时刻占额。
//   重放终态必须与 credit_accounts 的当前已入账未还 / 待入账占用一致，否则整账户不可追溯。
// - 每个账户独立计算，绝不跨账户累计。数据库原始数据不改写。

function signedCents(direction, cents) {
  return direction === 'income' ? cents : -cents
}

function depositBalanceInfo(db, userId, accountId) {
  const acct = db
    .prepare('SELECT opening_balance_cents, balance_cents, account_type FROM accounts WHERE id = ? AND user_id = ?')
    .get(accountId, userId)
  if (!acct || acct.account_type !== 'deposit') return null
  const rows = db
    .prepare(
      `SELECT id, direction, amount_cents, status, transaction_at, posted_at
       FROM transactions
       WHERE user_id = ? AND account_id = ?
       ORDER BY COALESCE(posted_at, transaction_at) ASC, id ASC`,
    )
    .all(userId, accountId)

  let net = 0
  for (const r of rows) {
    if (r.status === 'posted') net += signedCents(r.direction, r.amount_cents)
  }
  // 基准 + 全量账务必须与当前余额一致，否则不认定可追溯
  if (acct.opening_balance_cents + net !== acct.balance_cents) return null

  const map = new Map()
  let running = acct.opening_balance_cents
  for (const r of rows) {
    if (r.status === 'posted') {
      running += signedCents(r.direction, r.amount_cents)
      map.set(r.id, running)
    } else {
      map.set(r.id, null) // 待入账不影响已入账结余
    }
  }
  return { kind: 'cash', map }
}

function creditBalanceInfo(db, userId, accountId) {
  const ca = db
    .prepare(
      `SELECT id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents
       FROM credit_accounts WHERE account_id = ? AND user_id = ?`,
    )
    .get(accountId, userId)
  if (!ca) return null
  const rows = db
    .prepare(
      `SELECT id, direction, amount_cents, status, flow_kind, transaction_at, posted_at
       FROM transactions WHERE user_id = ? AND account_id = ?`,
    )
    .all(userId, accountId)

  const events = []
  for (const r of rows) {
    const at = Date.parse(r.transaction_at)
    if (!Number.isFinite(at)) return null
    // 还款流水记在付款账户上（不在信用账户），信用侧由 statement_payments 提供还款事件，见下。
    if (r.flow_kind === 'repayment') continue
    if (r.status === 'posted' && !r.posted_at) return null // 已入账但缺入账时间：无法确定记账顺序
    events.push({ t: at, rank: 0, id: r.id, type: 'create', row: r, amount: r.amount_cents })
    if (r.posted_at) {
      const pt = Date.parse(r.posted_at)
      if (!Number.isFinite(pt)) return null
      events.push({ t: pt, rank: 1, id: r.id, type: 'post', row: r, amount: r.amount_cents })
    }
  }
  // 还款事件：statement_payments（与真实冲抵同一来源），按冲抵时间进入时间线
  const payments = db
    .prepare(
      `SELECT sp.id, sp.amount_cents, sp.paid_at
       FROM statement_payments sp JOIN statements s ON s.id = sp.statement_id
       WHERE s.credit_account_id = ? AND sp.user_id = ?`,
    )
    .all(ca.id, userId)
  for (const p of payments) {
    const t = Date.parse(p.paid_at)
    if (!Number.isFinite(t)) return null
    events.push({ t, rank: 2, id: p.id, type: 'repay', amount: p.amount_cents })
  }
  // 同一时刻：发生(0) → 入账(1) → 还款(2)，再按 id 稳定排序
  events.sort((a, b) => a.t - b.t || a.rank - b.rank || a.id - b.id)

  let posted = 0
  let pending = 0
  const map = new Map()
  const available = () => ca.credit_limit_cents - posted - pending
  for (const ev of events) {
    if (ev.type === 'create') {
      pending += ev.amount
      if (pending < 0) return null
      if (ev.row.status === 'pending') map.set(ev.row.id, available())
    } else if (ev.type === 'post') {
      pending -= ev.amount
      posted += ev.amount
      if (pending < 0) return null
      if (ev.row.status === 'posted') map.set(ev.row.id, available())
    } else {
      posted -= ev.amount
      if (posted < 0) return null
    }
  }
  // 重放终态必须与当前信用账户状态一致（防止数据不一致时给出伪值）
  if (posted !== ca.posted_outstanding_cents || pending !== ca.pending_occupied_cents) return null
  return { kind: 'credit', map }
}

// 为当前页交易附加结余字段（仅影响响应中的派生字段，不写库）：
//   balance_after_cents: number | null
//   balance_state: 'value' | 'pending' | 'untraceable'
//   balance_kind: 'cash' | 'credit' | null
function attachRunningBalances(db, userId, rows) {
  const accountIds = [...new Set(rows.map((r) => r.account_id))]
  const infos = new Map()
  for (const id of accountIds) {
    const acct = db
      .prepare('SELECT account_type FROM accounts WHERE id = ? AND user_id = ?')
      .get(id, userId)
    if (!acct) {
      infos.set(id, null)
      continue
    }
    infos.set(id, acct.account_type === 'credit' ? creditBalanceInfo(db, userId, id) : depositBalanceInfo(db, userId, id))
  }
  return rows.map((row) => {
    const info = infos.get(row.account_id)
    if (!info) {
      return { ...row, balance_after_cents: null, balance_state: 'untraceable', balance_kind: null }
    }
    const kind = info.kind
    if (!info.map.has(row.id)) {
      return { ...row, balance_after_cents: null, balance_state: 'untraceable', balance_kind: kind }
    }
    const value = info.map.get(row.id)
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { ...row, balance_after_cents: value, balance_state: 'value', balance_kind: kind }
    }
    // 借记账户的待入账记录：不提前影响已入账结余
    return { ...row, balance_after_cents: null, balance_state: 'pending', balance_kind: kind }
  })
}

// 交易流水查询（只读）。
// month 为 { year, month }（已解析）或 undefined；status 为 'posted' | 'pending' 或 undefined；
// accountId 为可选账户过滤（借记卡选择驱动按账户查看流水，恒与 user_id 叠加，天然限定本人账户）；
// 分页参数 limit/offset 已校验。
// 结余字段始终基于该账户的**全量账务**计算，筛选 / 分页只影响展示。
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

  return { rows: attachRunningBalances(db, userId, rows), total }
}
