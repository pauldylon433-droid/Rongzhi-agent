// CloudBase 快照 → 与现有前端 API 完全一致的只读视图。
// 统计 / 逐笔结余 / 信用卡账单等派生口径与 SQLite 服务层保持一致；数据来源仅为 CloudBase RPC 快照。
import { shanghaiMonthRange, shanghaiNowParts } from '../lib/shanghai.js'

const MAX_VERIFY_FAILURES = 5
const DAILY_TRANSFER_LIMIT_CENTS = 100000
const KIND_ORDER = { transfer: 0, card_op: 1, subscription_op: 2, repayment: 3, task: 4 }
const TIME_KEYS = new Set([
  'due_on', 'issued_on', 'period_start', 'period_end', 'locked_until', 'snapshot_at', 'as_of',
])

function normalize(value, key = '') {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value // 纯日期字段保持原样
  if (Array.isArray(value)) return value.map((v) => normalize(v, key))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k)
    return out
  }
  if (typeof value === 'string' && (key === 'created_at' || key === 'updated_at' || key === 'completed_at'
      || key === 'confirmed_at' || key === 'expires_at' || key === 'posted_at' || key === 'transaction_at'
      || key === 'consumed_at' || key === 'paid_at' || key === 'bound_at' || key === 'server_time'
      || key.endsWith('_at') || TIME_KEYS.has(key))) {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return value
}

const iso = (v) => (v == null || v === '' ? null : (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null))
const signedCents = (direction, cents) => (direction === 'income' ? cents : -cents)

// 只读视图的有效状态：过期时间到达后显示 expired，不为了展示而写库。
function effectiveOpStatus(row, nowIso) {
  if (!row) return null
  if ((row.status === 'pending' || row.status === 'needs_verification') && row.expires_at && row.expires_at < nowIso) {
    return 'expired'
  }
  return row.status
}

function byIdMap(rows) {
  return new Map((rows || []).map((r) => [Number(r.id), r]))
}

