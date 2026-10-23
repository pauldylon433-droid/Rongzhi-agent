// 增量接入脚本：为「现有用户」在其现有库上新增第二张借记卡 + 一张信用卡（多卡接入）。
//
// 与 seed-demo.js 完全分离，职责不同：
//   - seed-demo.js 仅在「空库」生成整套演示数据（含新用户张三），对已有张三的库拒绝；
//   - 本脚本用于「已有张三」的库，只 INSERT 本阶段必要的账户与卡片，绝不 UPDATE / DELETE 任何已有数据，
//     不碰原账户余额、历史交易、会话、操作单、验证绑定、订阅。
//
// 安全与幂等：
//   - 默认 --preview 只打印计划，不落盘；显式 --apply 才写入。
//   - 目标用户按 id 核验（--user-id），不凭姓名判断（姓名仅用于展示确认）。
//   - 新增数据用固定卡号 / 账户名作「明确标识」，在事务内先查后插，重复执行不重复创建；
//     信用账户复用 credit_accounts.account_id 唯一约束 + statements(credit_account_id,年,月) 唯一约束。
//   - 基础加卡（--apply）与样例消费（--with-consumption）分离，加卡不会偷偷灌入消费或欠款。
//   - 本轮不写真实开发库；请在开发库一致性副本上运行，见 verify-add-existing-user-cards.js。
//
// 用法：
//   node scripts/add-existing-user-cards.js --db <绝对路径> --user-id <id> [--preview|--apply] [--with-consumption]
import { initDatabase } from '../src/db/index.js'
import { createCreditConsumption, postCreditConsumption, issueStatements } from '../src/services/credit.js'
import { shanghaiNowParts, SHANGHAI_OFFSET_MS } from '../src/lib/shanghai.js'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DEMO_USER_NAME = '张三'
const OPENED_ON = '2026-08-01' // 模拟开户日

// —— 明确标识（marker）：新增数据用固定卡号 / 账户名标识，重复执行据此去重 ——
export const MARKER = {
  debitAccountName: '工资储蓄账户',
  debitCardMasked: '6222 **** **** 5678',
  debitOpeningCents: 500000, // 新借记账户初始余额 ¥5000（模拟）
  creditAccountName: '人民币信用卡',
  creditCardMasked: '6259 **** **** 0003',
  creditLimitCents: 5000000, // 信用额度 ¥50000（模拟）
}

// 样例消费计划（仅 --with-consumption 使用；固定金额、明确模拟）
function buildConsumptionPlan(now) {
  const parts = shanghaiNowParts(now.getTime())
  const py = parts.year
  const pm = parts.month - 1 <= 0 ? 12 : parts.month - 1
  const prevYear = parts.month - 1 <= 0 ? parts.year - 1 : parts.year
  const shIso = (y, m, d, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min) - SHANGHAI_OFFSET_MS).toISOString()
  return [
    // 上月已入账（出账后归入上月账单）
    { amountCents: 29900, category: '餐饮', merchant: '星巴克', transactionAt: shIso(prevYear, pm, 12), postedAt: shIso(prevYear, pm, 14) },
    { amountCents: 19900, category: '购物', merchant: '京东商城', transactionAt: shIso(prevYear, pm, 20), postedAt: shIso(prevYear, pm, 21) },
    // 本月已入账（归入本月未出账账单）
    { amountCents: 39900, category: '交通', merchant: '滴滴出行', transactionAt: shIso(py, parts.month, 3), postedAt: shIso(py, parts.month, 3) },
    // 本月待入账（占额，未出账）
    { amountCents: 89900, category: '购物', merchant: '酒店预订', transactionAt: now.toISOString(), postedAt: null },
  ]
}

// 按 id 核验目标用户（不凭姓名判断）
export function resolveUser(db, userId) {
  const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId)
  if (!u) throw new Error(`未找到 id=${userId} 的用户`)
  return u
}

