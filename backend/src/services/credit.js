// 信用卡服务：消费（待入账占额）→ 入账（按入账时间归账期欠款）→ 出账（冻结账单）→ 全额还款（强验证）。
//
// 账单边界（本阶段规则）：
// - 每张信用卡关联一个独立信用账户（accounts.account_type='credit'），其 balance_cents 恒为 0；
//   信用额度 / 已入账未还 / 待入账占用在 credit_accounts 单独维护，避免与活期余额语义混淆。
// - 消费：createCreditConsumption 记「待入账」流水（status='pending'，flow_kind='external'，posted_at=NULL）并占用额度。
// - 入账：postCreditConsumption 把待入账转已入账，按 posted_at（入账时间）的上海自然月归入唯一账单（statements），
//   额度占用→已入账欠款，不重复占额、不重复计债。交易发生时间 transaction_at 与入账时间 posted_at 分开存储；
//   出账后才入账的旧交易（transaction_at 较早、posted_at 在后续月份）自然进入后续未出账账期，不重开已出账账单。
// - 出账：issueStatements 在出账日（issued_on <= now）把未出账账单冻结（issued_at 置值），出账金额与消费明细自此固定；
//   未出账消费不得显示为已出账应还。出账日=下月 1 日、到期日=下月 25 日（按 Asia/Shanghai 边界）。
// - 还款：两种全额模式，恒为红色强验证（交易密码 + TOTP），复用验证服务：
//   scope='statement' 指定已出账账单全额；scope='all_posted' 结清全部已入账欠款（已出账未还 + 未出账已入账消费，
//   待入账占用不计入），按「已出账优先、旧账期优先」分配，未出账消费可提前还款并保留 paid_cents，出账后不重复计债。
//   建单冻结每个账单的冲抵金额与版本（repayment_allocations），确认时逐条复核；金额不符则拒绝执行并解释、不自动换金额。
//   一笔操作单可产生多条冲抵明细（statement_payments），付款流水仍按操作单编号唯一。
//   还款不记为消费支出/收入（flow_kind='repayment'，analytics 排除并单列）。
// - 冻结：信用卡冻结（cards.status='frozen'）期间禁止新增消费，但允许还款与已待入账流水正常入账。
//   冻结 / 解冻本身复用现有 card-operations.js，不在本模块实现。
// - 消费 / 入账 / 出账为内部模拟能力（供演示数据 / 验证脚本调用），不暴露为 HTTP 写接口或 AI 工具。
import { randomUUID } from 'node:crypto'
import { shanghaiMonthRange, shanghaiNowParts, SHANGHAI_OFFSET_MS } from '../lib/shanghai.js'

export const REPAYMENT_EXPIRY_MS = 5 * 60 * 1000 // 还款操作单确认有效期：5 分钟

export class CreditError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'CreditError'
    this.code = code
  }
}

const STATEMENT_COLS = `
  id, user_id, credit_account_id, statement_year, statement_month,
  period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents, version
`
const REPAYMENT_COLS = `
  id, ref_no, user_id, session_id, scope, from_account_id, from_account_name, credit_account_id, credit_account_name,
  statement_id, statement_month, amount_cents, statement_version, risk_level, status,
  created_at, expires_at, confirmed_at
`

function nextMonth(year, month) {
  let y = year
  let m = month + 1
  if (m > 12) {
    m = 1
    y += 1
  }
  return { year: y, month: m }
}

function shanghaiDayStartIso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - SHANGHAI_OFFSET_MS).toISOString()
}

// 某上海自然月的账期边界与出账/到期日
function statementPeriod(year, month) {
  const { start, end } = shanghaiMonthRange(year, month)
  const nx = nextMonth(year, month)
  return { period_start: start, period_end: end, issued_on: end, due_on: shanghaiDayStartIso(nx.year, nx.month, 25) }
}

// 入账时间对应的上海自然月（用于归账期）
function shanghaiMonthOf(iso) {
  const { year, month } = shanghaiNowParts(new Date(iso).getTime())
  return { year, month }
}

