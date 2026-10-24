// 可选演示数据脚本（默认关闭，不接入 db:init / 启动流程，不触碰开发库）。
//
// 目标：为「多银行卡 · 信用卡」提供一份**可控样本**的隔离演示库，包含：
//   - 2 张借记卡，各自关联一个独立活期账户（deposit，含少量已入账收支）；
//   - 1 张信用卡，关联一个独立信用账户（credit，额度 ¥50000）；
//   - 跨期消费样本：上上月（已出账并结清 → paid）、上月（已出账未结清 → open/overdue）、
//     本月（已入账未出账 → unissued + 待入账占用 → pending_occupied）。
// 数据固定、可复现，演示「交易发生 / 入账 / 出账 / 还款」四种时间与账单状态机。
//
// 用法（全部显式运行，绝不自动执行）：
//   node scripts/seed-demo.js                 # 在隔离演示库 data/demo.db 生成（幂等，不碰开发库）
//   node scripts/seed-demo.js --preview       # 预览：在一次性临时库真实生成后打印清单，不落盘
//   node scripts/seed-demo.js --check [path]  # 检查演示库数据完整性（默认 data/demo.db）
//   node scripts/seed-demo.js --db <path>     # 指定目标库（未来开发库部署前请先 --preview 检查）
//
// 安全护栏：默认目标库与开发库（data/rongzhi.db）分离；若 --db 显式指向开发库，必须再加 --allow-dev-db。
import { initDatabase, DEFAULT_DB_PATH } from '../src/db/index.js'
import { openDatabase } from '../src/db/connection.js'
import { shanghaiNowParts, SHANGHAI_OFFSET_MS } from '../src/lib/shanghai.js'
import {
  createCreditConsumption,
  postCreditConsumption,
  issueStatements,
  createRepaymentOperation,
  finalizeRepayment,
} from '../src/services/credit.js'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, '..')
const DATA_DIR = join(BACKEND_DIR, 'data')
export const DEMO_DB_PATH = join(DATA_DIR, 'demo.db')

const DEMO_USER_NAME = '张三'
const OPENED_ON = '2026-08-01'

