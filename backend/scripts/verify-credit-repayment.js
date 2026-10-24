// 信用卡还款模型 / 迁移验证脚本：仅在独立临时库上运行，不触碰、不迁移开发库，不调用收费模型。
//
// 覆盖：
//  A. 旧库兼容：旧结构库（accounts 无 account_type、transactions 无 flow_kind/repayment_ref、card_type 现状）
//     经 createSchema + migrate 后补列正确回填、旧数据（balance_cents / card_type / 交易）不被破坏；
//     新表建立；重复迁移幂等。
//  B. 模型与演示闭环：两张借记卡各自独立活期账户、一张信用卡独立信用账户（全 CNY）；
//     消费（待入账占额）→ 入账（欠款，按入账时间归账期）→ 出账（冻结账单）→ 全额还款（强验证）→ 额度恢复。
//  C. 七项重点：待入账转已入账不重复占额 / 跨期账单不重复计债 / 还款不重复统计支出 /
//     重复确认只执行一次 / 越权拒绝 / 冻结可还款且禁止新增消费 / 账期归属以入账时间（posted_at）为准的月初边界。
//  D. 强验证接线：错误凭据拒绝且不扣款、未绑定被拒。
//  E. 账单边界定向验证（规则 2/3/4/8/10）：出账后旧交易补入账被拒、已出账金额不变、
//     出账后才入账的旧交易进入后续未出账账期、还款付款账户须为活期。
//  F. 信用卡账户不可对外转账（服务层）。
// 用法：node scripts/verify-credit-repayment.js
import { initDatabase } from '../src/db/index.js'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import {
  createCreditConsumption, postCreditConsumption, createRepaymentOperation, getRepaymentOperation,
  getCreditAccount, listStatements, getStatement, issueStatements, CreditError,
} from '../src/services/credit.js'
import { createTransfer, TransferError } from '../src/services/transfers.js'
import { bindVerification, verifyAndConfirmRepayment, VerificationError, getVerificationStatus } from '../src/services/verification.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_MIGRATE = join(tmpdir(), 'rongzhi-credit-migrate-test.db')
const DB_MODEL = join(tmpdir(), 'rongzhi-credit-model-test.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
function shDate(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS)
}
function shIso(year, month, day, hour = 12, minute = 0) {
  return shDate(year, month, day, hour, minute).toISOString()
}

// 强验证测试常量（非真实凭据）
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'demo-pass-123'

