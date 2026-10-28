// 数据库验证脚本：在独立的临时数据库上运行，不清空、不触碰开发数据库。
// 用法：node scripts/verify-db.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-tmp.db')

for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
}

// 1. 初始化（种子模式）
const first = initDatabase({ dbPath: tmpPath, seed: true })
const db = first.db
check('首次初始化完成种子数据插入', first.seeded === true)

// 2. 六张表存在
const tables = ['users', 'accounts', 'transactions', 'cards', 'subscriptions', 'audit_logs']
const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
const missing = tables.filter((t) => !existing.has(t))
check('六张表全部存在', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : '')

// 3. 条数符合要求
const c = {
  users: count(db, 'users'),
  accounts: count(db, 'accounts'),
  cards: count(db, 'cards'),
  transactions: count(db, 'transactions'),
  subscriptions: count(db, 'subscriptions'),
  audit_logs: count(db, 'audit_logs'),
}
console.log('  数据条数：' + JSON.stringify(c))
check('users >= 1', c.users >= 1)
check('accounts >= 1', c.accounts >= 1)
check('cards >= 1', c.cards >= 1)
check('transactions >= 50', c.transactions >= 50)
check('subscriptions >= 5', c.subscriptions >= 5)
check('audit_logs 为空（本次不伪造日志）', c.audit_logs === 0)

// 4. 交易类别覆盖
const cats = db.prepare('SELECT DISTINCT category AS c FROM transactions').all().map((r) => r.c)
const requiredCats = ['收入', '餐饮', '购物', '交通', '娱乐', '住房', '订阅扣费']
const missCats = requiredCats.filter((x) => !cats.includes(x))
check('交易类别覆盖收入+六大支出', missCats.length === 0, missCats.length ? '缺失: ' + missCats.join(',') : '')

// 5. 余额与流水核算一致
const acc = db.prepare('SELECT opening_balance_cents AS o, balance_cents AS b FROM accounts LIMIT 1').get()
const rows = db.prepare(
  "SELECT direction AS d, SUM(amount_cents) AS s FROM transactions WHERE status='posted' GROUP BY direction",
).all()
let inc = 0
let exp = 0
for (const r of rows) {
  if (r.d === 'income') inc = r.s
  else exp = r.s
}
const expectBalance = acc.o + inc - exp
check('余额 = 期初 + 已入账收入 - 已入账支出', acc.b === expectBalance, `期望 ${expectBalance} 实际 ${acc.b}`)
check('余额非负', acc.b >= 0)

// 5.1 业务日期字段（开户 / 开卡日期，区别于 created_at）
const accRow = db.prepare('SELECT opened_on AS o FROM accounts LIMIT 1').get()
const cardRow = db.prepare('SELECT issued_on AS o FROM cards LIMIT 1').get()
check('账户开户日期为 2026-08-01', accRow.o === '2026-08-01', accRow.o)
check('银行卡开卡日期为 2026-08-01', cardRow.o === '2026-08-01', cardRow.o)

// 6. 重复初始化不重复插入
const second = initDatabase({ dbPath: tmpPath, seed: true })
check('重复初始化不重复插入', second.seeded === false)
const c2 = {
  users: count(db, 'users'),
  accounts: count(db, 'accounts'),
  cards: count(db, 'cards'),
  transactions: count(db, 'transactions'),
  subscriptions: count(db, 'subscriptions'),
  audit_logs: count(db, 'audit_logs'),
}
check('重复初始化后条数不变', JSON.stringify(c) === JSON.stringify(c2))
second.db.close()

// 7. 关闭后重新打开数据仍存在
db.close()
const third = initDatabase({ dbPath: tmpPath, seed: false })
const db3 = third.db
const c3 = {
  users: count(db3, 'users'),
  accounts: count(db3, 'accounts'),
  cards: count(db3, 'cards'),
  transactions: count(db3, 'transactions'),
  subscriptions: count(db3, 'subscriptions'),
  audit_logs: count(db3, 'audit_logs'),
}
check('关闭后重新打开数据仍存在', JSON.stringify(c) === JSON.stringify(c3))

// 8. 约束：无效外键被拒绝
let fkRejected = false
try {
  db3.prepare(
    'INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at) VALUES (1, 999999, ?, 100, ?, ?)',
  ).run('expense', '餐饮', new Date().toISOString())
} catch {
  fkRejected = true
}
check('无效外键被约束拒绝', fkRejected)

// 9. 约束：非法金额（0）被拒绝
let amtRejected = false
try {
  db3.prepare(
    'INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at) VALUES (1, 1, ?, 0, ?, ?)',
  ).run('expense', '餐饮', new Date().toISOString())
} catch {
  amtRejected = true
}
check('非法金额（0）被约束拒绝', amtRejected)

db3.close()

// 清理临时数据库
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
