// 新增演示账户流水扩充（借记 5678 / 信用 0003）。
//
// 原则：
// - 只作用于显式指定、按 id 核验的新增账户；原账户与任何用户实际操作记录不动。
// - 演示样例带明确标识（description 前缀 [模拟样例/D]、[模拟样例/C]；还款 ref_no 前缀 SIM-REPAY-），
//   已存在的样例（如部署时的「验收样例(新增借记卡)」与 4 笔信用卡消费）保留并计入目标总量，不猜测删除。
// - 幂等：检测到标识即跳过对应部分；整体写入在一个事务内完成。
// - 历史还款使用「模拟导入」路径：直接写入冲抵明细 / 还款单（completed）/ 付款账户还款流水 / 审计，
//   审计 action 为 simulate_import，不伪造强验证成功，不调用确认接口。
//
// 用法：
//   node scripts/enrich-demo-accounts.js --db <绝对路径> --user-id 1 --debit-account-id 2 --credit-account-id 3 [--preview|--apply]
import { createCreditConsumption, postCreditConsumption, issueStatements } from '../src/services/credit.js'
import { shanghaiNowParts, SHANGHAI_OFFSET_MS } from '../src/lib/shanghai.js'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

const DEBIT_MARK = '[模拟样例/D]'
const CREDIT_MARK = '[模拟样例/C]'
const REPAY_PREFIX = 'SIM-REPAY-'
const SEED = 20261023
const TARGET_DEBIT = 72
const TARGET_CREDIT = 90

// —— 确定性伪随机 ——
function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)]
const between = (rand, min, max) => min + Math.floor(rand() * (max - min + 1))

// 上海时间 → UTC ISO
function shIso(y, m, d, h, min) {
  return new Date(Date.UTC(y, m - 1, d, h, min, 0) - SHANGHAI_OFFSET_MS).toISOString()
}
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}
const DAYS = []
for (let m = 8; m <= 10; m += 1) {
  const maxDay = m === 10 ? 22 : daysInMonth(2026, m)
  for (let d = 1; d <= maxDay; d += 1) DAYS.push({ y: 2026, m, d })
}

const MERCHANTS = {
  餐饮: ['星巴克', '美团外卖', '海底捞', '麦当劳', '瑞幸咖啡', '沙县小吃', '必胜客'],
  购物: ['京东商城', '淘宝', '盒马鲜生', '优衣库', '山姆会员店', '小米之家'],
  交通: ['滴滴出行', '地铁出行', '中国石化', '高铁12306', '共享单车'],
  酒店: ['携程酒店', '华住会', '亚朵酒店'],
  订阅扣费: ['视频会员', '音乐会员', '云存储'],
  住房: ['电费', '水费', '物业费'],
  转账: ['王五', '李雷', '韩梅梅', '赵六'],
  收入: ['薪资发放', '季度奖金'],
}