function getById(db, id) {
  return db.prepare(`SELECT ${REPAYMENT_COLS} FROM repayment_operations WHERE id = ?`).get(id)
}

// 读取某信用卡对应的信用账户 + 卡状态（供消费占额校验）
function creditAccountForCard(db, userId, cardId) {
  return db
    .prepare(
      `SELECT ca.id, ca.account_id, ca.credit_limit_cents, ca.posted_outstanding_cents, ca.pending_occupied_cents,
              ca.version AS credit_version, c.status AS card_status, a.status AS account_status, a.account_name
       FROM cards c
       JOIN accounts a ON a.id = c.account_id
       JOIN credit_accounts ca ON ca.account_id = a.id
       WHERE c.id = ? AND c.user_id = ?`,
    )
    .get(cardId, userId)
}

function upsertStatement(db, creditAccountId, userId, year, month, period) {
  const existing = db
    .prepare('SELECT * FROM statements WHERE credit_account_id = ? AND statement_year = ? AND statement_month = ?')
    .get(creditAccountId, year, month)
  if (existing) return existing
  db.prepare(
    `INSERT INTO statements
      (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, 1)`,
  ).run(userId, creditAccountId, year, month, period.period_start, period.period_end, period.issued_on, period.due_on)
  return db
    .prepare('SELECT * FROM statements WHERE credit_account_id = ? AND statement_year = ? AND statement_month = ?')
    .get(creditAccountId, year, month)
}

// —— 只读视图 ——

// 信用账户视图：额度 / 已入账未还 / 待入账占用 / 可用额度（可用 = 额度 - 已入账未还 - 待入账占用）
export function getCreditAccount(db, userId, creditAccountId) {
  const row = db
    .prepare(
      `SELECT ca.id, ca.account_id, ca.credit_limit_cents, ca.posted_outstanding_cents, ca.pending_occupied_cents,
              ca.version, a.account_name, a.status AS account_status
       FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id
       WHERE ca.user_id = ? AND ca.id = ?`,
    )
    .get(userId, creditAccountId)
  if (!row) return null
  return {
    ...row,
    account_type: 'credit',
    available_credit_cents: row.credit_limit_cents - row.posted_outstanding_cents - row.pending_occupied_cents,
  }
}

// 账单视图：出账时间 + 剩余应还 + 状态。
// status：unissued 未出账（不得作为应还展示）/ paid 已结清 / overdue 已逾期未还 / open 已出账未到期未结清。
function statementView(db, row, now = new Date()) {
  const remaining = row.new_charges_cents - row.paid_cents
  let status
  if (row.issued_at == null) status = 'unissued'
  else if (remaining <= 0) status = 'paid'
  else if (now.toISOString() >= row.due_on) status = 'overdue'
  else status = 'open'
  return {
    id: row.id,
    credit_account_id: row.credit_account_id,
    statement_month: `${String(row.statement_year).padStart(4, '0')}-${String(row.statement_month).padStart(2, '0')}`,
    period_start: row.period_start,
    period_end: row.period_end,
    issued_on: row.issued_on,
    issued_at: row.issued_at,
    issued: row.issued_at != null,
    due_on: row.due_on,
    new_charges_cents: row.new_charges_cents,
    paid_cents: row.paid_cents,
    remaining_due_cents: remaining,
    status,
  }
}

export function listStatements(db, userId, creditAccountId, now = new Date()) {
  return db
    .prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE user_id = ? AND credit_account_id = ? ORDER BY statement_year, statement_month`)
    .all(userId, creditAccountId)
    .map((r) => statementView(db, r, now))
}

export function getStatement(db, userId, statementId, now = new Date()) {
  const row = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ? AND user_id = ?`).get(statementId, userId)
  return row ? statementView(db, row, now) : null
}

