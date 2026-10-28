// 定向验证：交易流水「交易后结余 / 交易后可用额度」（mock 数据 + 独立临时库）。
//
// 覆盖：借记期初/收入/支出链、合法零余额、待入账不扣除、跨月、同时间多笔稳定次序、
//       分页与状态筛选后同笔结余一致、两账户不串账、还款减少现金结余且不计重复消费、
//       信用账户占额/入账/还款的时间线口径、不可追溯时显示 null。
// 不触碰开发库、不调用收费模型。用法：node scripts/verify-running-balance.js
import { initDatabase } from '../src/db/index.js'
import { listTransactions } from '../src/services/transactions.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import {
  createCreditConsumption, postCreditConsumption, issueStatements,
  createRepaymentOperation, finalizeRepayment,
} from '../src/services/credit.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-running-balance.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid

function insAccount(uid, name, type, opening) {
  return db.prepare(
    `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
     VALUES (?, ?, ?, ?, 'CNY', ?, 'active', '2026-08-01')`,
  ).run(uid, name, opening, opening, type).lastInsertRowid
}
function insCard(uid, accountId, masked, type) {
  return db.prepare(
    `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
     VALUES (?, ?, ?, ?, 'active', 5000000, '2026-08-01')`,
  ).run(uid, accountId, masked, type).lastInsertRowid
}
function addTx(uid, accountId, direction, cents, atIso, { status = 'posted', flowKind = 'external', postedAt = null } = {}) {
  const id = db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, posted_at, status, flow_kind)
     VALUES (?, ?, ?, ?, '测试', '测试商户', '结余验证', ?, ?, ?, ?)`,
  ).run(uid, accountId, direction, cents, atIso, postedAt, status, flowKind).lastInsertRowid
  if (status === 'posted') {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?')
      .run(direction === 'income' ? cents : -cents, accountId)
  }
  return id
}
const iso = (s) => new Date(s).toISOString()

// 账户 D：题述场景（期初 5000 → +1500 → -299）
const D = insAccount(u1, '样例借记账户', 'deposit', 500000)
const d1 = addTx(u1, D, 'income', 150000, iso('2026-10-02T02:00:00Z'))
const d2 = addTx(u1, D, 'expense', 29900, iso('2026-10-03T02:00:00Z'))

// 账户 A：跨月 + 同时间多笔 + 待入账 + 还款
const A = insAccount(u1, '活期账户 A', 'deposit', 500000)
const aSep = addTx(u1, A, 'income', 10000, iso('2026-09-05T02:00:00Z'))
const aOct1 = addTx(u1, A, 'income', 150000, iso('2026-10-01T02:00:00Z'))
const aOct2 = addTx(u1, A, 'expense', 29900, iso('2026-10-02T02:00:00Z'))
const aSame1 = addTx(u1, A, 'income', 1000, iso('2026-10-10T02:00:00Z'))
const aSame2 = addTx(u1, A, 'expense', 500, iso('2026-10-10T02:00:00Z'))
const aPending = addTx(u1, A, 'expense', 9999, iso('2026-10-12T02:00:00Z'), { status: 'pending' })

// 账户 B：独立账户（不串账）
const B = insAccount(u1, '工资账户 B', 'deposit', 100000)
const b1 = addTx(u1, B, 'income', 50000, iso('2026-10-01T03:00:00Z'))
const b2 = addTx(u1, B, 'expense', 20000, iso('2026-10-02T03:00:00Z'))

// 账户 Z：合法零余额
const Z = insAccount(u1, '零余额账户', 'deposit', 100000)
addTx(u1, Z, 'expense', 100000, iso('2026-10-04T02:00:00Z'))

// 他人账户（归属隔离）
const O = insAccount(u2, '他人账户', 'deposit', 800000)
addTx(u2, O, 'income', 100000, iso('2026-10-04T02:00:00Z'))

// 信用账户 C：消费占额 → 入账 → 还款 → 新消费 → 待入账
const C = insAccount(u1, '人民币信用卡', 'credit', 0)
const caId = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, 500000)').run(u1, C).lastInsertRowid
const cCard = insCard(u1, C, '6259 **** **** 0001', '信用卡')
function charge(cents, atIso, postedIso = null, cardId = cCard) {
  const r = createCreditConsumption(db, u1, { cardId, amountCents: cents, category: '购物', merchant: '测试商户', transactionAt: atIso })
  if (postedIso) postCreditConsumption(db, u1, r.transaction_id, { postedAt: new Date(postedIso) })
  return r.transaction_id
}
const c1 = charge(30000, iso('2026-09-10T02:00:00Z'), iso('2026-09-12T02:00:00Z'))
const c2 = charge(20000, iso('2026-09-25T02:00:00Z'), iso('2026-09-26T02:00:00Z'))
issueStatements(db, u1, caId, new Date(iso('2026-10-05T02:00:00Z')))
const sepStmt = db.prepare('SELECT * FROM statements WHERE credit_account_id = ? AND statement_year = 2026 AND statement_month = 9').get(caId)
const repayOp = createRepaymentOperation(db, u1, { statementId: sepStmt.id, fromAccountId: A }, new Date(iso('2026-10-08T02:00:00Z')))
const repayRow = db.prepare('SELECT * FROM repayment_operations WHERE ref_no = ?').get(repayOp.ref_no)
finalizeRepayment(db, u1, repayRow, new Date(iso('2026-10-08T02:00:00Z')))
const c3 = charge(40000, iso('2026-10-10T05:00:00Z'), iso('2026-10-11T02:00:00Z'))
const c4 = charge(10000, iso('2026-10-12T05:00:00Z'))
const repayTx = db.prepare('SELECT id, transaction_at FROM transactions WHERE repayment_ref = ?').get(repayOp.ref_no)

// 信用账户 C2：两笔不同消费在同一时刻发生 → 跨行同时刻，真实先后不可证明
const C2 = insAccount(u1, '同时刻信用账户', 'credit', 0)
const ca2 = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, 100000)').run(u1, C2).lastInsertRowid
const c2Card = insCard(u1, C2, '6259 **** **** 0002', '信用卡')
const sameA = charge(10000, iso('2026-10-12T06:00:00Z'), null, c2Card)
const sameB = charge(20000, iso('2026-10-12T06:00:00Z'), null, c2Card)

// 信用账户 C3：同一行「发生 + 入账」同刻（发生必然早于入账，不算歧义）→ 仍可追溯
const C3 = insAccount(u1, '同刻入账信用账户', 'credit', 0)
const ca3 = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, 100000)').run(u1, C3).lastInsertRowid
const c3Card = insCard(u1, C3, '6259 **** **** 0003', '信用卡')
const samePost = charge(10000, iso('2026-10-13T06:00:00Z'), iso('2026-10-13T06:00:00Z'), c3Card)

// 不可追溯账户：余额与账务不一致
const X = insAccount(u1, '不可追溯账户', 'deposit', 100000)
db.prepare("INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status) VALUES (?, ?, 'income', 10000, '测试', 'x', 'x', ?, 'posted')").run(u1, X, iso('2026-10-02T02:00:00Z'))
db.prepare('UPDATE accounts SET balance_cents = 999999 WHERE id = ?').run(X)

const get = (opts) => listTransactions(db, u1, { limit: 100, offset: 0, ...opts })
const byId = (rows) => new Map(rows.map((r) => [r.id, r]))

console.log('—— 借记：题述场景 ——')
{
  const m = byId(get({ accountId: D }).rows)
  check('期初 5000 + 收入 1500 → 结余 6500', m.get(d1).balance_after_cents === 650000, String(m.get(d1).balance_after_cents))
  check('再支出 299 → 结余 6201', m.get(d2).balance_after_cents === 620100, String(m.get(d2).balance_after_cents))
  check('借记行标记为现金结余', m.get(d2).balance_kind === 'cash' && m.get(d2).balance_state === 'value')
}

console.log('—— 跨月 / 同时间 / 待入账 ——')
{
  const all = byId(get({ accountId: A }).rows)
  check('跨月：9 月收入后结余 5100', all.get(aSep).balance_after_cents === 510000, String(all.get(aSep).balance_after_cents))
  check('10 月收入后 6600（含跨月账务）', all.get(aOct1).balance_after_cents === 660000, String(all.get(aOct1).balance_after_cents))
  check('10 月支出后 6301', all.get(aOct2).balance_after_cents === 630100, String(all.get(aOct2).balance_after_cents))
  check('同时间两笔按 id 稳定次序：+1000 → 5811', all.get(aSame1).balance_after_cents === 581100, String(all.get(aSame1).balance_after_cents))
  check('同时间两笔按 id 稳定次序：-500 → 5806', all.get(aSame2).balance_after_cents === 580600, String(all.get(aSame2).balance_after_cents))
  check('待入账显示 pending，不提前影响结余', all.get(aPending).balance_state === 'pending' && all.get(aPending).balance_after_cents === null)
  check('待入账之后的账户余额未被其扣减', db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(A).b === 580600)
  const oct = get({ accountId: A, month: { year: 2026, month: 10 } })
  const octMap = byId(oct.rows)
  check('按 10 月筛选：同笔结余与全量一致', octMap.get(aOct2).balance_after_cents === 630100 && octMap.get(aSame2).balance_after_cents === 580600)
  const postedOnly = byId(get({ accountId: A, status: 'posted' }).rows)
  check('按状态筛选：同笔结余与全量一致', postedOnly.get(aSame2).balance_after_cents === 580600)
  const page1 = get({ accountId: A, limit: 2, offset: 0 })
  const page2 = get({ accountId: A, limit: 2, offset: 2 })
  const paged = byId([...page1.rows, ...page2.rows])
  check('分页后同笔结余一致', paged.get(aSame2) && paged.get(aSame2).balance_after_cents === 580600, page1.rows.length + '/' + page2.rows.length)
}

console.log('—— 账户隔离 / 零余额 / 不可追溯 ——')
{
  const b = byId(get({ accountId: B }).rows)
  check('账户 B 结余独立（收入后 1500，支出后 1300）', b.get(b1).balance_after_cents === 150000 && b.get(b2).balance_after_cents === 130000, `${b.get(b1).balance_after_cents}/${b.get(b2).balance_after_cents}`)
  const a = byId(get({ accountId: A }).rows)
  check('A 与 B 不串账（A 最终 5806）', a.get(aSame2).balance_after_cents === 580600 && b.get(b2).balance_after_cents === 130000)
  const z = get({ accountId: Z }).rows[0]
  check('合法零余额显示 0（不是不可用）', z.balance_after_cents === 0 && z.balance_state === 'value', String(z.balance_after_cents))
  const x = get({ accountId: X }).rows[0]
  check('账务与余额不一致 → 不可追溯（null）', x.balance_state === 'untraceable' && x.balance_after_cents === null)
}

console.log('—— 还款：减少现金结余、不重复计消费 ——')
{
  const a = byId(get({ accountId: A }).rows)
  check('还款后付款账户结余减少 50000', a.get(repayTx.id).balance_after_cents === 580100, String(a.get(repayTx.id) && a.get(repayTx.id).balance_after_cents))
  check('还款流水标记 flow_kind=repayment', a.get(repayTx.id).flow_kind === 'repayment')
  const ana = monthlyAnalytics(db, u1, { year: 2026, month: 10, accountId: A })
  check('月度分析（付款账户）：还款单列且不计入消费支出', ana.repayment_cents === 50000 && ana.expense_cents === 30400, `repay=${ana.repayment_cents} expense=${ana.expense_cents}`)
}

console.log('—— 信用账户：交易后可用额度 ——')
{
  const m = byId(get({ accountId: C }).rows)
  check('第 1 笔入账后可用 4700', m.get(c1).balance_after_cents === 470000, String(m.get(c1).balance_after_cents))
  check('第 2 笔入账后可用 4500', m.get(c2).balance_after_cents === 450000, String(m.get(c2).balance_after_cents))
  // 还款流水记在付款账户，不在信用账户列表中；其效果体现为后续消费的可用额度恢复
  check('还款流水不属于信用账户列表（其效果由后续额度体现）', m.has(repayTx.id) === false)
  check('还款后新消费入账可用 4600（证明还款已计入时间线；若未计应为 4100）', m.get(c3).balance_after_cents === 460000, String(m.get(c3).balance_after_cents))
  check('待入账消费占额后可用 4500（信用语义）', m.get(c4).balance_after_cents === 450000 && m.get(c4).balance_state === 'value', String(m.get(c4).balance_after_cents))
  check('信用行标记为 credit', m.get(c4).balance_kind === 'credit')
  const ca = db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE id = ?').get(caId)
  check('重放终态与信用账户当前状态一致', ca.o === 40000 && ca.p === 10000, JSON.stringify(ca))

  // 人为制造不一致 → 全部不可追溯，不用当前值冒充历史
  db.prepare('UPDATE credit_accounts SET posted_outstanding_cents = 12345 WHERE id = ?').run(caId)
  const bad = byId(get({ accountId: C }).rows)
  check('信用状态不一致 → 不可追溯（null，不冒充当前值）', [...bad.values()].every((r) => r.balance_state === 'untraceable' && r.balance_after_cents === null))
  db.prepare('UPDATE credit_accounts SET posted_outstanding_cents = 40000 WHERE id = ?').run(caId)

  // 信用账户历史交易后的额度不得等于当前可用额度（除非恰好如此）
  const m2 = byId(get({ accountId: C }).rows)
  check('历史交易后额度不等于当前可用额度', m2.get(c1).balance_after_cents !== 450000)
}

console.log('—— 同一时刻的证明边界 ——')
{
  const m = byId(get({ accountId: C2 }).rows)
  check('跨行同时刻消费：不可追溯（顺序无证据，不冒充精确值）',
    m.get(sameA).balance_state === 'untraceable' && m.get(sameB).balance_state === 'untraceable' &&
    m.get(sameA).balance_after_cents === null && m.get(sameB).balance_after_cents === null)
  const ca2Row = db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE id = ?').get(ca2)
  check('其终态仍可校验（状态和与信用账户一致）', ca2Row.o === 0 && ca2Row.p === 30000, JSON.stringify(ca2Row))

  const m3 = byId(get({ accountId: C3 }).rows)
  check('同一行「发生+入账」同刻：可追溯（入账必然晚于发生）',
    m3.get(samePost).balance_state === 'value' && m3.get(samePost).balance_after_cents === 90000,
    String(m3.get(samePost).balance_after_cents))
}

console.log('—— 全部账户视图：逐笔按所属账户，不跨账户累计 ——')
{
  const all = get({}).rows
  const map = byId(all)
  check('全部账户：借记行仍为现金结余', map.get(aSame2).balance_kind === 'cash' && map.get(aSame2).balance_after_cents === 580600)
  check('全部账户：信用行为信用额度口径', map.get(c3).balance_kind === 'credit' && map.get(c3).balance_after_cents === 460000)
  check('全部账户：不返回他人账户流水', all.every((r) => r.account_id !== O))
}

const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('临时库 integrity_check = ok', ic.length === 1 && ic[0].integrity_check === 'ok')
check('临时库 foreign_key_check 无违例', fk.length === 0)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n结余定向验证全部通过 ✅（独立临时库）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