// —— 上海时间换算 ——
function monthOffset(parts, k) {
  let y = parts.year
  let m = parts.month + k
  while (m <= 0) {
    m += 12
    y -= 1
  }
  while (m > 12) {
    m -= 12
    y += 1
  }
  return { year: y, month: m }
}
function shIso(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS).toISOString()
}
function monthLabel({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`
}

// —— 可控样本（固定金额，非随机；单位：分）——
const CREDIT_LIMIT_CENTS = 5000000 // ¥50000

// 演示数据计划：纯描述，供 preview 与 seed 共用，避免两套逻辑分叉。
function buildPlan(now) {
  const parts = shanghaiNowParts(now.getTime())
  const m2 = monthOffset(parts, -2)
  const m1 = monthOffset(parts, -1)
  const cur = { year: parts.year, month: parts.month }

  const debit1 = {
    account_name: '人民币活期账户',
    opening_balance_cents: 2000000,
    card_masked: '6222 **** **** 0001',
    transactions: [
      { direction: 'income', amount_cents: 1500000, category: '收入', merchant: '薪资发放', description: '月度工资', at: shIso(m2.year, m2.month, 5, 9, 0) },
      { direction: 'income', amount_cents: 1500000, category: '收入', merchant: '薪资发放', description: '月度工资', at: shIso(m1.year, m1.month, 5, 9, 0) },
      { direction: 'expense', amount_cents: 18850, category: '餐饮', merchant: '美团外卖', description: '日常消费', at: shIso(m2.year, m2.month, 12, 12, 30) },
      { direction: 'expense', amount_cents: 120000, category: '购物', merchant: '京东商城', description: '日常消费', at: shIso(m1.year, m1.month, 10, 11, 15) },
      { direction: 'expense', amount_cents: 8620, category: '交通', merchant: '滴滴出行', description: '日常消费', at: shIso(m1.year, m1.month, 18, 8, 40) },
      { direction: 'expense', amount_cents: 35000, category: '住房', merchant: '物业费', description: '日常消费', at: shIso(m2.year, m2.month, 20, 10, 0) },
    ],
  }

  const debit2 = {
    account_name: '工资储蓄账户',
    opening_balance_cents: 500000,
    card_masked: '6222 **** **** 0002',
    transactions: [
      { direction: 'income', amount_cents: 32000, category: '收入', merchant: '理财收益', description: '月度收益', at: shIso(m1.year, m1.month, 15, 9, 0) },
      { direction: 'expense', amount_cents: 2500, category: '订阅扣费', merchant: '爱奇艺', description: '订阅自动扣费', at: shIso(cur.year, cur.month, Math.min(parts.day, 28), 9, 0) },
    ],
  }

  const credit = {
    account_name: '人民币信用卡',
    credit_limit_cents: CREDIT_LIMIT_CENTS,
    card_masked: '6259 **** **** 0003',
    posted: [
      { amount_cents: 128000, category: '购物', merchant: '京东商城', transDay: 8, postDay: 10, in: m2 },
      { amount_cents: 39900, category: '餐饮', merchant: '美团外卖', transDay: 15, postDay: 16, in: m2 },
      { amount_cents: 356000, category: '交通', merchant: '国航机票', transDay: 6, postDay: 8, in: m1 },
      { amount_cents: 89900, category: '购物', merchant: 'Apple Store', transDay: 20, postDay: 21, in: m1 },
    ],
    current_posted: { amount_cents: 29900, category: '餐饮', merchant: '星巴克' },
    current_pending: { amount_cents: 129900, category: '购物', merchant: '酒店预订' },
  }

  return { parts, m2, m1, cur, debit1, debit2, credit }
}

function insertDebitAccount(db, userId, plan, createdAt) {
  const postedIncome = plan.transactions.filter((t) => t.direction === 'income').reduce((s, t) => s + t.amount_cents, 0)
  const postedExpense = plan.transactions.filter((t) => t.direction === 'expense').reduce((s, t) => s + t.amount_cents, 0)
  const balance = plan.opening_balance_cents + postedIncome - postedExpense
  const accId = db
    .prepare(
      `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
       VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active', ?, ?)`,
    )
    .run(userId, plan.account_name, plan.opening_balance_cents, balance, OPENED_ON, createdAt).lastInsertRowid
  db.prepare(
    `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
     VALUES (?, ?, ?, '借记卡', 'active', 5000000, ?, ?)`,
  ).run(userId, accId, plan.card_masked, OPENED_ON, createdAt)
  for (const t of plan.transactions) {
    db.prepare(
      `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', 'external')`,
    ).run(userId, accId, t.direction, t.amount_cents, t.category, t.merchant, t.description, t.at)
  }
  return { account_id: accId, balance_cents: balance }
}