// 全部信用账户（含关联卡片、额度汇总与账单列表）
export function listCreditAccounts(db, userId, now = new Date()) {
  const rows = db
    .prepare(
      `SELECT ca.id, ca.account_id, ca.credit_limit_cents, ca.posted_outstanding_cents, ca.pending_occupied_cents, ca.version,
              a.account_name, a.status AS account_status
       FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id
       WHERE ca.user_id = ? ORDER BY ca.id`,
    )
    .all(userId)
  return rows.map((ca) => {
    const card = db
      .prepare('SELECT id, masked_card_number, card_type, status FROM cards WHERE account_id = ? AND user_id = ?')
      .get(ca.account_id, userId)
    const statements = listStatements(db, userId, ca.id, now)
    // 可还款金额（服务端计算）：已出账未还 + 未出账已入账消费；待入账占用不计入
    const issuedUnpaid = statements.filter((s) => s.issued).reduce((sum, s) => sum + Math.max(0, s.remaining_due_cents), 0)
    const unissuedPosted = statements.filter((s) => !s.issued).reduce((sum, s) => sum + Math.max(0, s.remaining_due_cents), 0)
    return {
      id: ca.id,
      account_id: ca.account_id,
      account_name: ca.account_name,
      account_type: 'credit',
      account_status: ca.account_status,
      card: card
        ? { id: card.id, masked_card_number: card.masked_card_number, card_type: card.card_type, status: card.status }
        : null,
      credit_limit_cents: ca.credit_limit_cents,
      posted_outstanding_cents: ca.posted_outstanding_cents,
      pending_occupied_cents: ca.pending_occupied_cents,
      available_credit_cents: ca.credit_limit_cents - ca.posted_outstanding_cents - ca.pending_occupied_cents,
      issued_unpaid_cents: issuedUnpaid,
      unissued_posted_cents: unissuedPosted,
      repayable_total_cents: issuedUnpaid + unissuedPosted,
      statements,
    }
  })
}

// 账单详情：账单视图 + 本期已入账消费明细 + 还款冲抵明细（可追溯）。
export function getStatementDetail(db, userId, statementId, now = new Date()) {
  const row = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ? AND user_id = ?`).get(statementId, userId)
  if (!row) return null
  const stmt = statementView(db, row, now)
  const items = db
    .prepare(
      `SELECT id, merchant, category, description, amount_cents, transaction_at, posted_at
       FROM transactions
       WHERE user_id = ?
         AND account_id = (SELECT account_id FROM credit_accounts WHERE id = ?)
         AND flow_kind = 'external' AND status = 'posted'
         AND posted_at >= ? AND posted_at < ?
       ORDER BY posted_at DESC, id DESC`,
    )
    .all(userId, row.credit_account_id, row.period_start, row.period_end)
  const payments = db
    .prepare(
      `SELECT repayment_ref, amount_cents, paid_at FROM statement_payments WHERE statement_id = ? AND user_id = ? ORDER BY paid_at ASC, id ASC`,
    )
    .all(statementId, userId)
  return { ...stmt, items, payments }
}

// —— 消费 / 入账 / 出账（内部模拟，不暴露为 HTTP 写接口或 AI 工具）——

// 记录一笔「待入账」信用卡消费（占额）。cardId 指定信用卡；校验卡与账户均 active、可用额度充足。
export function createCreditConsumption(db, userId, { cardId, amountCents, category = '购物', merchant = null, transactionAt }, now = new Date()) {
  if (typeof cardId !== 'number' || !Number.isSafeInteger(cardId) || cardId <= 0) {
    throw new CreditError('卡片不合法', 'bad_card')
  }
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new CreditError('金额必须为正整数（单位：分）', 'bad_amount')
  }
  const rel = creditAccountForCard(db, userId, cardId)
  if (!rel) throw new CreditError('未找到该信用卡', 'not_found')
  if (rel.card_status !== 'active') throw new CreditError('该卡已冻结或注销，禁止新增消费', 'card_frozen')
  if (rel.account_status !== 'active') throw new CreditError('信用账户状态异常，禁止新增消费', 'account_inactive')
  const available = rel.credit_limit_cents - rel.posted_outstanding_cents - rel.pending_occupied_cents
  if (amountCents > available) throw new CreditError('信用额度不足', 'insufficient_credit')

  const tAt = typeof transactionAt === 'string' && transactionAt ? transactionAt : now.toISOString()
  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO transactions
          (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
         VALUES (?, ?, 'expense', ?, ?, ?, '信用卡消费', ?, 'pending', 'external')`,
      )
      .run(userId, rel.account_id, amountCents, category, merchant, tAt)
    const occ = db
      .prepare('UPDATE credit_accounts SET pending_occupied_cents = pending_occupied_cents + ?, version = version + 1 WHERE id = ?')
      .run(amountCents, rel.id)
    if (occ.changes !== 1) throw new Error('额度占用失败')
    return info.lastInsertRowid
  })
  return { transaction_id: run() }
}

