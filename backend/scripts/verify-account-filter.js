// 按账户过滤验证脚本：在独立临时库上验证「借记卡选择驱动总览 / 流水 / 月度按账户过滤」的服务器端行为。
// 不触碰、不迁移开发库，不调用收费模型。覆盖：
//  1. 交易流水 service + 路由：account_id 过滤只返回该账户流水；非法 account_id 返回 400。
//  2. 月度账单 service + 路由：account_id 过滤只统计该账户收支；非法 account_id 返回 400。
//  3. 过滤恒与 user_id 叠加：他人账户数据不会混入。
// 用法：node scripts/verify-account-filter.js
import { initDatabase } from '../src/db/index.js'
import { listTransactions } from '../src/services/transactions.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(tmpdir(), 'rongzhi-account-filter-test.db')

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
function shanghaiIso(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS).toISOString()
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const { db } = initDatabase({ dbPath: DB_PATH, seed: false })

const userId = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const user2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid

const acctA = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, '活期账户 A', 0, 0, 'CNY', 'active', 'deposit')",
).run(userId).lastInsertRowid
const acctB = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, '活期账户 B', 0, 0, 'CNY', 'active', 'deposit')",
).run(userId).lastInsertRowid
const acctOther = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, '李四账户', 0, 0, 'CNY', 'active', 'deposit')",
).run(user2).lastInsertRowid

const insertTx = db.prepare(
  `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at, status)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

// 张三账户 A：10 月收入 10000、支出 2000；账户 B：收入 3000、支出 1000
insertTx.run(userId, acctA, 'income', 10000, '收入', shanghaiIso(2026, 10, 5), 'posted')
insertTx.run(userId, acctA, 'expense', 2000, '餐饮', shanghaiIso(2026, 10, 6), 'posted')
insertTx.run(userId, acctB, 'income', 3000, '收入', shanghaiIso(2026, 10, 7), 'posted')
insertTx.run(userId, acctB, 'expense', 1000, '购物', shanghaiIso(2026, 10, 8), 'posted')
// 李四大额，验证不混入
insertTx.run(user2, acctOther, 'income', 99999999, '收入', shanghaiIso(2026, 10, 9), 'posted')

const AS_OF = shanghaiIso(2026, 10, 21, 12)

// —— service 层：交易流水按账户过滤 ——
const allTx = listTransactions(db, userId, { limit: 50, offset: 0 })
check('不过滤时返回全部 4 笔本人流水', allTx.total === 4, allTx.total)

const txA = listTransactions(db, userId, { accountId: acctA, limit: 50, offset: 0 })
check('account_id=A 仅返回账户 A 的 2 笔', txA.total === 2 && txA.rows.every((r) => r.account_id === acctA), txA.total)
check('账户 A 过滤不含账户 B 交易', !txA.rows.some((r) => r.account_id === acctB))

const txB = listTransactions(db, userId, { accountId: acctB, limit: 50, offset: 0 })
check('account_id=B 仅返回账户 B 的 2 笔', txB.total === 2 && txB.rows.every((r) => r.account_id === acctB))

// —— service 层：月度统计按账户过滤 ——
const allA = monthlyAnalytics(db, userId, { year: 2026, month: 10, asOf: AS_OF })
check('不过滤时收入 13000 / 支出 3000', allA.income_cents === 13000 && allA.expense_cents === 3000, `${allA.income_cents}/${allA.expense_cents}`)

const anaA = monthlyAnalytics(db, userId, { year: 2026, month: 10, asOf: AS_OF, accountId: acctA })
check('账户 A 统计：收入 10000 / 支出 2000', anaA.income_cents === 10000 && anaA.expense_cents === 2000, `${anaA.income_cents}/${anaA.expense_cents}`)

const anaB = monthlyAnalytics(db, userId, { year: 2026, month: 10, asOf: AS_OF, accountId: acctB })
check('账户 B 统计：收入 3000 / 支出 1000', anaB.income_cents === 3000 && anaB.expense_cents === 1000, `${anaB.income_cents}/${anaB.expense_cents}`)

// —— 路由层 ——
const app = express()
app.use(express.json())
app.use('/api', createApiRouter(db, userId))
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}/api`

const getJson = async (url) => {
  const res = await fetch(`${base}${url}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

{
  const bad = await getJson('/transactions?account_id=abc')
  check('transactions 非法 account_id 返回 400', bad.status === 400)

  const okA = await getJson(`/transactions?account_id=${acctA}&limit=50`)
  check('transactions account_id=A 返回 200 且 2 笔', okA.status === 200 && okA.body.meta.total === 2 && okA.body.data.every((r) => r.account_id === acctA), okA.body.meta && okA.body.meta.total)

  const okB = await getJson(`/transactions?account_id=${acctB}&limit=50`)
  check('transactions account_id=B 返回 200 且 2 笔', okB.status === 200 && okB.body.meta.total === 2)
}

{
  const bad = await getJson('/analytics/monthly?month=2026-10&account_id=0')
  check('analytics 非法 account_id 返回 400', bad.status === 400)

  const okA = await getJson(`/analytics/monthly?month=2026-10&account_id=${acctA}`)
  check('analytics account_id=A 收入 10000 / 支出 2000', okA.status === 200 && okA.body.data.income_cents === 10000 && okA.body.data.expense_cents === 2000, JSON.stringify(okA.body.data))

  const okB = await getJson(`/analytics/monthly?month=2026-10&account_id=${acctB}`)
  check('analytics account_id=B 收入 3000 / 支出 1000', okB.status === 200 && okB.body.data.income_cents === 3000 && okB.body.data.expense_cents === 1000)
}

server.close()
db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