// ============ A. 迁移：旧库兼容 ============
for (const p of [DB_MIGRATE, DB_MIGRATE + '-wal', DB_MIGRATE + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
{
  const db = openDatabase(DB_MIGRATE)
  // 构造「旧结构」库（当前发布结构，无 account_type / flow_kind / repayment_ref；balance_cents NOT NULL、card_type 现状）
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_name TEXT NOT NULL,
      opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
      opened_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      category TEXT NOT NULL,
      merchant TEXT,
      description TEXT,
      transaction_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','pending')),
      transfer_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      masked_card_number TEXT NOT NULL,
      card_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','cancelled')),
      daily_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit_cents >= 0),
      issued_on TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  db.prepare("INSERT INTO users (name) VALUES ('张三')").run()
  db.prepare("INSERT INTO accounts (user_id, account_name, balance_cents, currency, status) VALUES (1, '人民币活期账户', 4233109, 'CNY', 'active')").run()
  db.prepare("INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (1, 1, '6222 **** **** 1234', '借记卡', 'active', 5000000)").run()
  db.prepare("INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at, status) VALUES (1, 1, 'expense', 56306, '餐饮', '2026-10-01T00:00:00.000Z', 'posted')").run()

  const colsBefore = db.prepare('PRAGMA table_info(accounts)').all().map((r) => r.name)
  check('A1 迁移前账户无 account_type 列', !colsBefore.includes('account_type'))

  createSchema(db) // 建立新表（credit_accounts 等）
  migrate(db)      // 补列 + 回填（幂等）

  const acc = db.prepare('SELECT * FROM accounts LIMIT 1').get()
  const tx = db.prepare('SELECT * FROM transactions LIMIT 1').get()
  const card = db.prepare('SELECT card_type FROM cards LIMIT 1').get()
  check('A2 迁移后账户 account_type 回填为 deposit', acc.account_type === 'deposit', acc.account_type)
  check('A3 迁移后流水 flow_kind 回填为 external', tx.flow_kind === 'external', tx.flow_kind)
  check('A4 迁移后流水 repayment_ref 为 NULL', tx.repayment_ref === null)
  check('A5 迁移不改动 balance_cents', acc.balance_cents === 4233109, String(acc.balance_cents))
  check('A6 迁移不改动 card_type', card.card_type === '借记卡', card.card_type)
  check('A7 迁移不改动交易条数', db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c === 1)

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  check('A8 新表 credit_accounts 已建立', tables.includes('credit_accounts'))
  check('A9 新表 statements 已建立', tables.includes('statements'))
  check('A10 新表 statement_payments 已建立', tables.includes('statement_payments'))
  check('A11 新表 repayment_operations 已建立', tables.includes('repayment_operations'))

  // 重复迁移：幂等，不重复加列
  migrate(db)
  const accCols = db.prepare('PRAGMA table_info(accounts)').all().map((r) => r.name)
  check('A12 重复迁移不重复加 account_type 列', accCols.filter((n) => n === 'account_type').length === 1)
  check('A13 重复迁移后账户条数不变', db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c === 1)
  db.close()
}

// ============ B/C/D/E/F：模型与验证（全新库，手动建数） ============
for (const p of [DB_MODEL, DB_MODEL + '-wal', DB_MODEL + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const { db } = initDatabase({ dbPath: DB_MODEL, seed: false })

const userId = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const user2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid

function insertAccount(uid, name, type, balance, opening = balance) {
  return db.prepare(
    "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, ?, ?, ?, 'CNY', 'active', ?)",
  ).run(uid, name, opening, balance, type).lastInsertRowid
}
function insertCard(uid, accountId, masked, type) {
  return db.prepare(
    "INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, ?, ?, 'active', 0)",
  ).run(uid, accountId, masked, type).lastInsertRowid
}
function insertRecipient(name, masked) {
  return db.prepare(
    "INSERT INTO transfer_recipients (name, masked_account) VALUES (?, ?)",
  ).run(name, masked).lastInsertRowid
}

// 两张借记卡各自独立活期账户 + 一张信用卡独立信用账户（全 CNY）
const debitA = insertAccount(userId, '人民币活期账户 A', 'deposit', 1000000)
const debitB = insertAccount(userId, '人民币活期账户 B', 'deposit', 300000)
const creditAcct = insertAccount(userId, '人民币信用账户', 'credit', 0, 0)
const creditCa = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)').run(userId, creditAcct, 500000).lastInsertRowid
const cardA = insertCard(userId, debitA, '6222 **** **** 0001', '借记卡')
const cardB = insertCard(userId, debitB, '6222 **** **** 0002', '借记卡')
const cardCredit = insertCard(userId, creditAcct, '6259 **** **** 0003', '信用卡')
const user2Debit = insertAccount(user2, '李四活期账户', 'deposit', 999999)
const recipient = insertRecipient('测试收款人', '6222 **** **** 9999')

const accountTypes = db.prepare('SELECT account_type FROM accounts WHERE user_id = ? ORDER BY id').all(userId).map((r) => r.account_type)
check('B1 张三两个活期账户 + 一个信用账户', accountTypes.join(',') === 'deposit,deposit,credit', accountTypes.join(','))
check('B2 三账户均 CNY', db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE user_id = ? AND currency = 'CNY'").get(userId).c === 3)
const caView = getCreditAccount(db, userId, creditCa)
check('B3 信用账户可用额度 = 额度 500000', caView.available_credit_cents === 500000, String(caView.available_credit_cents))
check('B4 信用账户 balance_cents 恒为 0', db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(creditAcct).b === 0)

// 消费 + 按入账时间（posted_at）入账；transaction_at（发生时间）与 posted_at（入账时间）分开。
function consumeAndPost(amount, month, postedDay = 20, transactionDay = 15) {
  const [y, mo] = month.split('-').map(Number)
  const at = shIso(y, mo, transactionDay, 12, 0)
  const r = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: amount, category: '购物', merchant: '测试商户', transactionAt: at })
  postCreditConsumption(db, userId, r.transaction_id, { postedAt: shDate(y, mo, postedDay, 12, 0) })
  return r.transaction_id
}
function credit() {
  return db.prepare('SELECT * FROM credit_accounts WHERE id = ?').get(creditCa)
}
function debitBal(accountId) {
  return db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(accountId).b
}
function stmtOf(month) {
  const s = listStatements(db, userId, creditCa).find((x) => x.statement_month === month)
  return s ? getStatement(db, userId, s.id) : null
}

// —— 绑定验证器（后续强验证复用）——
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
check('B5 绑定强验证器成功', getVerificationStatus(db, userId).bound === true)

// —— B. 演示闭环：消费 → 入账 → 出账 → 还款 → 额度恢复 ——
{
  const r = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 100000, category: '购物', merchant: '京东商城', transactionAt: shIso(2026, 10, 15, 12, 0) })
  check('B6 待入账消费占用额度', credit().pending_occupied_cents === 100000 && credit().posted_outstanding_cents === 0, JSON.stringify({ p: credit().pending_occupied_cents, o: credit().posted_outstanding_cents }))
  check('B7 待入账消费入账前不产生账单', listStatements(db, userId, creditCa).length === 0)

  const posted = postCreditConsumption(db, userId, r.transaction_id, { postedAt: shDate(2026, 10, 20, 12, 0) })
  check('B8 入账后占用转欠款', credit().pending_occupied_cents === 0 && credit().posted_outstanding_cents === 100000)
  const stmts = listStatements(db, userId, creditCa)
  check('B9 入账产生 2026-10 账单', stmts.length === 1 && stmts[0].statement_month === '2026-10' && stmts[0].new_charges_cents === 100000)
  check('B10 出账日 = 下月 1 日（2026-11-01 上海）', stmts[0].issued_on === shIso(2026, 11, 1, 0, 0), stmts[0].issued_on)
  check('B11 到期日 = 下月 25 日（2026-11-25 上海）', stmts[0].due_on === shIso(2026, 11, 25, 0, 0), stmts[0].due_on)
  check('B12 入账后账单未出账（unissued，不计入应还）', stmts[0].status === 'unissued' && stmts[0].issued === false)

  const stmtId = posted.statement_id
  const now = shDate(2026, 11, 5, 12, 0)
  // 出账：issued_on（2026-11-01）已到，冻结账单金额与明细；未出账消费不得作为应还
  const issuedIds = issueStatements(db, userId, creditCa, now)
  check('B12b 出账冻结 2026-10 账单', issuedIds.includes(stmtId))
  const issuedStmt = getStatement(db, userId, stmtId)
  check('B13 出账后账单 open（未到期未结清）', issuedStmt.status === 'open' && issuedStmt.issued === true && issuedStmt.remaining_due_cents === 100000)

  const op = createRepaymentOperation(db, userId, { statementId: stmtId, fromAccountId: debitA }, now)
  check('B14 还款单恒为红色强验证', op.risk_level === 'red' && op.status === 'needs_verification' && op.amount_cents === 100000)
  const goodCode = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const res = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: goodCode }, { encryptionKey: KEY, now })
  check('B15 全额还款成功', res.outcome === 'completed', res.outcome)
  check('B16 还款后付款账户扣款', debitBal(debitA) === 900000, String(debitBal(debitA)))
  check('B17 还款后账单结清', getStatement(db, userId, stmtId).status === 'paid' && getStatement(db, userId, stmtId).remaining_due_cents === 0)
  check('B18 还款后信用账户已入账未还归零（额度恢复）', credit().posted_outstanding_cents === 0 && getCreditAccount(db, userId, creditCa).available_credit_cents === 500000)
  const repayTx = db.prepare("SELECT * FROM transactions WHERE repayment_ref = ?").get(op.ref_no)
  check('B19 还款流水 flow_kind=repayment 且记为支出方向', !!repayTx && repayTx.flow_kind === 'repayment' && repayTx.direction === 'expense' && repayTx.category === '还款')
  check('B20 账单冲抵明细唯一', db.prepare('SELECT COUNT(*) AS c FROM statement_payments WHERE repayment_ref = ?').get(op.ref_no).c === 1)
}