// 待入账 → 已入账：占用转欠款，并按 posted_at（入账时间）的上海自然月归入唯一账单。幂等（已入账直接返回）。
// postedAt 缺省为「现在」（真实入账时点）；交易发生时间 transaction_at 与入账时间 posted_at 分开存储。
// 出账后才入账的旧交易（transaction_at 较早、postedAt 在后续月份）自然归入后续未出账账期，不重开已出账账单。
export function postCreditConsumption(db, userId, transactionId, { postedAt = new Date() } = {}) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(transactionId, userId)
  if (!tx) throw new CreditError('未找到该交易', 'not_found')
  if (tx.flow_kind !== 'external') throw new CreditError('仅信用卡消费流水可入账', 'bad_tx')
  if (tx.status === 'posted') return { outcome: 'already_posted', transaction_id: tx.id }
  if (tx.status !== 'pending') throw new CreditError('交易状态异常，无法入账', 'bad_status')
  const ca = db.prepare('SELECT * FROM credit_accounts WHERE account_id = ? AND user_id = ?').get(tx.account_id, userId)
  if (!ca) throw new CreditError('该交易不属于信用账户', 'not_credit')

  const postedIso = postedAt.toISOString()
  const { year, month } = shanghaiMonthOf(postedIso)
  const period = statementPeriod(year, month)

  const run = db.transaction(() => {
    const stmt = upsertStatement(db, ca.id, userId, year, month, period)
    if (stmt.issued_at != null) {
      throw new CreditError('该账期已出账，账单金额与明细已冻结，不能补入账', 'statement_issued')
    }
    const upd = db
      .prepare("UPDATE transactions SET status = 'posted', posted_at = ? WHERE id = ? AND status = 'pending'")
      .run(postedIso, tx.id)
    if (upd.changes !== 1) return { outcome: 'already_posted', transaction_id: tx.id }
    const occ = db
      .prepare(
        'UPDATE credit_accounts SET pending_occupied_cents = pending_occupied_cents - ?, posted_outstanding_cents = posted_outstanding_cents + ?, version = version + 1 WHERE id = ? AND pending_occupied_cents >= ?',
      )
      .run(tx.amount_cents, tx.amount_cents, ca.id, tx.amount_cents)
    if (occ.changes !== 1) throw new Error('额度占用转欠款失败')
    const st = db
      .prepare('UPDATE statements SET new_charges_cents = new_charges_cents + ?, version = version + 1 WHERE id = ?')
      .run(tx.amount_cents, stmt.id)
    if (st.changes !== 1) throw new Error('账单归账失败')
    return { outcome: 'posted', transaction_id: tx.id, statement_id: stmt.id }
  })
  return run()
}