// 幂等：已存在演示信用数据则跳过；存在演示用户但无信用数据则拒绝（避免与开发库混用 / 破坏现有数据）。
export function seedDemoData(db, { now = new Date() } = {}) {
  const plan = buildPlan(now)
  const existingUser = db.prepare('SELECT id FROM users WHERE name = ?').get(DEMO_USER_NAME)
  if (existingUser) {
    const creditCount = db.prepare('SELECT COUNT(*) AS c FROM credit_accounts WHERE user_id = ?').get(existingUser.id).c
    if (creditCount > 0) {
      return { seeded: false, reason: '已存在信用卡演示数据，跳过（幂等，不重复插入）' }
    }
    return {
      seeded: false,
      reason: `目标库已存在演示用户「${DEMO_USER_NAME}」但无信用数据。为避免与开发库混用或破坏现有数据，请在独立空库运行。`,
    }
  }

  const createdAt = now.toISOString()
  const summary = { user: DEMO_USER_NAME, debits: [], credit: null, statements: [] }

  const run = db.transaction(() => {
    const userId = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(DEMO_USER_NAME, createdAt).lastInsertRowid

    const d1 = insertDebitAccount(db, userId, plan.debit1, createdAt)
    const d2 = insertDebitAccount(db, userId, plan.debit2, createdAt)
    summary.debits.push({ account_name: plan.debit1.account_name, card: plan.debit1.card_masked, balance_cents: d1.balance_cents, account_id: d1.account_id })
    summary.debits.push({ account_name: plan.debit2.account_name, card: plan.debit2.card_masked, balance_cents: d2.balance_cents, account_id: d2.account_id })

    // 信用账户 + 信用卡（accounts.account_type='credit'，balance_cents 恒为 0）
    const creditAcctId = db.prepare(
      `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
       VALUES (?, ?, 0, 0, 'CNY', 'credit', 'active', ?, ?)`,
    ).run(userId, plan.credit.account_name, OPENED_ON, createdAt).lastInsertRowid
    const creditCaId = db.prepare(
      'INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)',
    ).run(userId, creditAcctId, plan.credit.credit_limit_cents).lastInsertRowid
    const creditCardId = db.prepare(
      `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
       VALUES (?, ?, ?, '信用卡', 'active', 0, ?, ?)`,
    ).run(userId, creditAcctId, plan.credit.card_masked, OPENED_ON, createdAt).lastInsertRowid

    // 跨期消费 → 入账（按入账时间归账期）
    for (const p of plan.credit.posted) {
      const r = createCreditConsumption(db, userId, {
        cardId: creditCardId,
        amountCents: p.amount_cents,
        category: p.category,
        merchant: p.merchant,
        transactionAt: shIso(p.in.year, p.in.month, p.transDay, 12, 0),
      })
      postCreditConsumption(db, userId, r.transaction_id, {
        postedAt: new Date(Date.UTC(p.in.year, p.in.month - 1, p.postDay, 12, 0) - SHANGHAI_OFFSET_MS),
      })
    }
    // 本月：一笔已入账（归入本月未出账账单）、一笔待入账（占额）
    const curPosted = createCreditConsumption(db, userId, {
      cardId: creditCardId,
      amountCents: plan.credit.current_posted.amount_cents,
      category: plan.credit.current_posted.category,
      merchant: plan.credit.current_posted.merchant,
      transactionAt: now.toISOString(),
    })
    postCreditConsumption(db, userId, curPosted.transaction_id, { postedAt: now })
    createCreditConsumption(db, userId, {
      cardId: creditCardId,
      amountCents: plan.credit.current_pending.amount_cents,
      category: plan.credit.current_pending.category,
      merchant: plan.credit.current_pending.merchant,
      transactionAt: now.toISOString(),
    })

    // 出账：冻结已到出账日的上上月 / 上月账单（本月账单出账日为下月 1 日，未到 → 保持未出账）
    issueStatements(db, userId, creditCaId, now)

    // 上上月账单全额还款（走真实操作单 + 执行核心，落还款流水 / 冲抵明细 / 审计）
    const m2Stmt = db.prepare(
      'SELECT id FROM statements WHERE credit_account_id = ? AND statement_year = ? AND statement_month = ?',
    ).get(creditCaId, plan.m2.year, plan.m2.month)
    if (m2Stmt) {
      const op = createRepaymentOperation(db, userId, { statementId: m2Stmt.id, fromAccountId: d1.account_id }, now)
      const row = db.prepare('SELECT * FROM repayment_operations WHERE ref_no = ?').get(op.ref_no)
      finalizeRepayment(db, userId, row, now)
    }

    // 还款已扣款，回读两借记账户最终余额（避免摘要显示还款前余额）
    summary.debits = db.prepare(
      "SELECT account_name, balance_cents FROM accounts WHERE user_id = ? AND account_type = 'deposit' ORDER BY id",
    ).all(userId).map((a, i) => ({ ...summary.debits[i], balance_cents: a.balance_cents }))

    summary.credit = {
      account_name: plan.credit.account_name,
      card: plan.credit.card_masked,
      credit_limit_cents: plan.credit.credit_limit_cents,
    }
    summary.statements = db.prepare(
      `SELECT s.statement_year, s.statement_month, s.new_charges_cents, s.paid_cents, s.issued_at, s.due_on
       FROM statements s WHERE s.credit_account_id = ? ORDER BY s.statement_year, s.statement_month`,
    ).all(creditCaId)
    return summary
  })

  return { seeded: true, summary: run() }
}