// —— C1. 待入账转已入账不重复占额 ——
{
  const r = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 20000, transactionAt: shIso(2026, 8, 15) })
  postCreditConsumption(db, userId, r.transaction_id, { postedAt: shDate(2026, 8, 20) })
  const again = postCreditConsumption(db, userId, r.transaction_id, { postedAt: shDate(2026, 8, 20) }) // 重复入账
  check('C1 重复入账幂等返回 already_posted', again.outcome === 'already_posted', again.outcome)
  const st = stmtOf('2026-08')
  check('C1 入账不重复占额（占用 0）', credit().pending_occupied_cents === 0)
  check('C1 入账不重复计债（账单新增消费 20000）', st.new_charges_cents === 20000, String(st.new_charges_cents))
  check('C1 信用已入账未还不重复累加', credit().posted_outstanding_cents === 20000, String(credit().posted_outstanding_cents))
}

// —— C2. 跨期账单不重复计债 + 到期未还如实显示 ——
{
  consumeAndPost(30000, '2026-09')
  const aug = stmtOf('2026-08')
  const sep = stmtOf('2026-09')
  check('C2 跨期两账单独立', aug.new_charges_cents === 20000 && sep.new_charges_cents === 30000)
  check('C2 已入账未还 = 两期剩余之和（不重复计债）', credit().posted_outstanding_cents === 50000, String(credit().posted_outstanding_cents))
  // 出账后观察：8 月账单到期日 2026-09-25，用「现在」=2026-11-05 看逾期，且不结转进 9 月
  const viewNow = shDate(2026, 11, 5, 12, 0)
  issueStatements(db, userId, creditCa, viewNow)
  const augOverdue = getStatement(db, userId, aug.id, viewNow)
  check('C2 8 月账单逾期状态 overdue', augOverdue.status === 'overdue', augOverdue.status)
  check('C2 逾期金额如实保留（20000）', augOverdue.remaining_due_cents === 20000)
  check('C2 逾期不结转进 9 月账单', sep.remaining_due_cents === 30000 && sep.new_charges_cents === 30000)
  // 还 9 月账单（不还 8 月），8 月逾期不受影响
  const now = shDate(2026, 11, 5, 12, 1)
  const op = createRepaymentOperation(db, userId, { statementId: sep.id, fromAccountId: debitB }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const res = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now })
  check('C2 还 9 月账单成功', res.outcome === 'completed', res.outcome)
  check('C2 还后已入账未还仅剩 8 月逾期 20000', credit().posted_outstanding_cents === 20000, String(credit().posted_outstanding_cents))
  check('C2 8 月账单未被动到', getStatement(db, userId, aug.id, viewNow).remaining_due_cents === 20000)
}

