// 修复验证脚本：在独立临时数据库上验证「首次修复、重复执行、首次初始化」的数据一致性。
// 不修改开发数据库（backend/data/rongzhi.db），不依赖外部运行中的服务。
// 用法：node scripts/verify-fix.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { initDatabase } from '../src/db/index.js'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, '..')
const FIX_SCRIPT = join(__dirname, 'fix-future-posted.js')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const NOW = '2026-10-21T12:00:00.000Z'
const tmpDir = mkdtempSync(join(tmpdir(), 'rongzhi-fix-test-'))
const DB_A = join(tmpDir, 'mimic-dev.db')
const DB_B = join(tmpDir, 'fresh-seed.db')
const BACKUP_DIR = join(tmpDir, 'backups')

function demoUserId(db) {
  return db.prepare("SELECT id FROM users WHERE name = '张三'").get().id
}

// ---------- Part A：模拟开发库（含 4 笔未来 posted），验证首次修复 + 重复执行 ----------
{
  for (const p of [DB_A, DB_A + '-wal', DB_A + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const db = openDatabase(DB_A)
  createSchema(db)
  migrate(db)
  const uid = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
  const aid = db
    .prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents) VALUES (?, ?, ?, ?)')
    .run(uid, '人民币活期账户', 800000, 1983671).lastInsertRowid
  const ins = db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, transaction_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const rows = [
    ['income', 1280000, '收入', '2026-10-05T01:00:00.000Z', 'posted'],   // 已入账收入
    ['expense', 50000, '餐饮', '2026-10-03T00:00:00.000Z', 'posted'],     // 已入账支出
    ['expense', 8679, '住房', '2026-10-24T00:17:00.000Z', 'posted'],      // 未来 posted（bug）
    ['expense', 3910, '餐饮', '2026-10-24T01:27:00.000Z', 'posted'],      // 未来 posted（bug）
    ['expense', 3115, '订阅扣费', '2026-10-28T04:05:00.000Z', 'posted'],  // 未来 posted（bug）
    ['expense', 30625, '购物', '2026-10-28T09:48:00.000Z', 'posted'],     // 未来 posted（bug）
    ['expense', 30000, '交通', '2026-10-18T00:00:00.000Z', 'pending'],    // 原有待入账
    ['expense', 40000, '娱乐', '2026-10-19T00:00:00.000Z', 'pending'],    // 原有待入账
  ]
  for (const [direction, amount, category, at, status] of rows) {
    ins.run(uid, aid, direction, amount, category, at, status)
  }
  db.close()

  // 首次修复
  const r1 = spawnSync(process.execPath, [FIX_SCRIPT, DB_A], {
    cwd: BACKEND_DIR,
    env: { ...process.env, BACKUP_DIR, NOW },
    encoding: 'utf8',
  })
  check('首次修复退出码 0', r1.status === 0, (r1.stderr || '').trim())

  const d1 = openDatabase(DB_A)
  const uid1 = demoUserId(d1)
  check('首次修复后余额 = 2030000（800000 + 1280000 - 50000）', d1.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(uid1).b === 2030000)
  check('首次修复后交易总数不变（8）', d1.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(uid1).c === 8)
  const pend1 = d1.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE user_id = ? AND status='pending'").get(uid1)
  check('首次修复后待入账 6 笔 / 116329 分', pend1.c === 6 && pend1.s === 116329, `${pend1.c}/${pend1.s}`)
  check('首次修复后无未来 posted', d1.prepare("SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND status='posted' AND transaction_at > ?").get(uid1, NOW).c === 0)
  d1.close()

  // 重复执行（幂等）
  const r2 = spawnSync(process.execPath, [FIX_SCRIPT, DB_A], {
    cwd: BACKEND_DIR,
    env: { ...process.env, BACKUP_DIR, NOW },
    encoding: 'utf8',
  })
  check('重复执行退出码 0', r2.status === 0, (r2.stderr || '').trim())
  const d2 = openDatabase(DB_A)
  const uid2 = demoUserId(d2)
  check('重复执行后余额不变（2030000）', d2.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(uid2).b === 2030000)
  check('重复执行后交易总数不变（8）', d2.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(uid2).c === 8)
  const pend2 = d2.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE user_id = ? AND status='pending'").get(uid2)
  check('重复执行后待入账不变（6 / 116329）', pend2.c === 6 && pend2.s === 116329, `${pend2.c}/${pend2.s}`)
  d2.close()
}

// ---------- Part B：首次初始化（种子修复后）----------
{
  for (const p of [DB_B, DB_B + '-wal', DB_B + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const { db } = initDatabase({ dbPath: DB_B, seed: true })
  const nowReal = new Date().toISOString()
  const futurePosted = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE status='posted' AND transaction_at > ?").get(nowReal).c
  check('首次初始化：无未来 posted 记录', futurePosted === 0, futurePosted)
  const acc = db.prepare('SELECT opening_balance_cents AS o, balance_cents AS b FROM accounts LIMIT 1').get()
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='income' THEN amount_cents ELSE 0 END),0) AS i,
         COALESCE(SUM(CASE WHEN direction='expense' THEN amount_cents ELSE 0 END),0) AS e
       FROM transactions WHERE status='posted' AND transaction_at <= ?`,
    )
    .get(nowReal)
  check('首次初始化：余额 = 期初 + 已入账（截至当前）流水', acc.b === acc.o + sums.i - sums.e, `balance=${acc.b}`)
  db.close()
}

// 清理临时目录
try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