// 现有数据快照（用于预览 + 证明原记录保留）：只读
export function snapshot(db, userId) {
  const accounts = db.prepare('SELECT id, account_name, account_type, opening_balance_cents, balance_cents FROM accounts WHERE user_id = ? ORDER BY id').all(userId)
  const cards = db.prepare('SELECT id, account_id, masked_card_number, card_type, status FROM cards WHERE user_id = ? ORDER BY id').all(userId)
  const tx = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) s FROM transactions WHERE user_id = ?').get(userId)
  const counts = {}
  for (const t of ['chat_sessions', 'chat_messages', 'agent_tasks', 'transfer_operations', 'card_operations', 'subscription_operations', 'verification_bindings', 'repayment_operations']) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE user_id = ?`).get(userId).c } catch { counts[t] = null }
  }
  return { accounts, cards, tx, counts }
}

// 计算计划：哪些已存在、哪些将新增
export function buildPlan(db, userId) {
  const debitCard = db.prepare('SELECT id FROM cards WHERE user_id = ? AND masked_card_number = ?').get(userId, MARKER.debitCardMasked)
  const creditCard = db.prepare('SELECT id FROM cards WHERE user_id = ? AND masked_card_number = ?').get(userId, MARKER.creditCardMasked)
  const creditTx = db.prepare("SELECT COUNT(*) c FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.user_id = ? AND a.account_type = 'credit' AND t.flow_kind = 'external'").get(userId).c
  return {
    hasDebitCard: !!debitCard,
    hasCreditCard: !!creditCard,
    hasConsumption: creditTx > 0,
  }
}

// 基础加卡（--apply）：只新增账户与卡片，幂等。返回新增明细或「已存在」。
export function applyBaseCards(db, userId, now = new Date()) {
  const createdAt = now.toISOString()
  const out = { addedDebit: false, addedCredit: false, debitAccountId: null, creditAccountId: null, creditCaId: null }
  const run = db.transaction(() => {
    const debitCard = db.prepare('SELECT id FROM cards WHERE user_id = ? AND masked_card_number = ?').get(userId, MARKER.debitCardMasked)
    if (!debitCard) {
      const accId = db.prepare(
        `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
         VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active', ?, ?)`,
      ).run(userId, MARKER.debitAccountName, MARKER.debitOpeningCents, MARKER.debitOpeningCents, OPENED_ON, createdAt).lastInsertRowid
      db.prepare(
        `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
         VALUES (?, ?, ?, '借记卡', 'active', 5000000, ?, ?)`,
      ).run(userId, accId, MARKER.debitCardMasked, OPENED_ON, createdAt)
      out.addedDebit = true
      out.debitAccountId = accId
    } else {
      out.debitAccountId = db.prepare('SELECT account_id FROM cards WHERE id = ?').get(debitCard.id).account_id
    }
    const creditCard = db.prepare('SELECT id FROM cards WHERE user_id = ? AND masked_card_number = ?').get(userId, MARKER.creditCardMasked)
    if (!creditCard) {
      const accId = db.prepare(
        `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
         VALUES (?, ?, 0, 0, 'CNY', 'credit', 'active', ?, ?)`,
      ).run(userId, MARKER.creditAccountName, OPENED_ON, createdAt).lastInsertRowid
      const caId = db.prepare(
        'INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)',
      ).run(userId, accId, MARKER.creditLimitCents).lastInsertRowid
      db.prepare(
        `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
         VALUES (?, ?, ?, '信用卡', 'active', 0, ?, ?)`,
      ).run(userId, accId, MARKER.creditCardMasked, OPENED_ON, createdAt)
      out.addedCredit = true
      out.creditAccountId = accId
      out.creditCaId = caId
    } else {
      const row = db.prepare('SELECT c.account_id, ca.id caId FROM cards c JOIN credit_accounts ca ON ca.account_id = c.account_id WHERE c.id = ?').get(creditCard.id)
      out.creditAccountId = row.account_id
      out.creditCaId = row.caId
    }
  })
  run()
  return out
}