// —— C3. 还款不重复统计支出 ——
{
  // 11 月：借记卡一笔已入账支出 ¥1000 + 信用卡一笔已入账消费 ¥500 + 一笔还款 ¥500
  db.prepare(
    "INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind) VALUES (?, ?, 'expense', 100000, '餐饮', '海底捞', '日常消费', ?, 'posted', 'external')",
  ).run(userId, debitA, shIso(2026, 11, 3, 12, 0))
  consumeAndPost(50000, '2026-11')
  const nov = stmtOf('2026-11')
  const now = shDate(2026, 12, 5, 12, 2) // 11 月账单出账日 2026-12-01，需出账后才可还款
  issueStatements(db, userId, creditCa, now)
  const op = createRepaymentOperation(db, userId, { statementId: nov.id, fromAccountId: debitA }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const res = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now })
  check('C3 还款成功', res.outcome === 'completed', res.outcome)
  const ana = monthlyAnalytics(db, userId, { year: 2026, month: 11, asOf: shIso(2026, 12, 1, 0, 0) })
  // 支出 = 借记 ¥1000 + 信用卡消费 ¥500 = ¥1500；还款 ¥500 不计入
  check('C3 还款不计入支出（150000，非 200000）', ana.expense_cents === 150000, String(ana.expense_cents))
  check('C3 还款不计入收入', ana.income_cents === 0, String(ana.income_cents))
}