// 出账：把已到出账日（issued_on <= now）且仍未出账（issued_at IS NULL）的账单冻结（issued_at 置值）。
// 幂等；返回本次出账的账单 id 数组。出账后账单金额与消费明细固定，后续补入账不再改变历史出账金额。
export function issueStatements(db, userId, creditAccountId, now = new Date()) {
  const nowIso = now.toISOString()
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, statement_year, statement_month FROM statements
         WHERE user_id = ? AND credit_account_id = ? AND issued_at IS NULL AND issued_on <= ?`,
      )
      .all(userId, creditAccountId, nowIso)
    const issued = []
    for (const r of rows) {
      const upd = db
        .prepare('UPDATE statements SET issued_at = ?, version = version + 1 WHERE id = ? AND issued_at IS NULL')
        .run(nowIso, r.id)
      if (upd.changes === 1) issued.push(r.id)
    }
    return issued
  })
  return run()
}

// —— 还款操作单 ——

export function viewRepaymentOperation(db, row) {
  const v = {
    ref_no: row.ref_no,
    scope: row.scope || 'statement',
    from_account_id: row.from_account_id,
    from_account_name: row.from_account_name,
    credit_account_id: row.credit_account_id,
    credit_account_name: row.credit_account_name,
    statement_id: row.statement_id,
    statement_month: row.statement_month,
    amount_cents: row.amount_cents,
    risk_level: row.risk_level,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
  }
  const allocs = db
    .prepare('SELECT statement_id, amount_cents, statement_version FROM repayment_allocations WHERE ref_no = ? ORDER BY id')
    .all(row.ref_no)
  // 旧操作单（迁移前）没有分配快照：退化为单账单一条
  const rawAllocs = allocs.length
    ? allocs
    : row.statement_id
      ? [{ statement_id: row.statement_id, amount_cents: row.amount_cents, statement_version: row.statement_version }]
      : []
  v.allocations = rawAllocs.map((a) => {
    const s = db.prepare('SELECT statement_year, statement_month, issued_at FROM statements WHERE id = ?').get(a.statement_id)
    return {
      ...a,
      statement_month: s ? `${String(s.statement_year).padStart(4, '0')}-${String(s.statement_month).padStart(2, '0')}` : null,
      issued: s ? s.issued_at != null : null,
    }
  })
  v.allocation_count = v.allocations.length
  const stmt = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ?`).get(row.statement_id)
  if (stmt) v.statement = statementView(db, stmt)
  return v
}

export function getRepaymentOpRow(db, refNo) {
  return db.prepare(`SELECT ${REPAYMENT_COLS} FROM repayment_operations WHERE ref_no = ?`).get(refNo)
}