// 生成借记样例计划（不含已有记录）
function planDebit(existingCount, rand) {
  const need = Math.max(0, TARGET_DEBIT - existingCount)
  const rows = []
  const used = new Set()
  const stamp = (d, h, min) => {
    let mm = min
    let hh = h
    while (used.has(`${d.y}-${d.m}-${d.d}-${hh}-${mm}`)) {
      mm += 1
      if (mm > 59) { mm = 0; hh += 1 }
    }
    used.add(`${d.y}-${d.m}-${d.d}-${hh}-${mm}`)
    return shIso(d.y, d.m, d.d, hh, mm)
  }
  const push = (row) => rows.push({ ...row, at: stamp(row.day, row.hour, row.minute) })

  // 固定项：工资（每月 5 日）、奖金（9/15）、缴费（每月 8/12/18 日）
  const fixed = []
  for (const m of [8, 9, 10]) fixed.push({ direction: 'income', amount_cents: 200000, category: '收入', merchant: '薪资发放', desc: '模拟工资', day: { y: 2026, m, d: 5 }, hour: 9, minute: 0 })
  fixed.push({ direction: 'income', amount_cents: 80000, category: '收入', merchant: '季度奖金', desc: '模拟奖金', day: { y: 2026, m: 9, d: 15 }, hour: 10, minute: 0 })
  for (const m of [8, 9, 10]) {
    fixed.push({ direction: 'expense', amount_cents: between(rand, 9000, 16000), category: '住房', merchant: '电费', desc: '生活缴费', day: { y: 2026, m, d: 8 }, hour: 9, minute: 30 })
    fixed.push({ direction: 'expense', amount_cents: between(rand, 2000, 4500), category: '住房', merchant: '水费', desc: '生活缴费', day: { y: 2026, m, d: 12 }, hour: 9, minute: 40 })
    fixed.push({ direction: 'expense', amount_cents: 2500, category: '订阅扣费', merchant: '视频会员', desc: '订阅代扣', day: { y: 2026, m, d: 18 }, hour: 9, minute: 50 })
  }
  // 对外转账（少量）
  const transferDays = [
    { y: 2026, m: 8, d: 12 }, { y: 2026, m: 9, d: 3 }, { y: 2026, m: 9, d: 22 },
    { y: 2026, m: 10, d: 8 }, { y: 2026, m: 10, d: 15 }, { y: 2026, m: 10, d: 19 },
  ]
  for (const day of transferDays) {
    fixed.push({ direction: 'expense', amount_cents: between(rand, 8000, 40000), category: '转账', merchant: pick(rand, MERCHANTS.转账), desc: '对外转账', day, hour: between(rand, 10, 19), minute: between(rand, 0, 59) })
  }
  if (need <= fixed.length) {
    for (const r of fixed.slice(0, need)) push(r)
    return rows
  }
  for (const r of fixed) push(r)

  // 日常消费：在可用日期中确定性选取
  const remaining = need - fixed.length
  const candidates = [...DAYS].filter((d) => !(d.m === 10 && d.d > 20))
  const picked = []
  // 均匀抽样：按步长游走并带轻微抖动
  const step = candidates.length / remaining
  for (let i = 0; i < remaining; i += 1) {
    const idx = Math.min(candidates.length - 1, Math.floor(i * step + rand() * Math.max(1, step - 1)))
    picked.push(candidates[idx])
  }
  for (const day of picked) {
    const kind = pick(rand, ['餐饮', '餐饮', '购物', '交通'])
    const amount = kind === '餐饮' ? between(rand, 1500, 9000)
      : kind === '购物' ? between(rand, 2000, 60000)
        : between(rand, 300, 3500)
    const merchant = pick(rand, MERCHANTS[kind])
    push({ direction: 'expense', amount_cents: amount, category: kind, merchant, desc: '日常消费', day, hour: between(rand, 7, 21), minute: between(rand, 0, 59) })
  }
  return rows
}