// —— C4. 重复确认只执行一次 ——
{
  consumeAndPost(40000, '2026-07')
  const jul = stmtOf('2026-07')
  const before = debitBal(debitA)
  const nowA = shDate(2026, 11, 5, 12, 4)
  issueStatements(db, userId, creditCa, nowA)
  const op = createRepaymentOperation(db, userId, { statementId: jul.id, fromAccountId: debitA }, nowA)
  const codeA = totpAt(SECRET_BUF, totpStep(nowA.getTime()))
  const first = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: codeA }, { encryptionKey: KEY, now: nowA })
  check('C4 首次确认成功', first.outcome === 'completed', first.outcome)
  const nowB = shDate(2026, 11, 5, 12, 6)
  const codeB = totpAt(SECRET_BUF, totpStep(nowB.getTime()))
  const second = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: codeB }, { encryptionKey: KEY, now: nowB })
  check('C4 重复确认幂等返回 completed 且不再扣款', second.outcome === 'completed' && debitBal(debitA) === before - 40000, JSON.stringify({ outcome: second.outcome, bal: debitBal(debitA), before }))
  check('C4 冲抵明细仅 1 条', db.prepare('SELECT COUNT(*) AS c FROM statement_payments WHERE repayment_ref = ?').get(op.ref_no).c === 1)
}

// —— C4b. 还款确认时账单金额已变化 → 拒绝执行（stale），不重复扣款 ——
{
  consumeAndPost(55000, '2026-04')
  const apr = stmtOf('2026-04')
  const now1 = shDate(2026, 11, 5, 12, 11)
  issueStatements(db, userId, creditCa, now1)
  const balA = debitBal(debitA)
  const balB = debitBal(debitB)
  // 同一账单两张还款单（不同付款账户），第一张确认后账单金额与版本变化，第二张确认时应被 stale 拒绝
  const op1 = createRepaymentOperation(db, userId, { statementId: apr.id, fromAccountId: debitA }, now1)
  const op2 = createRepaymentOperation(db, userId, { statementId: apr.id, fromAccountId: debitB }, now1)
  const code1 = totpAt(SECRET_BUF, totpStep(now1.getTime()))
  const first = verifyAndConfirmRepayment(db, userId, op1.ref_no, { password: PASSWORD, totp: code1 }, { encryptionKey: KEY, now: now1 })
  check('C4b 首次确认成功', first.outcome === 'completed', first.outcome)
  const now2 = shDate(2026, 11, 5, 12, 12) // 下一时间步，避免防重放误判
  const code2 = totpAt(SECRET_BUF, totpStep(now2.getTime()))
  const second = verifyAndConfirmRepayment(db, userId, op2.ref_no, { password: PASSWORD, totp: code2 }, { encryptionKey: KEY, now: now2 })
  check('C4b 金额变化后确认被拒（stale）', second.outcome === 'stale', second.outcome)
  check('C4b 拒绝不重复扣款（付款账户 B 未扣）', debitBal(debitB) === balB, String(debitBal(debitB)))
  check('C4b 付款账户 A 仅扣一次', debitBal(debitA) === balA - 55000, String(debitBal(debitA)))
}

