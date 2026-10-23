// 月度账单统计验证脚本：在独立临时数据库上构造已知金额的小型数据，
// 用人工可核算的预期值验证服务函数（精确口径），并启动独立端口验证路由（400 / 隔离）。
// 不修改开发数据库（backend/data/rongzhi.db），不依赖外部运行中的服务。
// 用法：node scripts/verify-analytics.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, '..')
const DB_PATH = join(tmpdir(), 'rongzhi-analytics-test.db')
const PORT = 3108

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
// 将上海本地日期时间转换为 UTC ISO 字符串（与种子数据同一规则）
function shanghaiIso(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS).toISOString()
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

// ---------- 构建临时库 + 已知数据 ----------
const db = openDatabase(DB_PATH)
createSchema(db)
migrate(db)

const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
const a1 = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opened_on) VALUES (?, ?, ?)",
).run(u1, '人民币活期账户', '2026-08-01').lastInsertRowid
const a2 = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opened_on) VALUES (?, ?, ?)",
).run(u2, '李四测试账户', '2026-08-01').lastInsertRowid

const insertTx = db.prepare(
  `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at, status)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

// 演示用户（张三）2026 年 10 月数据（上海自然月）
const demo = [
  // 已入账收入
  { direction: 'income', amount_cents: 10000, category: '收入', at: shanghaiIso(2026, 10, 5, 9), status: 'posted' },
  { direction: 'income', amount_cents: 5000, category: '收入', at: shanghaiIso(2026, 10, 20, 10), status: 'posted' },
  // 已入账支出
  { direction: 'expense', amount_cents: 2000, category: '餐饮', at: shanghaiIso(2026, 10, 3), status: 'posted' },
  { direction: 'expense', amount_cents: 3000, category: '购物', at: shanghaiIso(2026, 10, 8), status: 'posted' },
  { direction: 'expense', amount_cents: 1000, category: '餐饮', at: shanghaiIso(2026, 10, 12), status: 'posted' },
  { direction: 'expense', amount_cents: 4000, category: '住房', at: shanghaiIso(2026, 10, 15), status: 'posted' },
  // 月初边界：上海 10-01 00:30 → UTC 09-30 16:30，应归属 10 月
  { direction: 'expense', amount_cents: 111, category: '餐饮', at: shanghaiIso(2026, 10, 1, 0, 30), status: 'posted' },
  // 下月月初边界：上海 11-01 00:30 → UTC 10-31 16:30，应归属 11 月（不计入 10 月）
  { direction: 'expense', amount_cents: 222, category: '购物', at: shanghaiIso(2026, 11, 1, 0, 30), status: 'posted' },
  // 待入账（不计入已入账）
  { direction: 'expense', amount_cents: 500, category: '交通', at: shanghaiIso(2026, 10, 18), status: 'pending' },
  { direction: 'expense', amount_cents: 700, category: '娱乐', at: shanghaiIso(2026, 10, 19), status: 'pending' },
  // 未来时间却标记 posted（截至 10-21 尚未发生，不计入已入账）
  { direction: 'expense', amount_cents: 900, category: '餐饮', at: shanghaiIso(2026, 10, 25), status: 'posted' },
]
for (const t of demo) {
  insertTx.run(u1, a1, t.direction, t.amount_cents, t.category, t.at, t.status)
}

// 其他用户（李四）：大额特征交易，验证不进入演示用户统计
insertTx.run(u2, a2, 'income', 99999999, '收入', shanghaiIso(2026, 10, 10), 'posted')
insertTx.run(u2, a2, 'expense', 88888888, '购物', shanghaiIso(2026, 10, 10), 'posted')

// ---------- 服务函数（固定 asOf，确定性） ----------
const AS_OF = shanghaiIso(2026, 10, 21, 12) // 上海 2026-10-21 12:00
const oct = monthlyAnalytics(db, u1, { year: 2026, month: 10, asOf: AS_OF })

check('月份与截止时间正确回显', oct.month === '2026-10' && oct.timezone === 'Asia/Shanghai' && oct.as_of === AS_OF)
check('已入账收入 = 15000', oct.income_cents === 15000, oct.income_cents)
check('已入账支出 = 10111（不含未来 900、下月 222）', oct.expense_cents === 10111, oct.expense_cents)
check('净收支 = 4889（可为正/负）', oct.net_cents === 4889, oct.net_cents)
check('已入账笔数 = 7（2 收入 + 5 支出）', oct.posted_count === 7, oct.posted_count)
check('待入账 2 笔 / 1200 分', oct.pending.count === 2 && oct.pending.amount_cents === 1200, JSON.stringify(oct.pending))
check('分类 3 项', oct.expense_by_category.length === 3)
check('分类按金额倒序：住房(4000) 首位', oct.expense_by_category[0]?.category === '住房' && oct.expense_by_category[0]?.amount_cents === 4000 && oct.expense_by_category[0]?.count === 1)
check('餐饮 3111 / 3 笔（含月初 111）', oct.expense_by_category[1]?.category === '餐饮' && oct.expense_by_category[1]?.amount_cents === 3111 && oct.expense_by_category[1]?.count === 3, JSON.stringify(oct.expense_by_category[1]))
check('购物 3000 / 1 笔（不含下月 222）', oct.expense_by_category[2]?.category === '购物' && oct.expense_by_category[2]?.amount_cents === 3000 && oct.expense_by_category[2]?.count === 1)
check('pending 未混入已入账（交通/娱乐不在分类）', !oct.expense_by_category.some((c) => c.category === '交通' || c.category === '娱乐'))

// 收入分类：与支出分类同一已入账口径（仅 posted 且已发生），合计恒等于顶部「已入账收入」
check('收入分类 1 项（薪资+奖金均为「收入」）', oct.income_by_category.length === 1, JSON.stringify(oct.income_by_category))
check('收入分类：收入 15000 / 2 笔', oct.income_by_category[0]?.category === '收入' && oct.income_by_category[0]?.amount_cents === 15000 && oct.income_by_category[0]?.count === 2)
check('收入分类合计 = 已入账收入 15000', oct.income_by_category.reduce((s, c) => s + c.amount_cents, 0) === oct.income_cents)
check('支出分类合计 = 已入账支出 10111', oct.expense_by_category.reduce((s, c) => s + c.amount_cents, 0) === oct.expense_cents)
check('收入分类不含支出类别（方向隔离）', !oct.income_by_category.some((c) => ['餐饮', '购物', '住房', '交通', '娱乐'].includes(c.category)))

// 无记录月份：零值 + 空分类
const empty = monthlyAnalytics(db, u1, { year: 2026, month: 1, asOf: AS_OF })
check('无记录月份返回零值', empty.income_cents === 0 && empty.expense_cents === 0 && empty.net_cents === 0 && empty.posted_count === 0)
check('无记录月份空分类 + 零待入账', empty.expense_by_category.length === 0 && empty.income_by_category.length === 0 && empty.pending.count === 0 && empty.pending.amount_cents === 0)

// 其他用户数据不进入演示用户统计
check('李四数据未混入演示用户（income 仍 15000）', oct.income_cents === 15000 && !oct.expense_by_category.some((c) => c.amount_cents === 88888888))
const li = monthlyAnalytics(db, u2, { year: 2026, month: 10, asOf: AS_OF })
check('李四自身统计正确', li.income_cents === 99999999 && li.expense_cents === 88888888)

// 多收入类别（王五）：验证收入按类别分别聚合（非仅单一「收入」），且待入账不计入
const u3 = db.prepare("INSERT INTO users (name) VALUES ('王五')").run().lastInsertRowid
const a3 = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opened_on) VALUES (?, ?, ?)",
).run(u3, '王五测试账户', '2026-08-01').lastInsertRowid
insertTx.run(u3, a3, 'income', 8000, '工资', shanghaiIso(2026, 10, 5), 'posted')
insertTx.run(u3, a3, 'income', 2000, '理财', shanghaiIso(2026, 10, 6), 'posted')
insertTx.run(u3, a3, 'income', 1000, '工资', shanghaiIso(2026, 10, 7), 'posted')
insertTx.run(u3, a3, 'income', 500, '奖金', shanghaiIso(2026, 10, 8), 'pending')
const wang = monthlyAnalytics(db, u3, { year: 2026, month: 10, asOf: AS_OF })
check('多收入类别：2 项（工资/理财）', wang.income_by_category.length === 2, JSON.stringify(wang.income_by_category))
check('多收入类别：工资 9000 / 2 笔', wang.income_by_category.some((c) => c.category === '工资' && c.amount_cents === 9000 && c.count === 2))
check('多收入类别：理财 2000 / 1 笔', wang.income_by_category.some((c) => c.category === '理财' && c.amount_cents === 2000 && c.count === 1))
check('多收入类别：待入账奖金未混入', !wang.income_by_category.some((c) => c.category === '奖金'))
check('多收入类别合计 = 已入账收入 11000', wang.income_cents === 11000 && wang.income_by_category.reduce((s, c) => s + c.amount_cents, 0) === wang.income_cents)

db.close()

// ---------- 路由层（独立端口） ----------
let child = null
async function get(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

try {
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DB_PATH, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = await waitReady()
  check('服务器在独立测试端口启动', ready)

  const noMonth = await get('/api/analytics/monthly')
  check('缺少 month 返回 400', noMonth.status === 400 && noMonth.body?.success === false)
  const badMonth1 = await get('/api/analytics/monthly?month=2026-13')
  check('month=2026-13 返回 400', badMonth1.status === 400)
  const badMonth2 = await get('/api/analytics/monthly?month=abc')
  check('month=abc 返回 400', badMonth2.status === 400)

  const ok = await get('/api/analytics/monthly?month=2026-10')
  const d = ok.body?.data
  check('合法月份返回 200 且字段齐全', ok.status === 200 && ok.body?.success === true && d && d.month === '2026-10' && d.timezone === 'Asia/Shanghai' && typeof d.as_of === 'string' && typeof d.net_cents === 'number' && Array.isArray(d.income_by_category) && Array.isArray(d.expense_by_category))
  check('路由层：演示用户收入 = 15000（李四 99999999 未混入）', d.income_cents === 15000, d.income_cents)
  check('路由层：收入分类已返回且合计 15000', d.income_by_category.length === 1 && d.income_by_category[0].category === '收入' && d.income_by_category.reduce((s, c) => s + c.amount_cents, 0) === d.income_cents)
  check('路由层：李四 88888888 未出现在分类', !d.expense_by_category.some((c) => c.amount_cents === 88888888))
} catch (e) {
  console.error('测试脚本异常：', e)
  failures += 1
} finally {
  if (child) { try { child.kill() } catch {} }
  await new Promise((r) => setTimeout(r, 500))
  for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