// 生成信用卡样例计划（不含已有记录）：8 月账单（已还清）、10 月消费（未出账）、2 笔待入账
function planCredit(existingCount, rand) {
  const need = Math.max(0, TARGET_CREDIT - existingCount)
  const rows = []
  if (need === 0) return rows
  const pendingCount = Math.min(2, need)
  const postedCount = need - pendingCount
  const augCount = Math.min(22, postedCount)
  const octCount = postedCount - augCount
  const used = new Set()
  // 每个事件使用唯一的时间点，避免可避免的跨行同刻事件
  const stamp = (y, m, d, h, min) => {
    let hh = h
    let mm = min
    while (used.has(`${y}-${m}-${d}-${hh}-${mm}`)) {
      mm += 1
      if (mm > 59) { mm = 0; hh += 1 }
    }
    used.add(`${y}-${m}-${d}-${hh}-${mm}`)
    return { iso: shIso(y, m, d, hh, mm), y, m, d, h: hh, min: mm }
  }
  const spec = (kind) => {
    switch (kind) {
      case '餐饮': return between(rand, 1500, 8000)
      case '购物': return rand() < 0.12 ? between(rand, 80000, 180000) : between(rand, 3000, 40000)
      case '交通': return between(rand, 300, 4000)
      case '酒店': return between(rand, 30000, 120000)
      default: return between(rand, 1500, 3000) // 订阅扣费
    }
  }
  const kinds = ['餐饮', '餐饮', '餐饮', '购物', '购物', '购物', '交通', '交通', '酒店', '订阅扣费']
  const addRow = (day, pending) => {
    const kind = pick(rand, kinds)
    const tx = stamp(day.y, day.m, day.d, between(rand, 8, 21), between(rand, 0, 59))
    let postedAt = null
    if (!pending) {
      const delay = between(rand, 0, 2)
      let pd = day.d + delay
      let pm = day.m
      let py = day.y
      while (pd > daysInMonth(py, pm)) { pd -= daysInMonth(py, pm); pm += 1; if (pm > 12) { pm = 1; py += 1 } }
      const post = stamp(py, pm, pd, tx.h + 1 > 22 ? 20 : tx.h + 1, tx.min <= 50 ? tx.min + 5 : tx.min - 10)
      postedAt = post.iso
    }
    rows.push({ amount_cents: spec(kind), category: kind, merchant: pick(rand, MERCHANTS[kind]), transactionAt: tx.iso, postedAt })
  }
  const augDays = DAYS.filter((d) => d.m === 8)
  const octDays = DAYS.filter((d) => d.m === 10 && d.d <= 20)
  for (let i = 0; i < augCount; i += 1) addRow(augDays[Math.floor((i * augDays.length) / augCount)], false)
  for (let i = 0; i < octCount; i += 1) addRow(octDays[Math.floor((i * octDays.length) / octCount)], false)
  for (let i = 0; i < pendingCount; i += 1) addRow({ y: 2026, m: 10, d: 22 }, true)
  return rows
}

function resolveTargets(db, { userId, debitAccountId, creditAccountId }) {
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId)
  if (!user) throw new Error(`未找到 id=${userId} 的用户`)
  const debit = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(debitAccountId, userId)
  if (!debit || debit.account_type !== 'deposit') throw new Error(`账户 ${debitAccountId} 不是该用户的存款账户`)
  const credit = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(creditAccountId, userId)
  if (!credit || credit.account_type !== 'credit') throw new Error(`账户 ${creditAccountId} 不是该用户的信用账户`)
  const ca = db.prepare('SELECT * FROM credit_accounts WHERE account_id = ? AND user_id = ?').get(creditAccountId, userId)
  if (!ca) throw new Error('未找到信用账户记录')
  const creditCard = db.prepare("SELECT * FROM cards WHERE account_id = ? AND user_id = ? AND card_type = '信用卡'").get(creditAccountId, userId)
  if (!creditCard) throw new Error('未找到该信用账户的信用卡')
  return { user, debit, credit, ca, creditCard }
}

export function planEnrichment(db, { userId, debitAccountId, creditAccountId, now = new Date() }) {
  const t = resolveTargets(db, { userId, debitAccountId, creditAccountId })
  const debitExisting = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND account_id = ?').get(userId, debitAccountId).c
  const creditExisting = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND account_id = ?').get(userId, creditAccountId).c
  const debitDone = db.prepare('SELECT COUNT(*) c FROM transactions WHERE account_id = ? AND description LIKE ?').get(debitAccountId, `${DEBIT_MARK}%`).c > 0
  const creditDone = db.prepare('SELECT COUNT(*) c FROM transactions WHERE account_id = ? AND description LIKE ?').get(creditAccountId, `${CREDIT_MARK}%`).c > 0
  const repayDone = db.prepare('SELECT COUNT(*) c FROM repayment_operations WHERE ref_no LIKE ?').get(`${REPAY_PREFIX}%`).c > 0
  const rand = mulberry32(SEED)
  const debitRows = debitDone ? [] : planDebit(debitExisting, rand)
  const creditRows = creditDone ? [] : planCredit(creditExisting, rand)

  // 预计 8 月已出账金额（用于模拟还款）
  const augTotal = creditRows.filter((r) => r.postedAt && r.postedAt.startsWith('2026-08')).reduce((s, r) => s + r.amount_cents, 0)
  const debitDelta = debitRows.reduce((s, r) => s + (r.direction === 'income' ? r.amount_cents : -r.amount_cents), 0)
  const postedDelta = creditRows.filter((r) => r.postedAt).reduce((s, r) => s + r.amount_cents, 0)
  const pendingDelta = creditRows.filter((r) => !r.postedAt).reduce((s, r) => s + r.amount_cents, 0)
  return {
    targets: t,
    existing: { debit: debitExisting, credit: creditExisting },
    done: { debit: debitDone, credit: creditDone, repay: repayDone },
    debitRows,
    creditRows,
    augTotal,
    projection: {
      debitBefore: t.debit.balance_cents,
      debitDelta: debitDelta - augTotal,
      debitAfter: t.debit.balance_cents + debitDelta - augTotal,
      credit: {
        limit: t.ca.credit_limit_cents,
        outstandingBefore: t.ca.posted_outstanding_cents,
        pendingBefore: t.ca.pending_occupied_cents,
        availableBefore: t.ca.credit_limit_cents - t.ca.posted_outstanding_cents - t.ca.pending_occupied_cents,
        outstandingAfter: t.ca.posted_outstanding_cents + postedDelta - augTotal,
        pendingAfter: t.ca.pending_occupied_cents + pendingDelta,
        availableAfter: t.ca.credit_limit_cents - (t.ca.posted_outstanding_cents + postedDelta - augTotal) - (t.ca.pending_occupied_cents + pendingDelta),
      },
    },
  }
}