// —— 只读检查：验证演示库结构与状态机一致性（不改库）——
export function checkDemoData(db, now = new Date()) {
  const problems = []
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(DEMO_USER_NAME)
  if (!user) return { ok: false, problems: ['未找到演示用户「张三」'] }

  const debitCards = db.prepare("SELECT c.id FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.account_type = 'deposit'").all(user.id)
  const creditCards = db.prepare("SELECT c.id FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.account_type = 'credit'").all(user.id)
  if (debitCards.length !== 2) problems.push(`借记卡应为 2 张，实际 ${debitCards.length}`)
  if (creditCards.length !== 1) problems.push(`信用卡应为 1 张，实际 ${creditCards.length}`)

  const creditAccts = db.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').all(user.id)
  if (creditAccts.length !== 1) {
    problems.push(`信用账户应为 1 个，实际 ${creditAccts.length}`)
  } else {
    const ca = creditAccts[0]
    const stmts = db.prepare('SELECT * FROM statements WHERE credit_account_id = ?').all(ca.id)
    // 已入账未还 = 各账单剩余应还之和（含未出账账单，未出账消费也计入欠款、未计入应还展示）
    const allRemaining = stmts.reduce((sum, s) => sum + (s.new_charges_cents - s.paid_cents), 0)
    if (ca.posted_outstanding_cents !== allRemaining) {
      problems.push(`posted_outstanding（${ca.posted_outstanding_cents}）≠ 各账单剩余应还之和（${allRemaining}）`)
    }
    const pendingSum = db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE user_id = ? AND account_id = ? AND flow_kind = 'external' AND status = 'pending'",
    ).get(user.id, ca.account_id).s
    if (ca.pending_occupied_cents !== pendingSum) {
      problems.push(`pending_occupied（${ca.pending_occupied_cents}）≠ 待入账消费之和（${pendingSum}）`)
    }
    const statuses = new Set()
    for (const s of stmts) {
      if (s.issued_at == null) statuses.add('unissued')
      else if (s.new_charges_cents - s.paid_cents <= 0) statuses.add('paid')
      else if (now.toISOString() >= s.due_on) statuses.add('overdue')
      else statuses.add('open')
    }
    for (const want of ['paid', 'unissued']) {
      if (!statuses.has(want)) problems.push(`缺少「${want}」状态账单（现有：${[...statuses].join(',')}）`)
    }
    if (!statuses.has('open') && !statuses.has('overdue')) {
      problems.push('缺少「open/overdue」状态账单')
    }
    const paidStmt = stmts.find((s) => s.issued_at != null && s.new_charges_cents - s.paid_cents <= 0)
    if (paidStmt) {
      const paid = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM statement_payments WHERE statement_id = ?').get(paidStmt.id).s
      if (paid !== paidStmt.new_charges_cents) problems.push(`已结清账单冲抵明细（${paid}）≠ 出账金额（${paidStmt.new_charges_cents}）`)
    }
  }
  return { ok: problems.length === 0, problems }
}