function taskMerchant(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  return (rs && rs.merchant) || (sel && sel.merchant) || ''
}
function taskAmount(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  if (rs && Number.isInteger(rs.amount_cents)) return rs.amount_cents
  if (sel && Number.isInteger(sel.amount_cents)) return sel.amount_cents
  return null
}
function taskCycle(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  return (rs && rs.billing_cycle) || (sel && sel.billing_cycle) || null
}
function toEpochMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}
function toIso(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return new Date(v).toISOString()
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export function buildCloudStore(raw, { now = () => new Date() } = {}) {
  const snap = normalize(raw)
  const accounts = snap.accounts || []
  const transactions = snap.transactions || []
  const cards = snap.cards || []
  const subscriptions = snap.subscriptions || []
  const creditAccounts = snap.credit_accounts || []
  const statements = snap.statements || []
  const statementPayments = snap.statement_payments || []
  const transferOps = snap.transfer_operations || []
  const cardOps = snap.card_operations || []
  const subOps = snap.subscription_operations || []
  const repayOps = snap.repayment_operations || []
  const repayAllocations = snap.repayment_allocations || []
  const chatSessions = snap.chat_sessions || []
  const chatMessages = snap.chat_messages || []
  const chatState = snap.chat_state || null
  const taskRows = snap.agent_tasks || []
  const taskNodeRows = snap.agent_task_nodes || []

  const accountById = byIdMap(accounts)
  const cardById = byIdMap(cards)
  const cardByAccount = new Map()
  for (const c of cards) if (!cardByAccount.has(Number(c.account_id))) cardByAccount.set(Number(c.account_id), c)
  const creditByAccount = new Map(creditAccounts.map((c) => [Number(c.account_id), c]))
  const creditById = byIdMap(creditAccounts)
  const statementById = byIdMap(statements)
  const subById = byIdMap(subscriptions)
  const txByTransferRef = new Map(transactions.filter((t) => t.transfer_ref).map((t) => [t.transfer_ref, t]))
  const opsByRef = new Map([...transferOps, ...cardOps, ...subOps, ...repayOps].map((o) => [o.ref_no, o]))
  const allocByRef = new Map()
  for (const a of repayAllocations) {
    if (!allocByRef.has(a.ref_no)) allocByRef.set(a.ref_no, [])
    allocByRef.get(a.ref_no).push(a)
  }
  const nodesByTask = new Map()
  for (const n of taskNodeRows) {
    if (!nodesByTask.has(Number(n.task_id))) nodesByTask.set(Number(n.task_id), [])
    nodesByTask.get(Number(n.task_id)).push(n)
  }
  const messagesBySession = new Map()
  for (const m of chatMessages) {
    if (!messagesBySession.has(m.session_id)) messagesBySession.set(m.session_id, [])
    messagesBySession.get(m.session_id).push(m)
  }
  const paymentsByStatement = new Map()
  for (const p of statementPayments) {
    if (!paymentsByStatement.has(Number(p.statement_id))) paymentsByStatement.set(Number(p.statement_id), [])
    paymentsByStatement.get(Number(p.statement_id)).push(p)
  }

  // —— 账户 / 银行卡 / 订阅 ——
  function accountsView() {
    return accounts.map((a) => ({
      id: a.id, account_name: a.account_name, opening_balance_cents: a.opening_balance_cents,
      balance_cents: a.balance_cents, currency: a.currency, account_type: a.account_type,
      status: a.status, opened_on: a.opened_on, created_at: a.created_at,
    }))
  }

  function cardsView() {
    return cards.map((c) => {
      const a = accountById.get(Number(c.account_id))
      const base = {
        id: c.id, account_id: c.account_id, account_type: a ? a.account_type : null,
        account_name: a ? a.account_name : null, account_status: a ? a.status : null,
        masked_card_number: c.masked_card_number, card_type: c.card_type, status: c.status,
        daily_limit_cents: c.daily_limit_cents, issued_on: c.issued_on, created_at: c.created_at,
      }
      if (a && a.account_type === 'credit') {
        const ca = creditByAccount.get(Number(c.account_id))
        base.credit_account_id = ca ? ca.id : null
        base.credit_limit_cents = ca ? ca.credit_limit_cents : null
        base.posted_outstanding_cents = ca ? ca.posted_outstanding_cents : null
        base.pending_occupied_cents = ca ? ca.pending_occupied_cents : null
        base.available_credit_cents = ca
          ? ca.credit_limit_cents - ca.posted_outstanding_cents - ca.pending_occupied_cents : null
      } else {
        base.balance_cents = a ? a.balance_cents : null
      }
      return base
    })
  }

  function sourceView(accountId) {
    if (accountId == null) return { account: null, card: null }
    return { account: accountById.get(Number(accountId)) || null, card: cardByAccount.get(Number(accountId)) || null }
  }

  function subscriptionsView() {
    return subscriptions.map((s) => {
      const a = accountById.get(Number(s.account_id)) || null
      const c = cardByAccount.get(Number(s.account_id)) || null
      return {
        id: s.id, account_id: s.account_id, merchant: s.merchant, amount_cents: s.amount_cents,
        billing_cycle: s.billing_cycle, next_billing_date: s.next_billing_date, status: s.status,
        created_at: s.created_at,
        account_name: a ? a.account_name : null, account_type: a ? a.account_type : null,
        currency: a ? a.currency : null, account_status: a ? a.status : null,
        masked_card_number: c ? c.masked_card_number : null,
        card_type: c ? c.card_type : null, card_status: c ? c.status : null,
      }
    })
  }

  // —— 逐笔结余 / 交易后可用额度 ——
  function depositBalanceInfo(accountId) {
    const acct = accountById.get(Number(accountId))
    if (!acct || acct.account_type !== 'deposit') return null
    const rows = transactions
      .filter((t) => Number(t.account_id) === Number(accountId))
      .sort((a, b) => {
        const ta = Date.parse(a.posted_at || a.transaction_at) - Date.parse(b.posted_at || b.transaction_at)
        return ta || (Number(a.id) - Number(b.id))
      })
    let net = 0
    for (const r of rows) if (r.status === 'posted') net += signedCents(r.direction, r.amount_cents)
    if (acct.opening_balance_cents + net !== acct.balance_cents) return null
    const map = new Map()
    let running = acct.opening_balance_cents
    for (const r of rows) {
      if (r.status === 'posted') {
        running += signedCents(r.direction, r.amount_cents)
        map.set(Number(r.id), running)
      } else map.set(Number(r.id), null)
    }
    return { kind: 'cash', map }
  }

  function creditBalanceInfo(accountId) {
    const ca = creditByAccount.get(Number(accountId))
    if (!ca) return null
    const rows = transactions.filter((t) => Number(t.account_id) === Number(accountId))
    const events = []
    for (const r of rows) {
      const at = Date.parse(r.transaction_at)
      if (!Number.isFinite(at)) return null
      if (r.flow_kind === 'repayment') continue
      if (r.status === 'posted' && !r.posted_at) return null
      events.push({ t: at, rank: 0, id: Number(r.id), type: 'create', row: r, amount: r.amount_cents })
      if (r.posted_at) {
        const pt = Date.parse(r.posted_at)
        if (!Number.isFinite(pt)) return null
        events.push({ t: pt, rank: 1, id: Number(r.id), type: 'post', row: r, amount: r.amount_cents })
      }
    }
    for (const p of statementPayments) {
      const s = statementById.get(Number(p.statement_id))
      if (!s || Number(s.credit_account_id) !== Number(ca.id)) continue
      const t = Date.parse(p.paid_at)
      if (!Number.isFinite(t)) return null
      events.push({ t, rank: 2, id: Number(p.id), type: 'repay', amount: p.amount_cents })
    }
    events.sort((a, b) => a.t - b.t || a.rank - b.rank || a.id - b.id)
    let earliestAmbiguous = Infinity
    for (let i = 0; i < events.length;) {
      let j = i
      const ids = new Set()
      while (j < events.length && events[j].t === events[i].t) { ids.add(events[j].id); j += 1 }
      if (ids.size > 1) earliestAmbiguous = Math.min(earliestAmbiguous, events[i].t)
      i = j
    }
    let posted = 0
    let pending = 0
    const map = new Map()
    const available = () => ca.credit_limit_cents - posted - pending
    const record = (ev, value) => { if (ev.t < earliestAmbiguous) map.set(Number(ev.row.id), value) }
    for (const ev of events) {
      if (ev.type === 'create') {
        pending += ev.amount
        if (pending < 0) return null
        if (ev.row.status === 'pending') record(ev, available())
      } else if (ev.type === 'post') {
        pending -= ev.amount
        posted += ev.amount
        if (pending < 0) return null
        if (ev.row.status === 'posted') record(ev, available())
      } else {
        posted -= ev.amount
        if (posted < 0) return null
      }
    }
    if (posted !== ca.posted_outstanding_cents || pending !== ca.pending_occupied_cents) return null
    return { kind: 'credit', map }
  }

  function attachRunningBalances(rows) {
    const ids = [...new Set(rows.map((r) => Number(r.account_id)))]
    const infos = new Map()
    for (const id of ids) {
      const acct = accountById.get(id)
      if (!acct) { infos.set(id, null); continue }
      infos.set(id, acct.account_type === 'credit' ? creditBalanceInfo(id) : depositBalanceInfo(id))
    }
    return rows.map((row) => {
      const info = infos.get(Number(row.account_id))
      if (!info) return { ...row, balance_after_cents: null, balance_state: 'untraceable', balance_kind: null }
      if (!info.map.has(Number(row.id))) {
        return { ...row, balance_after_cents: null, balance_state: 'untraceable', balance_kind: info.kind }
      }
      const value = info.map.get(Number(row.id))
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { ...row, balance_after_cents: value, balance_state: 'value', balance_kind: info.kind }
      }
      return { ...row, balance_after_cents: null, balance_state: 'pending', balance_kind: info.kind }
    })
  }

  function transactionsView({ month, status, accountId, limit, offset }) {
    let rows = transactions
    if (month) {
      const { start, end } = shanghaiMonthRange(month.year, month.month)
      rows = rows.filter((r) => r.transaction_at >= start && r.transaction_at < end)
    }
    if (status) rows = rows.filter((r) => r.status === status)
    if (accountId) rows = rows.filter((r) => Number(r.account_id) === Number(accountId))
    const total = rows.length
    rows = [...rows].sort((a, b) => {
      const t = Date.parse(b.transaction_at) - Date.parse(a.transaction_at)
      return t || (Number(b.id) - Number(a.id))
    }).slice(offset, offset + limit)
    const shaped = rows.map((r) => ({
      id: r.id, account_id: r.account_id, direction: r.direction, amount_cents: r.amount_cents,
      category: r.category, merchant: r.merchant, description: r.description,
      transaction_at: r.transaction_at, posted_at: r.posted_at, status: r.status,
      flow_kind: r.flow_kind, repayment_ref: r.repayment_ref, created_at: r.created_at,
    }))
    return { rows: attachRunningBalances(shaped), total }
  }

  function analyticsView({ year, month, asOf, accountId }) {
    const { start, end } = shanghaiMonthRange(year, month)
    const rows = transactions.filter((r) => r.transaction_at >= start && r.transaction_at < end
      && (!accountId || Number(r.account_id) === Number(accountId)))
    let incomeCents = 0, expenseCents = 0, repaymentCents = 0
    let postedCount = 0, pendingCount = 0, pendingAmountCents = 0
    const incomeMap = new Map()
    const expenseMap = new Map()
    for (const r of rows) {
      if (r.flow_kind === 'repayment') { repaymentCents += r.amount_cents; continue }
      if (r.status === 'pending') { pendingCount += 1; pendingAmountCents += r.amount_cents; continue }
      if (r.transaction_at > asOf) continue
      postedCount += 1
      const map = r.direction === 'income' ? incomeMap : expenseMap
      if (r.direction === 'income') incomeCents += r.amount_cents
      else expenseCents += r.amount_cents
      const entry = map.get(r.category) || { amount_cents: 0, count: 0 }
      entry.amount_cents += r.amount_cents
      entry.count += 1
      map.set(r.category, entry)
    }
    const sorted = (map) => [...map.entries()]
      .map(([category, v]) => ({ category, amount_cents: v.amount_cents, count: v.count }))
      .sort((a, b) => b.amount_cents - a.amount_cents)
    return {
      month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
      timezone: 'Asia/Shanghai', as_of: asOf,
      income_cents: incomeCents, expense_cents: expenseCents, repayment_cents: repaymentCents,
      net_cents: incomeCents - expenseCents, posted_count: postedCount,
      pending: { count: pendingCount, amount_cents: pendingAmountCents },
      income_by_category: sorted(incomeMap), expense_by_category: sorted(expenseMap),
    }
  }

  // —— 操作单视图 ——
  function transferView(row) {
    if (!row) return null
    const status = effectiveOpStatus(row, now().toISOString())
    const v = {
      ref_no: row.ref_no, from_account_id: row.from_account_id, from_account_name: row.from_account_name,
      recipient_id: row.recipient_id, recipient_name: row.recipient_name,
      recipient_masked_account: row.recipient_masked_account, amount_cents: row.amount_cents,
      remark: row.remark, status, risk_level: row.risk_level,
      created_at: row.created_at, expires_at: row.expires_at, confirmed_at: row.confirmed_at,
    }
    if (status === 'completed') {
      const tx = txByTransferRef.get(row.ref_no)
      v.transaction_id = tx ? tx.id : null
    }
    return v
  }

  function cardView(row) {
    if (!row) return null
    const c = cardById.get(Number(row.card_id))
    return {
      ref_no: row.ref_no, card_id: row.card_id, masked_card_number: row.card_masked,
      card_type: row.card_type, action: row.action, from_status: row.from_status,
      to_status: row.to_status, risk_level: row.risk_level,
      status: effectiveOpStatus(row, now().toISOString()),
      created_at: row.created_at, expires_at: row.expires_at, confirmed_at: row.confirmed_at,
      card: c ? {
        id: c.id, masked_card_number: c.masked_card_number, card_type: c.card_type,
        status: c.status, daily_limit_cents: c.daily_limit_cents,
      } : null,
    }
  }

  function subscriptionStatusView(subscriptionId) {
    const sub = subById.get(Number(subscriptionId))
    if (!sub) return null
    const src = sourceView(sub.account_id)
    return {
      id: sub.id, account_id: sub.account_id,
      account_name: src.account ? src.account.account_name : null,
      account_type: src.account ? src.account.account_type : null,
      currency: src.account ? src.account.currency : null,
      account_status: src.account ? src.account.status : null,
      masked_card_number: src.card ? src.card.masked_card_number : null,
      card_type: src.card ? src.card.card_type : null,
      card_status: src.card ? src.card.status : null,
      merchant: sub.merchant, amount_cents: sub.amount_cents, billing_cycle: sub.billing_cycle,
      next_billing_date: sub.next_billing_date, status: sub.status,
    }
  }

  function subscriptionOpView(row) {
    if (!row) return null
    return {
      ref_no: row.ref_no, subscription_id: row.subscription_id, merchant: row.merchant,
      amount_cents: row.amount_cents, billing_cycle: row.billing_cycle, action: row.action,
      from_status: row.from_status, to_status: row.to_status,
      from_account_id: row.from_account_id ?? null, from_account_name: row.from_account_name ?? null,
      from_account_type: row.from_account_type ?? null, from_masked_card: row.from_masked_card ?? null,
      to_account_id: row.to_account_id ?? null, to_account_name: row.to_account_name ?? null,
      to_account_type: row.to_account_type ?? null, to_masked_card: row.to_masked_card ?? null,
      risk_level: row.risk_level, status: effectiveOpStatus(row, now().toISOString()),
      created_at: row.created_at, expires_at: row.expires_at, confirmed_at: row.confirmed_at,
      subscription: subscriptionStatusView(row.subscription_id),
    }
  }

  // —— 信用卡 ——
  function statementView(row, at = now()) {
    const remaining = row.new_charges_cents - row.paid_cents
    let status
    if (row.issued_at == null) status = 'unissued'
    else if (remaining <= 0) status = 'paid'
    else if (new Date(at).toISOString() >= row.due_on) status = 'overdue'
    else status = 'open'
    return {
      id: row.id, credit_account_id: row.credit_account_id,
      statement_month: `${String(row.statement_year).padStart(4, '0')}-${String(row.statement_month).padStart(2, '0')}`,
      period_start: row.period_start, period_end: row.period_end,
      issued_on: row.issued_on, issued_at: row.issued_at, issued: row.issued_at != null,
      due_on: row.due_on, new_charges_cents: row.new_charges_cents, paid_cents: row.paid_cents,
      remaining_due_cents: remaining, status,
    }
  }

  function statementsFor(creditAccountId, at = now()) {
    return statements.filter((s) => Number(s.credit_account_id) === Number(creditAccountId))
      .sort((a, b) => (a.statement_year - b.statement_year) || (a.statement_month - b.statement_month))
      .map((s) => statementView(s, at))
  }

  function creditAccountsView(at = now()) {
    return creditAccounts.map((ca) => {
      const a = accountById.get(Number(ca.account_id))
      const c = cardByAccount.get(Number(ca.account_id))
      const stmts = statementsFor(ca.id, at)
      const issuedUnpaid = stmts.filter((s) => s.issued).reduce((sum, s) => sum + Math.max(0, s.remaining_due_cents), 0)
      const unissuedPosted = stmts.filter((s) => !s.issued).reduce((sum, s) => sum + Math.max(0, s.remaining_due_cents), 0)
      return {
        id: ca.id, account_id: ca.account_id, account_name: a ? a.account_name : null,
        account_type: 'credit', account_status: a ? a.status : null,
        card: c ? { id: c.id, masked_card_number: c.masked_card_number, card_type: c.card_type, status: c.status } : null,
        credit_limit_cents: ca.credit_limit_cents,
        posted_outstanding_cents: ca.posted_outstanding_cents,
        pending_occupied_cents: ca.pending_occupied_cents,
        available_credit_cents: ca.credit_limit_cents - ca.posted_outstanding_cents - ca.pending_occupied_cents,
        issued_unpaid_cents: issuedUnpaid, unissued_posted_cents: unissuedPosted,
        repayable_total_cents: issuedUnpaid + unissuedPosted, statements: stmts,
      }
    })
  }

  function statementDetailView(statementId, at = now()) {
    const row = statementById.get(Number(statementId))
    if (!row) return null
    const stmt = statementView(row, at)
    const ca = creditById.get(Number(row.credit_account_id))
    const items = ca ? transactions.filter((t) => Number(t.account_id) === Number(ca.account_id)
      && t.flow_kind === 'external' && t.status === 'posted'
      && t.posted_at >= row.period_start && t.posted_at < row.period_end)
      .sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at) || Number(b.id) - Number(a.id))
      .map((t) => ({
        id: t.id, merchant: t.merchant, category: t.category, description: t.description,
        amount_cents: t.amount_cents, transaction_at: t.transaction_at, posted_at: t.posted_at,
      })) : []
    const payments = (paymentsByStatement.get(Number(statementId)) || [])
      .sort((a, b) => Date.parse(a.paid_at) - Date.parse(b.paid_at) || Number(a.id) - Number(b.id))
      .map((p) => ({ repayment_ref: p.repayment_ref, amount_cents: p.amount_cents, paid_at: p.paid_at }))
    return { ...stmt, items, payments }
  }

  function repaymentView(row) {
    if (!row) return null
    const v = {
      ref_no: row.ref_no, scope: row.scope || 'statement',
      from_account_id: row.from_account_id, from_account_name: row.from_account_name,
      credit_account_id: row.credit_account_id, credit_account_name: row.credit_account_name,
      statement_id: row.statement_id, statement_month: row.statement_month,
      amount_cents: row.amount_cents, risk_level: row.risk_level,
      status: effectiveOpStatus(row, now().toISOString()),
      created_at: row.created_at, expires_at: row.expires_at, confirmed_at: row.confirmed_at,
    }
    const allocs = allocByRef.get(row.ref_no) || []
    v.allocations = allocs.map((a) => {
      const s = statementById.get(Number(a.statement_id))
      return {
        statement_id: a.statement_id, amount_cents: a.amount_cents, statement_version: a.statement_version,
        statement_month: s ? `${String(s.statement_year).padStart(4, '0')}-${String(s.statement_month).padStart(2, '0')}` : null,
        issued: s ? s.issued_at != null : null,
      }
    })
    v.allocation_count = v.allocations.length
    const stmt = statementById.get(Number(row.statement_id))
    if (stmt) v.statement = statementView(stmt)
    return v
  }

  // —— 任务 ——
  function taskView(row) {
    if (!row) return null
    const nodes = (nodesByTask.get(Number(row.id)) || [])
      .sort((a, b) => a.seq - b.seq)
      .map((n) => ({
        node_key: n.node_key, label: ({
          monthly_analysis: '月度支出分析', subscription_query: '生效订阅查询', await_selection: '等待选择订阅',
          prepare_pause: '准备暂停单', await_confirmation: '等待界面确认', verify_result: '核验执行结果', summary: '汇总回执',
        })[n.node_key] || n.node_key,
        status: n.status, result: n.result_json ?? null, error: n.error || '',
      }))
    const op = row.op_ref ? subscriptionOpView(opsByRef.get(row.op_ref)) : null
    return {
      task_no: row.task_no, kind: row.kind, status: row.status, month: row.month,
      session_id: row.session_id, selected_subscription_id: row.selected_subscription_id,
      selected_subscription: row.selected_subscription_id ? (() => {
        const s = subById.get(Number(row.selected_subscription_id))
        return s ? { id: s.id, merchant: s.merchant, amount_cents: s.amount_cents, billing_cycle: s.billing_cycle, next_billing_date: s.next_billing_date, status: s.status } : null
      })() : null,
      op_ref: row.op_ref, op,
      selectable_subscriptions: subscriptionsView().filter((s) => s.status === 'active'),
      result_summary: row.result_summary ?? null, failure_reason: row.failure_reason || '',
      created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at, nodes,
    }
  }

  function recentTasks(limit = 20) {
    return taskRows.slice(0, limit).map(taskView)
  }

  function activityView({ type, status, limit = 50, offset = 0 } = {}) {
    const rows = []
    for (const r of transferOps) {
      rows.push({
        key: `transfer:${r.ref_no}`, kind: 'transfer', ref_no: r.ref_no, task_no: null,
        status: effectiveOpStatus(r, now().toISOString()), action: null, object: r.recipient_name, amount_cents: r.amount_cents,
        billing_cycle: null, month: null, op_ref: null, created_at: r.created_at,
        created_ms: toEpochMs(r.created_at), completed_at: toIso(r.confirmed_at),
        updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    }
    for (const r of cardOps) {
      rows.push({
        key: `card_op:${r.ref_no}`, kind: 'card_op', ref_no: r.ref_no, task_no: null,
        status: effectiveOpStatus(r, now().toISOString()), action: r.action, object: r.card_masked, amount_cents: null,
        billing_cycle: null, month: null, op_ref: null, created_at: r.created_at,
        created_ms: toEpochMs(r.created_at), completed_at: toIso(r.confirmed_at),
        updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    }
    const taskOpRefs = new Set(taskRows.map((t) => t.op_ref).filter(Boolean))
    for (const r of subOps) {
      if (taskOpRefs.has(r.ref_no)) continue
      rows.push({
        key: `subscription_op:${r.ref_no}`, kind: 'subscription_op', ref_no: r.ref_no, task_no: null,
        status: effectiveOpStatus(r, now().toISOString()), action: r.action, object: r.merchant, amount_cents: r.amount_cents,
        billing_cycle: r.billing_cycle, month: null, op_ref: null, created_at: r.created_at,
        created_ms: toEpochMs(r.created_at), completed_at: toIso(r.confirmed_at),
        updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    }
    for (const r of repayOps) {
      rows.push({
        key: `repayment:${r.ref_no}`, kind: 'repayment', ref_no: r.ref_no, task_no: null,
        status: effectiveOpStatus(r, now().toISOString()), action: 'repay', object: `${r.credit_account_name} · ${r.statement_month}`,
        amount_cents: r.amount_cents, billing_cycle: null, month: r.statement_month || null, op_ref: null,
        created_at: r.created_at, created_ms: toEpochMs(r.created_at),
        completed_at: toIso(r.confirmed_at), updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    }
    for (const t of taskRows.map(taskView)) {
      rows.push({
        key: `task:${t.task_no}`, kind: 'task', ref_no: null, task_no: t.task_no,
        status: t.status, action: null, object: taskMerchant(t), amount_cents: taskAmount(t),
        billing_cycle: taskCycle(t), month: t.month || null, op_ref: t.op_ref || null,
        created_at: toIso(t.created_at), created_ms: toEpochMs(t.created_at),
        completed_at: toIso(t.completed_at), updated_at: toIso(t.updated_at),
      })
    }
    const statusList = status ? String(status).split(',').map((s) => s.trim()).filter(Boolean) : null
    let filtered = rows
    if (type) filtered = filtered.filter((r) => r.kind === type)
    if (statusList && statusList.length) filtered = filtered.filter((r) => statusList.includes(r.status))
    filtered.sort((a, b) => {
      if (a.created_ms !== b.created_ms) return b.created_ms - a.created_ms
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      const ak = a.task_no || a.ref_no || ''
      const bk = b.task_no || b.ref_no || ''
      return ak < bk ? -1 : ak > bk ? 1 : 0
    })
    const total = filtered.length
    const page = filtered.slice(offset, offset + limit).map(({ created_ms, ...rest }) => rest)
    return { rows: page, total }
  }

  // —— 会话 ——
  function visibleMessages(sessionId) {
    return (messagesBySession.get(sessionId) || [])
      .slice()
      .sort((a, b) => a.seq - b.seq || Number(a.id) - Number(b.id))
      .map((m) => ({
        role: m.role, text: m.text, toolRecords: m.tool_records_json || [],
        incomplete: !!m.incomplete, error: m.error || '',
      }))
  }
  function conversationView(sessionId) {
    if (!sessionId || !chatSessions.some((s) => s.id === sessionId)) return { sessionId: null, messages: [] }
    return { sessionId, messages: visibleMessages(sessionId) }
  }
  function currentConversation() {
    const id = chatState && chatState.current_session_id ? chatState.current_session_id : null
    if (!id) return { sessionId: null, messages: [] }
    return conversationView(id)
  }
  function listConversations() {
    return chatSessions.map((s) => {
      const first = (messagesBySession.get(s.id) || []).filter((m) => m.role === 'user')
        .sort((a, b) => a.seq - b.seq || Number(a.id) - Number(b.id))[0]
      return {
        id: s.id, title: first ? first.text : '', lastActiveAt: s.last_active_at,
        messageCount: (messagesBySession.get(s.id) || []).length,
      }
    })
  }

  function verificationStatus() {
    const v = snap.verification || {}
    const nowIso = now().toISOString()
    const locked = !!v.locked_until && nowIso < v.locked_until
    return {
      bound: v.bound === true,
      locked,
      locked_until: locked ? v.locked_until : null,
      remaining_attempts: Math.max(0, MAX_VERIFY_FAILURES - (Number(v.fail_count) || 0)),
    }
  }

  return {
    snapshot: snap,
    accounts: accountsView,
    cards: cardsView,
    subscriptions: subscriptionsView,
    transactions: transactionsView,
    analytics: analyticsView,
    creditAccounts: creditAccountsView,
    statements: (creditAccountId, at = now()) => statementsFor(creditAccountId, at),
    statementDetail: statementDetailView,
    repayment: repaymentView,
    transfer: transferView,
    cardOp: cardView,
    subscriptionOp: subscriptionOpView,
    task: taskView,
    recentTasks,
    activity: activityView,
    currentConversation,
    listConversations,
    conversation: conversationView,
    verificationStatus,
    // 供写操作后按 ref 查找
    transferOp: (ref) => transferView(transferOps.find((o) => o.ref_no === ref)),
    cardOpByRef: (ref) => cardView(cardOps.find((o) => o.ref_no === ref)),
    subscriptionOpByRef: (ref) => subscriptionOpView(subOps.find((o) => o.ref_no === ref)),
    repaymentByRef: (ref) => repaymentView(repayOps.find((o) => o.ref_no === ref)),
    taskByNo: (no) => taskView(taskRows.find((t) => t.task_no === no)),
  }
}

export async function loadCloudStore({ client, userId }) {
  const raw = await client.snapshot(userId)
  if (!raw || typeof raw !== 'object' || !raw.user) {
    throw new Error('CloudBase 快照缺少用户数据（请先执行 003_seed_v1.sql）')
  }
  return buildCloudStore(raw)
}

export { DAILY_TRANSFER_LIMIT_CENTS, MAX_VERIFY_FAILURES }