// 样例消费（仅 --with-consumption）：幂等（信用账户已有外部流水则跳过）
export function applyConsumption(db, userId, creditCaId, now = new Date()) {
  const existing = db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND account_id = (SELECT account_id FROM credit_accounts WHERE id = ?) AND flow_kind = 'external'").get(userId, creditCaId).c
  if (existing > 0) return { added: false, reason: '信用账户已存在样例消费，跳过（幂等）' }
  const creditCardId = db.prepare('SELECT c.id FROM cards c JOIN credit_accounts ca ON ca.account_id = c.account_id WHERE ca.id = ?').get(creditCaId).id
  const plan = buildConsumptionPlan(now)
  db.transaction(() => {
    for (const p of plan) {
      const r = createCreditConsumption(db, userId, { cardId: creditCardId, amountCents: p.amountCents, category: p.category, merchant: p.merchant, transactionAt: p.transactionAt }, now)
      if (p.postedAt) postCreditConsumption(db, userId, r.transaction_id, { postedAt: new Date(p.postedAt) })
    }
    issueStatements(db, userId, creditCaId, now)
  })()
  return { added: true, count: plan.length }
}

// 新增借记卡样例流水（仅 --with-debit-samples）：明确标识 + 幂等，只作用于新增账户。
// 样例：模拟工资 +1500 元、模拟消费 -299 元 → 期末 = 期初 + 收支。
export const DEBIT_SAMPLE_DESC = '验收样例(新增借记卡)'
export const DEBIT_SAMPLES = [
  { direction: 'income', amount_cents: 150000, category: '收入', merchant: '薪资发放' },
  { direction: 'expense', amount_cents: 29900, category: '餐饮', merchant: '星巴克' },
]

export function applyDebitSamples(db, userId, accountId, now = new Date()) {
  const existing = db
    .prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND account_id = ? AND description LIKE ?')
    .get(userId, accountId, `%${DEBIT_SAMPLE_DESC}%`).c
  if (existing > 0) return { added: false, reason: '已存在新增借记卡样例流水，跳过（幂等）' }
  const rows = DEBIT_SAMPLES.map((s, i) => ({
    ...s,
    description: `${DEBIT_SAMPLE_DESC}·${s.direction === 'income' ? '模拟工资' : '模拟消费'}`,
    at: new Date(now.getTime() - (DEBIT_SAMPLES.length - i) * 3600 * 1000).toISOString(),
  }))
  const delta = rows.reduce((sum, r) => sum + (r.direction === 'income' ? r.amount_cents : -r.amount_cents), 0)
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(
        `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', 'external')`,
      ).run(userId, accountId, r.direction, r.amount_cents, r.category, r.merchant, r.description, r.at)
    }
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?').run(delta, accountId, userId)
  })()
  const balance = db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(accountId).b
  return { added: true, count: rows.length, delta_cents: delta, balance_cents: balance }
}

// —— CLI ——
function parseArgs(argv) {
  const a = { db: null, userId: null, apply: false, withConsumption: false, withDebitSamples: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x === '--db') a.db = argv[++i]
    else if (x === '--user-id') a.userId = Number(argv[++i])
    else if (x === '--apply') a.apply = true
    else if (x === '--with-consumption') a.withConsumption = true
    else if (x === '--with-debit-samples') a.withDebitSamples = true
    else if (x === '--preview') a.apply = false
    else if (x === '--help' || x === '-h') a.help = true
  }
  return a
}

const HELP = `为现有用户增量接入「第二张借记卡 + 信用卡」（多卡接入）
用法：
  node scripts/add-existing-user-cards.js --db <绝对路径> --user-id <id> [--preview|--apply] [--with-debit-samples] [--with-consumption]
  --preview            默认：只打印计划，不写入
  --apply              显式写入（只 INSERT 新账户/卡片，不改已有数据）
  --with-debit-samples 仅与 --apply 连用：给新增借记账户写入带明确标识的模拟样例（幂等）
  --with-consumption   仅与 --apply 连用：给新增信用账户写入样例消费（不连用则不写任何消费/欠款）
`

