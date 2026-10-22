// 数据一致性修复脚本（一次性、可重复执行）。
//
// 问题：4 笔「未来时间却标记 posted」的模拟支出（合计 46329 分）被计入账户余额，
// 而月度统计按「截至请求时刻已发生」正确排除了它们，导致余额与已入账流水不一致。
//
// 本脚本：
// 1. 核对实际「未来 posted」记录是否与报告一致（不盲目按 id 修改）；
// 2. 用 SQLite backup API 创建一致性备份（正确处理 WAL）；
// 3. 在同一事务内：将这 4 笔改为 pending，并按「期初余额 + 截至当前时刻已入账流水」
//    重新核算账户余额（不简单加回固定金额）；
// 4. 重复执行不再改变余额，不删除任何交易。
//
// 用法：node scripts/fix-future-posted.js [数据库路径]
// 环境变量：BACKUP_DIR 备份目录（默认 backend/data/backups）；NOW 覆盖“当前时刻”（测试用）。
import { openDatabase, DEFAULT_DB_PATH, DATA_DIR } from '../src/db/connection.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DB_PATH = process.argv[2] || process.env.DB_PATH || DEFAULT_DB_PATH
const BACKUP_DIR = process.env.BACKUP_DIR || join(DATA_DIR, 'backups')
const NOW = process.env.NOW || new Date().toISOString()

// 报告中的 4 笔未来 posted 记录（内容签名：方向|金额分|分类）
const EXPECTED_FUTURE_POSTED = [
  { direction: 'expense', amount_cents: 8679, category: '住房' },
  { direction: 'expense', amount_cents: 3910, category: '餐饮' },
  { direction: 'expense', amount_cents: 3115, category: '订阅扣费' },
  { direction: 'expense', amount_cents: 30625, category: '购物' },
]
  .map((r) => `${r.direction}|${r.amount_cents}|${r.category}`)
  .sort()

const sig = (r) => `${r.direction}|${r.amount_cents}|${r.category}`

function fileStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) // YYYYMMDDHHMMSSmmm
}

const db = openDatabase(DB_PATH)
const demo = resolveDemoUser(db)
const account = db
  .prepare('SELECT id, opening_balance_cents, balance_cents FROM accounts WHERE user_id = ?')
  .get(demo.id)

if (!account) {
  console.error('[停止] 未找到演示用户的账户，无法修复')
  db.close()
  process.exit(1)
}

const futurePosted = db
  .prepare(
    `SELECT id, direction, amount_cents, category, transaction_at, status
     FROM transactions
     WHERE user_id = ? AND status = 'posted' AND transaction_at > ?
     ORDER BY id`,
  )
  .all(demo.id, NOW)

console.log('=== 修复前核对 ===')
console.log(`数据库：${DB_PATH}`)
console.log(`当前时刻（NOW）：${NOW}`)
console.log(`账户 opening_balance_cents=${account.opening_balance_cents} balance_cents=${account.balance_cents}`)
console.log(`未来 posted 记录数：${futurePosted.length}`)
let futureSum = 0
for (const r of futurePosted) {
  futureSum += r.amount_cents
  console.log(`  id=${r.id} ${r.direction} ${r.amount_cents} ${r.category} ${r.transaction_at}`)
}
console.log(`未来 posted 金额合计：${futureSum} 分（余额应加回 ${futureSum} 分）`)

// 按「期初余额 + 截至当前时刻的已入账流水」计算正确余额
function computeBalance() {
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='income' THEN amount_cents ELSE 0 END), 0) AS inc,
         COALESCE(SUM(CASE WHEN direction='expense' THEN amount_cents ELSE 0 END), 0) AS exp
       FROM transactions
       WHERE user_id = ? AND status = 'posted' AND transaction_at <= ?`,
    )
    .get(demo.id, NOW)
  return account.opening_balance_cents + sums.inc - sums.exp
}

// 无未来 posted（已修复 / 无需修复）：仅核对余额，保证幂等
if (futurePosted.length === 0) {
  const correct = computeBalance()
  if (correct !== account.balance_cents) {
    console.log(`\n[不一致] 无未来 posted，但余额 ${account.balance_cents} ≠ 核算值 ${correct}，按核算值纠正`)
    db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(correct, account.id)
  } else {
    console.log(`\n无未来 posted 记录，余额 ${account.balance_cents} 已与已入账流水一致，无需修改`)
  }
  db.close()
  console.log('已完成（幂等：重复执行不再改变余额）✅')
  process.exit(0)
}

// 核对实际记录是否与报告一致，不符则停止（不修改任何数据）
const actual = futurePosted.map(sig).sort()
if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_FUTURE_POSTED)) {
  console.error('\n[停止] 未来 posted 记录与报告不符，停止修复（未修改任何数据）：')
  console.error('  实际：', JSON.stringify(actual))
  console.error('  预期：', JSON.stringify(EXPECTED_FUTURE_POSTED))
  db.close()
  process.exit(1)
}

// 一致性备份（SQLite backup API，WAL 下保证一致快照）
mkdirSync(BACKUP_DIR, { recursive: true })
const backupPath = join(BACKUP_DIR, `rongzhi.pre-fix-${fileStamp()}.db`)
await db.backup(backupPath)
console.log(`\n一致性备份已创建：${backupPath}`)

// 同一事务：改 pending + 重算余额
let changed = 0
let newBalance = account.balance_cents
db.transaction(() => {
  const stmt = db.prepare('UPDATE transactions SET status = ? WHERE id = ? AND status = ?')
  for (const r of futurePosted) {
    changed += stmt.run('pending', r.id, 'posted').changes
  }
  newBalance = computeBalance()
  db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(newBalance, account.id)
})()
console.log(`已将 ${changed} 笔未来 posted 交易改为 pending`)
console.log(`重新核算余额：${account.balance_cents} -> ${newBalance} 分`)

// 修复后核对
const txTotal = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(demo.id).c
const pending = db
  .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE user_id = ? AND status = 'pending'")
  .get(demo.id)
const finalBalance = db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(account.id).balance_cents
console.log('\n=== 修复后核对 ===')
console.log(`交易总数：${txTotal}（不变）`)
console.log(`待入账：${pending.c} 笔 / ${pending.s} 分`)
console.log(`账户余额：${finalBalance} 分`)

db.close()
console.log('\n修复完成 ✅')