// 创建还款操作单（不扣款、不冲抵）。支持两种全额模式（服务端计算金额）：
// - scope='statement'：指定已出账账单的全额还款（原有行为）；
// - scope='all_posted'：结清全部已入账欠款（已出账未还 + 未出账已入账消费），
//   按「已出账优先、旧账期优先」分配；待入账占用不计入。未出账账单允许提前还款，
//   冲抵写入该账单的 paid_cents，出账后保留（new_charges 不变、剩余 = 消费 − 已还）。
// 恒为红色强验证；冻结期间允许还款：不校验信用账户 / 卡片状态，仅校验付款账户（活期、active、余额充足）。
export function createRepaymentOperation(db, userId, { statementId, fromAccountId, sessionId = null, scope = 'statement', creditAccountId, refNo: providedRefNo = null }, now = new Date()) {
  if (scope !== 'statement' && scope !== 'all_posted') throw new CreditError('还款模式不合法', 'bad_scope')
  if (typeof fromAccountId !== 'number' || !Number.isSafeInteger(fromAccountId) || fromAccountId <= 0) {
    throw new CreditError('付款账户不合法', 'bad_account')
  }
  const fromAcct = db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'").get(fromAccountId, userId)
  if (!fromAcct) throw new CreditError('付款账户不存在或不可用', 'no_account')
  if (fromAcct.account_type !== 'deposit') throw new CreditError('还款账户须为活期账户', 'bad_account')

  let ca
  let allocations = []
  if (scope === 'statement') {
    if (typeof statementId !== 'number' || !Number.isSafeInteger(statementId) || statementId <= 0) {
      throw new CreditError('账单不合法', 'bad_statement')
    }
    const stmt = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ? AND user_id = ?`).get(statementId, userId)
    if (!stmt) throw new CreditError('未找到该账单', 'not_found')
    if (stmt.issued_at == null) throw new CreditError('该账单尚未出账，暂不能还款（未出账消费请使用「结清全部已入账欠款」）', 'not_issued')
    const remaining = stmt.new_charges_cents - stmt.paid_cents
    if (remaining <= 0) throw new CreditError('该账单已结清，无需还款', 'already_paid')
    ca = db
      .prepare('SELECT ca.*, a.account_name FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ? AND ca.user_id = ?')
      .get(stmt.credit_account_id, userId)
    if (!ca) throw new CreditError('信用账户不存在', 'not_found')
    allocations = [{ statement: stmt, amount_cents: remaining }]
  } else {
    // 全部结清：确定信用账户（显式指定，或唯一账户；多个时要求先指定信用卡）
    if (creditAccountId !== undefined && creditAccountId !== null) {
      if (typeof creditAccountId !== 'number' || !Number.isSafeInteger(creditAccountId) || creditAccountId <= 0) {
        throw new CreditError('信用账户不合法', 'bad_credit_account')
      }
      ca = db
        .prepare('SELECT ca.*, a.account_name FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ? AND ca.user_id = ?')
        .get(creditAccountId, userId)
      if (!ca) throw new CreditError('信用账户不存在', 'not_found')
    } else {
      const list = db
        .prepare('SELECT ca.*, a.account_name FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.user_id = ? ORDER BY ca.id')
        .all(userId)
      if (list.length === 0) throw new CreditError('未找到信用账户', 'not_found')
      if (list.length > 1) throw new CreditError('存在多个信用账户，请先指定信用卡', 'ambiguous_credit_account')
      ca = list[0]
    }
    const stmts = db
      .prepare(
        `SELECT ${STATEMENT_COLS} FROM statements
         WHERE user_id = ? AND credit_account_id = ? AND (new_charges_cents - paid_cents) > 0
         ORDER BY CASE WHEN issued_at IS NULL THEN 1 ELSE 0 END, statement_year, statement_month, id`,
      )
      .all(userId, ca.id)
    if (stmts.length === 0) throw new CreditError('暂无可还款项（无已入账欠款）', 'no_debt')
    allocations = stmts.map((s) => ({ statement: s, amount_cents: s.new_charges_cents - s.paid_cents }))
  }

  const total = allocations.reduce((sum, a) => sum + a.amount_cents, 0)
  if (total <= 0) throw new CreditError('暂无可还款项（无已入账欠款）', 'no_debt')
  if (fromAcct.balance_cents < total) throw new CreditError('付款账户余额不足', 'insufficient_balance')

  const primary = allocations[0].statement
  // 计划建单传入「计划号 + 版本 + 步骤」确定性编号；独立接口仍用随机 UUID。
  const refNo = typeof providedRefNo === 'string' && providedRefNo ? providedRefNo : randomUUID()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + REPAYMENT_EXPIRY_MS).toISOString()
  const statementMonth = `${String(primary.statement_year).padStart(4, '0')}-${String(primary.statement_month).padStart(2, '0')}`

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO repayment_operations
          (ref_no, user_id, session_id, scope, from_account_id, from_account_name, credit_account_id, credit_account_name,
           statement_id, statement_month, amount_cents, statement_version, risk_level, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'red', 'needs_verification', ?, ?)`,
      )
      .run(
        refNo, userId, typeof sessionId === 'string' && sessionId ? sessionId : null, scope,
        fromAcct.id, fromAcct.account_name, ca.id, ca.account_name,
        primary.id, statementMonth, total, primary.version, createdAt, expiresAt,
      )
    const insAlloc = db.prepare(
      'INSERT INTO repayment_allocations (ref_no, statement_id, amount_cents, statement_version) VALUES (?, ?, ?, ?)',
    )
    for (const a of allocations) insAlloc.run(refNo, a.statement.id, a.amount_cents, a.statement.version)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'repayment', ?, 'create', ?, ?)`,
    ).run(userId, refNo, 'needs_verification', JSON.stringify({ scope, amount_cents: total, allocations: allocations.length }))
    return getById(db, info.lastInsertRowid)
  })
  return viewRepaymentOperation(db, run())
}

// 查看还款操作单（读取时惰性过期）
export function getRepaymentOperation(db, userId, refNo, now = new Date()) {
  const row = getRepaymentOpRow(db, refNo)
  if (!row || row.user_id !== userId) return null
  if (row.status === 'needs_verification' && now.toISOString() > row.expires_at) {
    db.prepare("UPDATE repayment_operations SET status = 'expired' WHERE id = ? AND status = 'needs_verification'").run(row.id)
    return viewRepaymentOperation(db, getById(db, row.id))
  }
  return viewRepaymentOperation(db, row)
}

// 取消还款操作单（不扣款、不冲抵）
export function cancelRepaymentOperation(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getRepaymentOpRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }
    if (row.status === 'cancelled') return { outcome: 'cancelled', op: viewRepaymentOperation(db, row) }
    if (row.status === 'needs_verification' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE repayment_operations SET status = 'expired' WHERE id = ? AND status = 'needs_verification'").run(row.id)
      return { outcome: 'expired', op: viewRepaymentOperation(db, getById(db, row.id)) }
    }
    if (row.status !== 'needs_verification') return { outcome: row.status, op: viewRepaymentOperation(db, row) }
    db.prepare("UPDATE repayment_operations SET status = 'cancelled' WHERE id = ? AND status = 'needs_verification'").run(row.id)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'repayment', ?, 'cancel', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ statement_id: row.statement_id }))
    return { outcome: 'cancelled', op: viewRepaymentOperation(db, getById(db, row.id)) }
  })
  return run()
}

// 读取某助手会话最近一笔还款单的权威状态（供聊天上下文注入；不扫描全部历史，仅单条按会话索引查询）。
export function latestRepaymentForSession(db, userId, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  const row = db
    .prepare(
      `SELECT ${REPAYMENT_COLS} FROM repayment_operations
       WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, sessionId)
  if (!row) return null
  const v = viewRepaymentOperation(db, row)
  return {
    ref_no: row.ref_no,
    scope: row.scope || 'statement',
    status: row.status,
    amount_cents: row.amount_cents,
    from_account_name: row.from_account_name,
    credit_account_name: row.credit_account_name,
    statement_month: row.statement_month,
    confirmed_at: row.confirmed_at,
    statement: v.statement || null,
    allocations: v.allocations,
  }
}

