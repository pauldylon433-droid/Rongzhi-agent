// API 验证脚本：在独立的临时数据库 + 独立端口上启动后端，运行只读接口断言。
// 不修改开发数据库（backend/data/rongzhi.db），不依赖任何外部运行中的服务。
// 用法：node scripts/verify-api.js
import { initDatabase } from '../src/db/index.js'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, '..')
const DB_PATH = join(tmpdir(), 'rongzhi-api-test.db')
const PORT = 3107

let failures = 0
let child = null

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function shanghaiMonthOfIso(iso) {
  const d = new Date(iso)
  const sh = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, '0')}`
}

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
  // 1. 构建独立临时库：种子数据 + 第二名用户 + 两笔月边界交易
  for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const { db } = initDatabase({ dbPath: DB_PATH, seed: true })
  const demo = db.prepare("SELECT id FROM users WHERE name = '张三'").get()
  const now = new Date().toISOString()

  const liId = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('李四', now).lastInsertRowid
  const liAcc = db.prepare(
    `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(liId, '李四测试账户', 100000, 100000, 'CNY', 'active', now).lastInsertRowid
  db.prepare(
    `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(liId, liAcc, '9999 **** **** 0000', '借记卡', 'active', 1000000, now)
  db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(liId, liAcc, 'expense', 9999, '购物', '李四专属商户', '测试', now, 'posted')
  db.prepare(
    `INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(liId, liAcc, '李四专属订阅', 5000, 'monthly', now, 'active', now)

  // 给演示用户加两笔“月边界”交易（验证按上海时区的自然月边界）：
  // 上海 2026-10-01 00:30 → UTC 2026-09-30T16:30Z，应属于 10 月
  // 上海 2026-09-30 23:30 → UTC 2026-09-30T15:30Z，应属于 9 月
  db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(demo.id, 1, 'expense', 100, '餐饮', '月初边界测试', '边界', '2026-09-30T16:30:00.000Z', 'posted')
  db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(demo.id, 1, 'expense', 100, '餐饮', '月末边界测试', '边界', '2026-09-30T15:30:00.000Z', 'posted')
  db.close()

  // 2. 启动服务器（独立端口 + 临时库）
  let serverLog = ''
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DB_PATH, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { serverLog += d.toString() })
  child.stderr.on('data', (d) => { serverLog += d.toString() })

  const ready = await waitReady()
  check('服务器在独立测试端口启动', ready, serverLog.trim().split('\n').pop() || '')

  // 3. 断言
  const health = await get('/api/health')
  check('GET /api/health 正常', health.status === 200 && health.body.success === true)

  const accounts = await get('/api/accounts')
  check('GET /api/accounts 只返回演示用户账户', accounts.body?.success === true && accounts.body.data.length === 1, `账户数 ${accounts.body?.data?.length}`)
  check('账户返回开户日期 opened_on=2026-08-01', accounts.body.data[0].opened_on === '2026-08-01', accounts.body.data[0].opened_on)

  const cards = await get('/api/cards')
  check('GET /api/cards 只返回演示用户卡片', cards.body?.success === true && cards.body.data.length === 1, `卡数 ${cards.body?.data?.length}`)
  check('卡片仅返回掩码卡号', cards.body.data[0].masked_card_number === '6222 **** **** 1234' && cards.body.data[0].full_card_number === undefined)
  check('银行卡返回开卡日期 issued_on=2026-08-01', cards.body.data[0].issued_on === '2026-08-01', cards.body.data[0].issued_on)

  const subs = await get('/api/subscriptions')
  check('GET /api/subscriptions 返回 6 条', subs.body?.success === true && subs.body.data.length === 6, `订阅数 ${subs.body?.data?.length}`)

  const txDefault = await get('/api/transactions')
  check('GET /api/transactions 默认 limit=50', txDefault.body.data.length === 50 && txDefault.body.meta.total === 60, `data=${txDefault.body.data.length} total=${txDefault.body.meta.total}`)

  const txAll = await get('/api/transactions?limit=100')
  const leaked = txAll.body.data.some((t) => t.merchant === '李四专属商户')
  check('第二用户数据不泄露（total=60 且无李四数据）', txAll.body.meta.total === 60 && txAll.body.data.length === 60 && !leaked)

  const txPage = await get('/api/transactions?limit=5&offset=0')
  check('分页 limit=5 offset=0', txPage.body.data.length === 5 && txPage.body.meta.total === 60 && txPage.body.meta.limit === 5 && txPage.body.meta.offset === 0)
  const txPage2 = await get('/api/transactions?limit=5&offset=55')
  check('分页 offset=55 返回剩余 5 条', txPage2.body.data.length === 5 && txPage2.body.meta.total === 60)

  let sorted = true
  const at = txAll.body.data.map((t) => t.transaction_at)
  for (let i = 1; i < at.length; i++) if (at[i] > at[i - 1]) sorted = false
  check('按 transaction_at 倒序（稳定）', sorted)

  const oct = await get('/api/transactions?month=2026-10&limit=100')
  const octOk = oct.body.data.length > 0
    && oct.body.data.every((t) => shanghaiMonthOfIso(t.transaction_at) === '2026-10')
    && oct.body.data.some((t) => t.merchant === '月初边界测试')
    && !oct.body.data.some((t) => t.merchant === '月末边界测试')
  check('month=2026-10 上海时区边界正确', octOk, `10月 ${oct.body.data.length} 条`)

  const sep = await get('/api/transactions?month=2026-09&limit=100')
  const sepOk = sep.body.data.length > 0
    && sep.body.data.every((t) => shanghaiMonthOfIso(t.transaction_at) === '2026-09')
    && sep.body.data.some((t) => t.merchant === '月末边界测试')
    && !sep.body.data.some((t) => t.merchant === '月初边界测试')
  check('month=2026-09 上海时区边界正确', sepOk, `9月 ${sep.body.data.length} 条`)

  const empty = await get('/api/transactions?month=1999-01')
  check('无匹配返回空数组 total=0', empty.status === 200 && empty.body.success === true && empty.body.data.length === 0 && empty.body.meta.total === 0)

  const badMonth1 = await get('/api/transactions?month=2026-13')
  check('month=2026-13 返回 400', badMonth1.status === 400 && badMonth1.body.success === false)
  const badMonth2 = await get('/api/transactions?month=abc')
  check('month=abc 返回 400', badMonth2.status === 400)
  const badLimit1 = await get('/api/transactions?limit=0')
  check('limit=0 返回 400', badLimit1.status === 400)
  const badLimit2 = await get('/api/transactions?limit=101')
  check('limit=101 返回 400', badLimit2.status === 400)
  const badLimit3 = await get('/api/transactions?limit=abc')
  check('limit=abc 返回 400', badLimit3.status === 400)
  const badOffset = await get('/api/transactions?offset=-1')
  check('offset=-1 返回 400', badOffset.status === 400)

  const errBody = JSON.stringify(badMonth1.body)
  check('错误响应不含 SQL/堆栈/路径', !/SELECT|\.db|at |Error/i.test(errBody))
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