function printSummary(summary) {
  console.log(`\n演示用户：${summary.user}`)
  console.log('\n借记账户（2 张借记卡）：')
  for (const d of summary.debits) {
    console.log(`  - ${d.account_name}（${d.card}）余额 ¥${(d.balance_cents / 100).toFixed(2)}`)
  }
  console.log(`\n信用账户（1 张信用卡）：${summary.credit.account_name}（${summary.credit.card}）额度 ¥${(summary.credit.credit_limit_cents / 100).toFixed(2)}`)
  console.log('\n账单（按账期）：')
  for (const s of summary.statements) {
    const label = `${s.statement_year}-${String(s.statement_month).padStart(2, '0')}`
    const status = s.issued_at == null ? 'unissued 未出账' : (s.new_charges_cents - s.paid_cents <= 0 ? 'paid 已结清' : 'issued 已出账未结清')
    console.log(`  - ${label}  新增 ¥${(s.new_charges_cents / 100).toFixed(2)}  已还 ¥${(s.paid_cents / 100).toFixed(2)}  ${status}`)
  }
}

function parseArgs(argv) {
  const args = { mode: 'seed', db: null, allowDevDb: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--preview') args.mode = 'preview'
    else if (a === '--check') args.mode = 'check'
    else if (a === '--allow-dev-db') args.allowDevDb = true
    else if (a === '--db') args.db = argv[++i]
    else if (a === '--help' || a === '-h') args.mode = 'help'
  }
  return args
}

function resolveTarget(args) {
  if (args.mode === 'preview') return { path: join(tmpdir(), 'rongzhi-demo-preview.db'), ephemeral: true }
  if (args.mode === 'check') return { path: args.db || DEMO_DB_PATH, ephemeral: false }
  if (args.db) return { path: args.db, ephemeral: false }
  return { path: DEMO_DB_PATH, ephemeral: false }
}

const HELP = `可选演示数据脚本（默认关闭，不触碰开发库）
用法：
  node scripts/seed-demo.js                 # 在隔离演示库 data/demo.db 生成（幂等）
  node scripts/seed-demo.js --preview       # 预览：临时库真实生成后打印清单，不落盘
  node scripts/seed-demo.js --check [path]  # 检查演示库完整性（默认 data/demo.db）
  node scripts/seed-demo.js --db <path>     # 指定目标库（指向开发库须加 --allow-dev-db）
`

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'help') {
    console.log(HELP)
    return
  }

  const target = resolveTarget(args)
  if (target.path === DEFAULT_DB_PATH && !args.allowDevDb && args.mode !== 'check') {
    console.error(`✗ 目标库为开发库（${DEFAULT_DB_PATH}）。为避免破坏开发数据，请改用独立演示库，或显式加 --allow-dev-db 确认。`)
    process.exit(1)
  }

  // preview：一次性临时库真实生成 → 打印 → 清理，保证预览与落盘完全一致。
  if (args.mode === 'preview') {
    for (const p of [target.path, target.path + '-wal', target.path + '-shm']) {
      try { rmSync(p, { force: true }) } catch {}
    }
    const { db } = initDatabase({ dbPath: target.path, seed: false })
    const res = seedDemoData(db)
    db.close()
    if (!res.seeded) {
      console.error(`✗ ${res.reason}`)
    } else {
      console.log('【预览】将在目标库写入以下演示数据（未落盘）：')
      printSummary(res.summary)
    }
    for (const p of [target.path, target.path + '-wal', target.path + '-shm']) {
      try { rmSync(p, { force: true }) } catch {}
    }
    process.exit(res.seeded ? 0 : 1)
  }

  // check：只读校验
  if (args.mode === 'check') {
    const db = openDatabase(target.path)
    const r = checkDemoData(db)
    db.close()
    if (r.ok) {
      console.log('✓ 演示库数据完整，状态机一致（2 借记卡 + 1 信用卡；paid / open·overdue / unissued 覆盖）')
      process.exit(0)
    }
    console.error('✗ 演示库检查未通过：')
    for (const p of r.problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // seed：隔离演示库生成（幂等）
  const { db } = initDatabase({ dbPath: target.path, seed: false })
  const res = seedDemoData(db)
  if (res.seeded) {
    console.log(`✓ 已写入隔离演示库：${target.path}`)
    printSummary(res.summary)
  } else {
    console.log(`⊘ ${res.reason}`)
  }
  db.close()
}

// 仅在被直接执行时运行 main；被 import（如验证脚本）时不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