function fmtCents(c) { return `¥${(c / 100).toFixed(2)}` }

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.db) { console.log(HELP); process.exit(args.help ? 0 : 1) }

  const { db } = initDatabase({ dbPath: args.db, seed: false }) // 迁移（幂等，补结构不破坏数据）
  const userId = args.userId ?? (() => {
    const us = db.prepare('SELECT id, name FROM users').all()
    if (us.length === 1) return us[0].id
    throw new Error(`库内有 ${us.length} 个用户，请用 --user-id 明确指定目标用户 id`)
  })()
  const user = resolveUser(db, userId)
  const before = snapshot(db, userId)
  const plan = buildPlan(db, userId)

  console.log(`\n目标库：${args.db}`)
  console.log(`目标用户：id=${user.id}（${user.name}）  ← 按 id 核验，非按姓名`)
  console.log(`现有账户 ${before.accounts.length} 个 / 现有卡片 ${before.cards.length} 张 / 流水 ${before.tx.c} 笔`)
  console.log(`\n计划（模拟数据，仅供演示）：`)
  console.log(`  - 新增借记卡 ${MARKER.debitCardMasked}（账户「${MARKER.debitAccountName}」，初始余额 ${fmtCents(MARKER.debitOpeningCents)}）${plan.hasDebitCard ? '  [已存在，跳过]' : ''}`)
  console.log(`  - 新增信用卡 ${MARKER.creditCardMasked}（账户「${MARKER.creditAccountName}」，额度 ${fmtCents(MARKER.creditLimitCents)}）${plan.hasCreditCard ? '  [已存在，跳过]' : ''}`)
  const debitDelta = DEBIT_SAMPLES.reduce((s, r) => s + (r.direction === 'income' ? r.amount_cents : -r.amount_cents), 0)
  console.log(`  - 借记卡样例：${args.withDebitSamples ? `是（模拟工资 ${fmtCents(150000)} + 模拟消费 ${fmtCents(29900)}，期末 ${fmtCents(MARKER.debitOpeningCents + debitDelta)}）` : '否'}`)
  console.log(`  - 样例消费：${args.withConsumption ? '是（仅信用账户，产生已出账/未出账/待入账示例）' : '否（仅加卡，不灌入消费或欠款）'}${plan.hasConsumption ? '  [已存在，跳过]' : ''}`)
  console.log(`\n原账户余额 / 历史交易 / 会话 / 操作单 / 验证绑定：一律不改动。`)

  if (!args.apply) {
    console.log(`\n（预览模式）未写入。确认后加 --apply 显式执行。`)
    db.close()
    process.exit(0)
  }

  const res = applyBaseCards(db, userId)
  let cons = null
  if (args.withConsumption) {
    cons = applyConsumption(db, userId, res.creditCaId)
  }
  let debitSamples = null
  if (args.withDebitSamples) {
    debitSamples = applyDebitSamples(db, userId, res.debitAccountId)
  }

  const after = snapshot(db, userId)
  console.log(`\n执行结果：`)
  console.log(`  - 借记卡：${res.addedDebit ? '已新增' : '已存在（跳过）'}（account_id=${res.debitAccountId}）`)
  console.log(`  - 信用卡：${res.addedCredit ? '已新增' : '已存在（跳过）'}（account_id=${res.creditAccountId}，credit_account_id=${res.creditCaId}）`)
  if (debitSamples) console.log(`  - 借记卡样例：${debitSamples.added ? `已新增 ${debitSamples.count} 笔，期末余额 ${debitSamples.balance_cents}` : debitSamples.reason}`)
  if (cons) console.log(`  - 样例消费：${cons.added ? `已新增 ${cons.count} 笔` : cons.reason}`)
  console.log(`\n新增后：账户 ${after.accounts.length} 个 / 卡片 ${after.cards.length} 张 / 流水 ${after.tx.c} 笔`)
  console.log(`原账户余额逐条保留：${before.accounts.map((a) => `${a.account_name}=${a.balance_cents}`).join('，')}`)
  db.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