function insertDebitRows(db, userId, accountId, rows) {
  for (const r of rows) {
    db.prepare(
      `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', 'external')`,
    ).run(userId, accountId, r.direction, r.amount_cents, r.category, r.merchant, `${DEBIT_MARK} ${r.merchant} · ${r.desc}`, r.at)
  }
  const delta = rows.reduce((s, r) => s + (r.direction === 'income' ? r.amount_cents : -r.amount_cents), 0)
  db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(delta, accountId)
  return { count: rows.length, delta }
}

// 模拟还款导入：直接写入还款单 / 冲抵明细 / 付款流水 / 审计（action=simulate_import），不经过强验证。
function importSimulatedRepayment(db, userId, { statementId, fromAccountId, creditAccountId, creditCaId, creditAccountName, amountCents, paidAt }) {
  const stmt = db.prepare('SELECT * FROM statements WHERE id = ? AND user_id = ?').get(statementId, userId)
  if (!stmt) throw new Error('模拟还款目标账单不存在')
  if (stmt.issued_at == null) throw new Error('模拟还款目标账单尚未出账')
  const remaining = stmt.new_charges_cents - stmt.paid_cents
  if (remaining !== amountCents) throw new Error(`模拟还款金额与账单剩余不一致：剩余 ${remaining}，计划 ${amountCents}`)
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(fromAccountId, userId)
  if (!acc || acc.account_type !== 'deposit' || acc.balance_cents < amountCents) throw new Error('模拟还款付款账户不可用或余额不足')
  const ca = db.prepare('SELECT * FROM credit_accounts WHERE account_id = ? AND user_id = ?').get(creditAccountId, userId)
  if (!ca) throw new Error('未找到信用账户')
  const ref = `${REPAY_PREFIX}${randomUUID()}`
  const at = paidAt.toISOString()
  const month = `${stmt.statement_year}-${String(stmt.statement_month).padStart(2, '0')}`
  db.prepare(
    `INSERT INTO repayment_operations
      (ref_no, user_id, session_id, from_account_id, from_account_name, credit_account_id, credit_account_name,
       statement_id, statement_month, amount_cents, statement_version, risk_level, status, created_at, expires_at, confirmed_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'red', 'completed', ?, ?, ?)`,
  ).run(ref, userId, fromAccountId, acc.account_name, creditCaId, creditAccountName, statementId, month, amountCents, stmt.version, at, at, at)
  db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?').run(amountCents, fromAccountId, amountCents)
  db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind, repayment_ref)
     VALUES (?, ?, 'expense', ?, '还款', NULL, ?, ?, 'posted', 'repayment', ?)`,
  ).run(userId, fromAccountId, amountCents, `${CREDIT_MARK} 模拟还款（8 月账单）`, at, ref)
  db.prepare('INSERT INTO statement_payments (user_id, statement_id, repayment_ref, amount_cents, paid_at) VALUES (?, ?, ?, ?, ?)').run(userId, statementId, ref, amountCents, at)
  db.prepare('UPDATE statements SET paid_cents = paid_cents + ?, version = version + 1 WHERE id = ?').run(amountCents, statementId)
  db.prepare('UPDATE credit_accounts SET posted_outstanding_cents = posted_outstanding_cents - ? WHERE id = ? AND posted_outstanding_cents >= ?').run(amountCents, ca.id, amountCents)
  db.prepare(
    `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
     VALUES (?, 'repayment', ?, 'simulate_import', 'success', ?)`,
  ).run(userId, ref, JSON.stringify({ statement_id: statementId, amount_cents: amountCents, source: 'demo-enrichment' }))
  return ref
}

export function applyEnrichment(db, { userId, debitAccountId, creditAccountId, now = new Date() }) {
  const plan = planEnrichment(db, { userId, debitAccountId, creditAccountId, now })
  const run = db.transaction(() => {
    let debitAdded = 0
    if (plan.debitRows.length) debitAdded = insertDebitRows(db, userId, debitAccountId, plan.debitRows).count
    let creditAdded = 0
    let pendingAdded = 0
    for (const r of plan.creditRows) {
      const res = createCreditConsumption(db, userId, {
        cardId: plan.targets.creditCard.id,
        amountCents: r.amount_cents,
        category: r.category,
        merchant: r.merchant,
        transactionAt: r.transactionAt,
      })
      db.prepare('UPDATE transactions SET description = ? WHERE id = ?').run(
        `${CREDIT_MARK} ${r.merchant} · ${r.category}消费`, res.transaction_id,
      )
      if (r.postedAt) postCreditConsumption(db, userId, res.transaction_id, { postedAt: new Date(r.postedAt) })
      else pendingAdded += 1
      creditAdded += 1
    }
    let repaymentRef = null
    if (plan.augTotal > 0) {
      // 注意：statements.credit_account_id 引用 credit_accounts.id，不是 accounts.id
      issueStatements(db, userId, plan.targets.ca.id, now)
      const aug = db.prepare('SELECT * FROM statements WHERE credit_account_id = ? AND statement_year = 2026 AND statement_month = 8').get(plan.targets.ca.id)
      if (!aug || aug.issued_at == null) throw new Error('8 月账单未按预期出账，停止写入')
      repaymentRef = importSimulatedRepayment(db, userId, {
        statementId: aug.id,
        fromAccountId: debitAccountId,
        creditAccountId,
        creditCaId: plan.targets.ca.id,
        creditAccountName: plan.targets.credit.account_name,
        amountCents: aug.new_charges_cents - aug.paid_cents,
        paidAt: new Date(shIso(2026, 9, 25, 10, 0)),
      })
    }
    return { debitAdded, creditAdded, pendingAdded, repaymentRef }
  })
  return { plan, result: run() }
}

// —— CLI ——
function parseArgs(argv) {
  const a = { db: null, userId: null, debitAccountId: null, creditAccountId: null, apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i]
    if (x === '--db') a.db = argv[++i]
    else if (x === '--user-id') a.userId = Number(argv[++i])
    else if (x === '--debit-account-id') a.debitAccountId = Number(argv[++i])
    else if (x === '--credit-account-id') a.creditAccountId = Number(argv[++i])
    else if (x === '--apply') a.apply = true
    else if (x === '--preview') a.apply = false
    else if (x === '--help' || x === '-h') a.help = true
  }
  return a
}
const HELP = `扩充新增演示账户流水（借记 5678 / 信用 0003）
用法：
  node scripts/enrich-demo-accounts.js --db <绝对路径> --user-id <id> --debit-account-id <id> --credit-account-id <id> [--preview|--apply]
  --preview 默认：只列出计划与前后数值，不写入
  --apply   显式写入（带标识、幂等、单事务）`
const fmt = (c) => `¥${(c / 100).toFixed(2)}`

function printPlan(plan, args) {
  const { targets, existing, done, debitRows, creditRows, augTotal, projection } = plan
  console.log(`\n目标库：${args.db}`)
  console.log(`目标用户：id=${targets.user.id}（${targets.user.name}）`)
  console.log(`借记账户：id=${targets.debit.id}「${targets.debit.account_name}」（opened_on ${targets.debit.opened_on}，当前余额 ${fmt(targets.debit.balance_cents)}）`)
  console.log(`信用账户：id=${targets.credit.id}「${targets.credit.account_name}」（额度 ${fmt(targets.ca.credit_limit_cents)}）`)
  console.log(`\n现有流水：借记 ${existing.debit} 笔 / 信用 ${existing.credit} 笔（保留，计入目标总量）`)
  console.log(`标识检测：借记样例已存在=${done.debit}，信用样例已存在=${done.credit}，模拟还款已存在=${done.repay}`)
  console.log(`\n计划写入：借记 ${debitRows.length} 笔 / 信用 ${creditRows.length} 笔（其中待入账 ${creditRows.filter((r) => !r.postedAt).length} 笔）`)
  if (debitRows.length) {
    const byCat = {}
    for (const r of debitRows) byCat[r.category] = (byCat[r.category] || 0) + 1
    console.log(`  借记构成：${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
    console.log(`  借记日期范围：${debitRows.map((r) => r.at).sort()[0].slice(0, 10)} ~ ${debitRows.map((r) => r.at).sort().slice(-1)[0].slice(0, 10)}`)
  }
  if (creditRows.length) {
    const byCat = {}
    for (const r of creditRows) byCat[r.category] = (byCat[r.category] || 0) + 1
    console.log(`  信用构成：${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
    console.log(`  信用日期范围：${creditRows.map((r) => r.transactionAt).sort()[0].slice(0, 10)} ~ ${creditRows.map((r) => r.transactionAt).sort().slice(-1)[0].slice(0, 10)}`)
  }
  if (augTotal > 0) console.log(`  8 月模拟还款：${fmt(augTotal)}（付款账户 id=${targets.debit.id}，模拟导入，非强验证）`)
  console.log('\n前后数值：')
  console.log(`  借记余额：${fmt(projection.debitBefore)} → ${fmt(projection.debitAfter)}（净变动 ${fmt(projection.debitDelta)}，含模拟还款）`)
  const c = projection.credit
  console.log(`  信用额度：${fmt(c.limit)}`)
  console.log(`  已入账未还：${fmt(c.outstandingBefore)} → ${fmt(c.outstandingAfter)}`)
  console.log(`  待入账占用：${fmt(c.pendingBefore)} → ${fmt(c.pendingAfter)}`)
  console.log(`  可用额度：${fmt(c.availableBefore)} → ${fmt(c.availableAfter)}`)
  console.log('\n受保护：原账户 1234、其全部流水/订阅/会话/操作单/任务/验证绑定；新账户中用户实际操作记录（若有）。')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.db || !args.userId || !args.debitAccountId || !args.creditAccountId) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }
  const db = new Database(args.db)
  try {
    const plan = planEnrichment(db, args)
    printPlan(plan, args)
    if (!args.apply) {
      console.log('\n（预览模式）未写入。确认后加 --apply 显式执行。')
      return
    }
    if (!plan.debitRows.length && !plan.creditRows.length) {
      console.log('\n（幂等）样例已存在，未重复生成。')
      return
    }
    const { result } = applyEnrichment(db, args)
    console.log(`\n执行结果：借记 +${result.debitAdded} 笔，信用 +${result.creditAdded} 笔（待入账 ${result.pendingAdded}），模拟还款 ${result.repaymentRef || '无'}`)
    const afterDebit = db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(args.debitAccountId).b
    const afterCa = db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE account_id = ?').get(args.creditAccountId)
    console.log(`执行后：借记余额 ${fmt(afterDebit)}；已入账未还 ${fmt(afterCa.o)}；待入账占用 ${fmt(afterCa.p)}；可用 ${fmt(5000000 - afterCa.o - afterCa.p)}`)
  } finally {
    db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