// —— C5. 越权拒绝 ——
{
  const jul = stmtOf('2026-07')
  check('C5 他用户不能读本用户账单', getStatement(db, user2, jul.id) === null)
  let c2notFound = false
  try { createRepaymentOperation(db, user2, { statementId: jul.id, fromAccountId: user2Debit }) } catch (e) { c2notFound = e instanceof CreditError && e.code === 'not_found' }
  check('C5 他用户建还款单被拒（not_found）', c2notFound)
  let c2card = false
  try { createCreditConsumption(db, user2, { cardId: cardCredit, amountCents: 1000 }) } catch (e) { c2card = e instanceof CreditError && e.code === 'not_found' }
  check('C5 他用户消费本用户信用卡被拒（not_found）', c2card)
}

// —— C6. 冻结可还款、禁止新增消费；已待入账流水仍可入账 ——
{
  const r = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 25000, transactionAt: shIso(2026, 6, 15) })
  db.prepare("UPDATE cards SET status = 'frozen' WHERE id = ?").run(cardCredit) // 模拟冻结（真实冻结走 card_operations）
  let frozen = false
  try { createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 1000 }) } catch (e) { frozen = e instanceof CreditError && e.code === 'card_frozen' }
  check('C6 冻结后禁止新增消费（card_frozen）', frozen)
  const posted = postCreditConsumption(db, userId, r.transaction_id, { postedAt: shDate(2026, 6, 20) })
  check('C6 冻结不影响已待入账流水入账', posted.outcome === 'posted', posted.outcome)
  const jun = stmtOf('2026-06')
  const now = shDate(2026, 11, 5, 12, 8)
  issueStatements(db, userId, creditCa, now)
  const op = createRepaymentOperation(db, userId, { statementId: jun.id, fromAccountId: debitA }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const res = verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now })
  check('C6 冻结期间允许还款', res.outcome === 'completed', res.outcome)
  db.prepare("UPDATE cards SET status = 'active' WHERE id = ?").run(cardCredit) // 复原
}

// —— C7. 账期归属以入账时间（posted_at）为准，月初北京时间边界 ——
{
  // 两笔交易「发生时间」完全相同（12 月 31 日 23:59 上海），但入账时间跨月：
  const tAt = shIso(2026, 12, 31, 23, 59)
  const r1 = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 11111, transactionAt: tAt })
  const r2 = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 22222, transactionAt: tAt })
  postCreditConsumption(db, userId, r1.transaction_id, { postedAt: shDate(2026, 12, 31, 23, 59) }) // 入账：12 月
  postCreditConsumption(db, userId, r2.transaction_id, { postedAt: shDate(2027, 1, 1, 0, 0) })     // 入账：1 月
  const dec = stmtOf('2026-12')
  const jan = stmtOf('2027-01')
  check('C7 12-31 23:59 入账归入 12 月账单', dec && dec.new_charges_cents === 11111, dec ? String(dec.new_charges_cents) : '无 12 月账单')
  check('C7 01-01 00:00 入账归入 1 月账单', jan && jan.new_charges_cents === 22222, jan ? String(jan.new_charges_cents) : '无 1 月账单')
}