// 还款执行核心：归属/账单版本与剩余应还复核 + 状态 CAS 认领 + 扣款 + 还款流水 + 冲抵明细 + 审计。
// 前置：归属、到期、终态、以及红色验证码（verifyAndConfirmRepayment）均已校验通过。
// 确认时重新核验：账单版本变化或剩余应还与建单时不一致 → 旧单失效（stale），需重建；不自动换金额。
export function finalizeRepayment(db, userId, row, now) {
  const scope = row.scope || 'statement'
  const markFailed = (reason) => {
    db.prepare("UPDATE repayment_operations SET status = 'failed' WHERE id = ? AND status = 'needs_verification'").run(row.id)
    return { outcome: 'failed', reason, op: viewRepaymentOperation(db, getById(db, row.id)) }
  }
  const markStale = (reason) => {
    db.prepare("UPDATE repayment_operations SET status = 'failed' WHERE id = ? AND status = 'needs_verification'").run(row.id)
    return { outcome: 'stale', reason, op: viewRepaymentOperation(db, getById(db, row.id)) }
  }

  // —— 复核分配明细：指定账单模式按账单版本 + 剩余；全部结清模式逐条复核 ——
  let allocations
  if (scope === 'statement') {
    const stmt = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ? AND user_id = ?`).get(row.statement_id, userId)
    if (!stmt) return markFailed('目标账单不存在')
    if (stmt.issued_at == null) return markFailed('账单尚未出账，不能还款')
    const remaining = stmt.new_charges_cents - stmt.paid_cents
    if (stmt.version !== row.statement_version || remaining !== row.amount_cents || remaining <= 0) {
      return markStale(`账单金额已变化：建单时应还 ${row.amount_cents} 分，当前应还 ${remaining} 分，请重新发起还款`)
    }
    allocations = [{ statement_id: stmt.id, amount_cents: remaining }]
  } else {
    allocations = db
      .prepare('SELECT statement_id, amount_cents, statement_version FROM repayment_allocations WHERE ref_no = ? ORDER BY id')
      .all(row.ref_no)
    if (!allocations.length) return markFailed('还款分配明细缺失')
    const allocTotal = allocations.reduce((sum, a) => sum + a.amount_cents, 0)
    if (allocTotal !== row.amount_cents) return markStale('还款金额已变化，请重新发起还款')
    for (const a of allocations) {
      const stmt = db.prepare(`SELECT ${STATEMENT_COLS} FROM statements WHERE id = ? AND user_id = ?`).get(a.statement_id, userId)
      if (!stmt) return markFailed('目标账单不存在')
      const remaining = stmt.new_charges_cents - stmt.paid_cents
      if (stmt.version !== a.statement_version || remaining !== a.amount_cents || remaining <= 0) {
        return markStale('账单金额已变化，请重新发起还款')
      }
    }
  }

  const total = allocations.reduce((sum, a) => sum + a.amount_cents, 0)
  const fromAcct = db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'").get(row.from_account_id, userId)
  if (!fromAcct || fromAcct.account_type !== 'deposit' || fromAcct.balance_cents < total) {
    return markFailed('付款账户不可用或余额不足')
  }

  // 原子认领（CAS）：仅 needs_verification → completed，防重复 / 并发执行
  const claim = db
    .prepare("UPDATE repayment_operations SET status = 'completed', confirmed_at = ? WHERE id = ? AND status = 'needs_verification'")
    .run(now.toISOString(), row.id)
  if (claim.changes !== 1) return { outcome: 'completed', op: viewRepaymentOperation(db, getById(db, row.id)) } // 幂等

  // 扣减付款账户（活期）
  const deduct = db
    .prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?')
    .run(total, row.from_account_id, total)
  if (deduct.changes !== 1) throw new Error('还款扣款失败（余额不足）')

  // 还款流水（付款账户侧，flow_kind='repayment'，不计入收支/消费；每单一条）
  const txInfo = db
    .prepare(
      `INSERT INTO transactions
        (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind, repayment_ref)
       VALUES (?, ?, 'expense', ?, '还款', NULL, '信用卡还款', ?, 'posted', 'repayment', ?)`,
    )
    .run(userId, row.from_account_id, total, now.toISOString(), row.ref_no)

  // 冲抵明细（一笔操作单可对应多条；同一账单最多一条由分配表唯一约束保证）+ 账单已冲抵 + 版本自增
  const insPay = db.prepare(
    'INSERT INTO statement_payments (user_id, statement_id, repayment_ref, amount_cents, paid_at) VALUES (?, ?, ?, ?, ?)',
  )
  const updStmt = db.prepare('UPDATE statements SET paid_cents = paid_cents + ?, version = version + 1 WHERE id = ?')
  for (const a of allocations) {
    insPay.run(userId, a.statement_id, row.ref_no, a.amount_cents, now.toISOString())
    updStmt.run(a.amount_cents, a.statement_id)
  }
  // 信用账户已入账未还减少
  db.prepare('UPDATE credit_accounts SET posted_outstanding_cents = posted_outstanding_cents - ? WHERE id = ? AND posted_outstanding_cents >= ?').run(total, row.credit_account_id, total)

  db.prepare(
    `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
     VALUES (?, 'repayment', ?, 'confirm', 'success', ?)`,
  ).run(userId, row.ref_no, JSON.stringify({ scope, amount_cents: total, allocations: allocations.length }))

  // 权威回执：清除发起该单的原始会话的「待确认」引用（仅当仍指向本单，不影响后续新单）。
  if (row.session_id) {
    db.prepare(
      `UPDATE chat_sessions SET pending_repayment_ref = NULL WHERE id = ? AND pending_repayment_ref = ?`,
    ).run(row.session_id, row.ref_no)
  }

  return { outcome: 'completed', op: viewRepaymentOperation(db, getById(db, row.id)), transaction_id: txInfo.lastInsertRowid }
}
