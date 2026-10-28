// 迁移验证脚本：在独立临时库上构造「旧结构」的账户/银行卡表，验证 migrate() 的
// 增量迁移、回填与幂等性，并确认不改动交易与已有数据。不修改开发数据库。
// 用法：node scripts/verify-migrate.js
import { openDatabase } from '../src/db/connection.js'
import { migrate } from '../src/db/migrate.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(tmpdir(), 'rongzhi-migrate-test.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

const db = openDatabase(DB_PATH)

// 构造「旧结构」表（无 opened_on / issued_on），模拟迁移前的存量数据库
db.exec(`
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    masked_card_number TEXT NOT NULL,
    card_type TEXT NOT NULL,
    status TEXT NOT NULL,
    daily_limit_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE transfer_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    masked_account TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const createdAt = '2026-10-21 10:00:00'
db.prepare(
  `INSERT INTO accounts (user_id, account_name, balance_cents, currency, status, created_at)
   VALUES (1, '人民币活期账户', 4233109, 'CNY', 'active', ?)`,
).run(createdAt)
db.prepare(
  `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, created_at)
   VALUES (1, 1, '6222 **** **** 1234', '借记卡', 'active', 5000000, ?)`,
).run(createdAt)
db.prepare(
  `INSERT INTO transactions (user_id, direction, amount_cents, status) VALUES (1, 'expense', 56306, 'posted')`,
).run()

// 1. 迁移前：无业务日期字段
const beforeAcc = db.prepare('SELECT * FROM accounts LIMIT 1').get()
check('迁移前账户无 opened_on 字段', beforeAcc.opened_on === undefined)

// 2. 第一次迁移：补列 + 回填
migrate(db)
const acc = db.prepare('SELECT opened_on, created_at FROM accounts LIMIT 1').get()
const card = db.prepare('SELECT issued_on, version, created_at FROM cards LIMIT 1').get()
check('迁移后账户 opened_on = 2026-08-01', acc.opened_on === '2026-08-01', acc.opened_on)
check('迁移后银行卡 issued_on = 2026-08-01', card.issued_on === '2026-08-01', card.issued_on)
check('迁移后银行卡 version 回填为 1', card.version === 1, card.version)
check('迁移不改动 created_at', acc.created_at === createdAt && card.created_at === createdAt)
check('迁移不改动交易', db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c === 1)

// 3. 重复迁移：幂等，数据不变
migrate(db)
const acc2 = db.prepare('SELECT opened_on FROM accounts LIMIT 1').get()
const card2 = db.prepare('SELECT issued_on FROM cards LIMIT 1').get()
check('重复迁移后 opened_on 不变', acc2.opened_on === '2026-08-01')
check('重复迁移后 issued_on 不变', card2.issued_on === '2026-08-01')
check('重复迁移后账户条数不变', db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c === 1)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