// —— D. 强验证接线：错误凭据拒绝、未绑定被拒 ——
{
  consumeAndPost(15000, '2026-05')
  const may = stmtOf('2026-05')
  const now = shDate(2026, 11, 5, 12, 10)
  issueStatements(db, userId, creditCa, now)
  const op = createRepaymentOperation(db, userId, { statementId: may.id, fromAccountId: debitA }, now)
  const before = debitBal(debitA)
  const wrongCode = '000000'
  let bad = null
  try { verifyAndConfirmRepayment(db, userId, op.ref_no, { password: PASSWORD, totp: wrongCode }, { encryptionKey: KEY, now }) } catch (e) { bad = e instanceof VerificationError ? e.code : null }
  check('D1 错误验证码被拒（bad_credentials）', bad === 'bad_credentials', String(bad))
  check('D2 错误验证码不扣款', debitBal(debitA) === before, String(debitBal(debitA)))
  check('D3 错误验证码不改账单', getStatement(db, userId, may.id).remaining_due_cents === 15000)
  let nb = null
  try { verifyAndConfirmRepayment(db, user2, op.ref_no, { password: PASSWORD, totp: totpAt(SECRET_BUF, totpStep(now.getTime())) }, { encryptionKey: KEY, now }) } catch (e) { nb = e instanceof VerificationError ? e.code : null }
  check('D4 未绑定用户强验证被拒（not_bound）', nb === 'not_bound', String(nb))
}

// —— E. 账单边界定向验证（规则 2/3/4/8/10）——
{
  const octBefore = stmtOf('2026-10')

  // E1: 出账后才入账的旧交易（发生时间早、入账时间落在已出账账期）补入账被拒，历史出账金额不变
  const late = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 999, transactionAt: shIso(2026, 10, 5) })
  let code = null
  try { postCreditConsumption(db, userId, late.transaction_id, { postedAt: shDate(2026, 10, 21) }) } catch (e) { code = e instanceof CreditError ? e.code : null }
  check('E1 出账后旧交易补入已出账账期被拒', code === 'statement_issued', String(code))
  const octAfter = stmtOf('2026-10')
  check('E1 已出账金额不变（new_charges 不变）', octAfter.new_charges_cents === octBefore.new_charges_cents, String(octAfter.new_charges_cents))
  check('E1 补入账失败后该交易仍为待入账', db.prepare('SELECT status FROM transactions WHERE id = ?').get(late.transaction_id).status === 'pending')

  // E2: 出账后才入账且入账时间落在后续月份的旧交易，进入后续未出账账期，不重开已出账账单
  const carry = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 777, transactionAt: shIso(2026, 10, 5) })
  const postedCarry = postCreditConsumption(db, userId, carry.transaction_id, { postedAt: shDate(2026, 12, 10) })
  const dec = stmtOf('2026-12')
  check('E2 交易发生 10 月、入账 12 月 → 归入 12 月账期', postedCarry.statement_id === dec.id, String(postedCarry.statement_id))
  check('E2 10 月已出账账单未被动到', stmtOf('2026-10').new_charges_cents === octBefore.new_charges_cents)

  // E3: 还款付款账户须为活期（信用卡账户不可作还款来源）——用已出账且未结清的 8 月账单
  let badFrom = null
  try { createRepaymentOperation(db, userId, { statementId: stmtOf('2026-08').id, fromAccountId: creditAcct }, shDate(2026, 11, 5)) } catch (e) { badFrom = e instanceof CreditError ? e.code : null }
  check('E3 信用卡账户不可作还款付款账户（bad_account）', badFrom === 'bad_account', String(badFrom))
}

// —— F. 信用卡账户不可对外转账（服务层）——
{
  let bad = null
  try { createTransfer(db, userId, { recipientId: recipient, amountCents: 1000, fromAccountId: creditAcct }) } catch (e) { bad = e instanceof TransferError ? e.code : null }
  check('F1 信用卡账户对外转账被拒（bad_account）', bad === 'bad_account', String(bad))
}

db.close()
for (const p of [DB_MODEL, DB_MODEL + '-wal', DB_MODEL + '-shm', DB_MIGRATE, DB_MIGRATE + '-wal', DB_MIGRATE + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
