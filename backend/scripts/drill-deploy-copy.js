// 开发库一致性副本 · 部署演练脚本（对应「部署前验收 · 二」）。
//
// 只读开发库（经 SQLite backup API 取一致性快照，正确处理 WAL），全部写操作仅发生在副本与独立临时库上：
//  1. 一致性副本：db.backup()（非文件复制）从开发库生成快照；
//  2. 副本经真实应用启动路径 initDatabase（createSchema + migrate）迁移，重复迁移幂等；
//  3. 迁移只「补结构不回填破坏」：旧账户余额 / 交易流水 / 会话 / 操作单逐条保留，
//     account_type 回填 deposit、flow_kind 回填 external、repayment_ref 置 NULL，新增 4 张信用表为空；
//  4. 演示数据 seed 对「已含演示用户张三」的副本拒绝（安全护栏，不改造现有数据、不覆盖余额）；
//  5. 演示数据 seed 在独立空库生成，重复 seed 幂等（不重复卡片 / 消费 / 账单）；
//  6. 副本 + 演示库 integrity_check + foreign_key_check。
//
// 不修改开发库、不调用收费模型。用法：node scripts/drill-deploy-copy.js
import { openDatabase, DEFAULT_DB_PATH } from '../src/db/connection.js'
import { initDatabase, migrate } from '../src/db/index.js'
import { seedDemoData, checkDemoData } from './seed-demo.js'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = join(tmpdir(), 'rongzhi-deploy-drill')
const COPY_PATH = join(WORK, 'copy.db')
const SEED_PATH = join(WORK, 'seed.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function wipe(p) {
  for (const x of [p, p + '-wal', p + '-shm']) {
    try { rmSync(x, { force: true }) } catch {}
  }
}

// 旧结构即可查询的「业务数据快照」：只触碰迁移前就存在的列与表，用于证明迁移保留旧数据。
const LEGACY_TABLES = [
  'users', 'cards', 'subscriptions', 'transfer_operations', 'card_operations', 'subscription_operations',
  'audit_logs', 'agent_tasks', 'agent_task_nodes', 'chat_sessions', 'chat_messages', 'chat_state',
  'verification_bindings', 'verification_failures', 'totp_used_steps', 'transfer_recipients',
]
function dataSnapshot(db) {
  const accounts = db.prepare('SELECT id, account_name, opening_balance_cents, balance_cents FROM accounts ORDER BY id').all()
  const tx = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS s FROM transactions').get()
  const counts = {}
  for (const t of LEGACY_TABLES) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c } catch { counts[t] = null }
  }
  return { accounts, tx, counts }
}
function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
}

// —— 1. 一致性副本（backup API，非文件复制）——
mkdirSync(WORK, { recursive: true })
for (const p of [COPY_PATH, SEED_PATH, COPY_PATH + '-wal', COPY_PATH + '-shm', SEED_PATH + '-wal', SEED_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
check('开发库存在', existsSync(DEFAULT_DB_PATH), DEFAULT_DB_PATH)
const src = openDatabase(DEFAULT_DB_PATH)
await src.backup(COPY_PATH)
src.close()
check('一致性副本已生成（backup API）', existsSync(COPY_PATH), COPY_PATH)

// —— 2. 迁移前后：旧数据保留 + 新结构补齐 ——
const before = (() => { const d = openDatabase(COPY_PATH); const s = { data: dataSnapshot(d), tables: tableNames(d) }; d.close(); return s })()
const beforeCreditTables = ['credit_accounts', 'statements', 'statement_payments', 'repayment_operations'].filter((t) => before.tables.includes(t))
check('副本反映开发库现状（迁移前无信用表）', beforeCreditTables.length === 0, beforeCreditTables.length ? beforeCreditTables.join(',') : '已是最新结构')

const { db } = initDatabase({ dbPath: COPY_PATH, seed: false }) // 与 index.js 启动路径一致
const after1 = dataSnapshot(db)
const tables1 = tableNames(db)
check('迁移后旧账户余额 / 流水 / 会话 / 操作单逐条保留', JSON.stringify(after1) === JSON.stringify(before.data), `${after1.accounts.length} 账户，流水 ${after1.tx.c} 笔`)

const accTypes = db.prepare('SELECT account_type FROM accounts ORDER BY id').all().map((r) => r.account_type)
check('迁移回填 account_type=deposit（旧账户不改余额）', accTypes.length === after1.accounts.length && accTypes.every((t) => t === 'deposit'), accTypes.join(','))
const flowKinds = db.prepare('SELECT flow_kind, repayment_ref FROM transactions').all()
check('迁移回填 flow_kind=external、repayment_ref=NULL（流水不改金额）', flowKinds.every((r) => r.flow_kind === 'external' && r.repayment_ref === null), `${flowKinds.length} 笔`)
const creditEmpty = ['credit_accounts', 'statements', 'statement_payments', 'repayment_operations'].every((t) => tables1.includes(t) && db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c === 0)
check('迁移新增 4 张信用表（空，未注入演示数据）', creditEmpty, `${tables1.length} 张表`)

// —— 3. 重复迁移幂等 ——
migrate(db)
const after2 = dataSnapshot(db)
const tables2 = tableNames(db)
check('重复迁移幂等（数据与表结构不再变化）', JSON.stringify(after2) === JSON.stringify(after1) && JSON.stringify(tables2) === JSON.stringify(tables1), `${tables2.length} 张表`)

// —— 4. 完整性 + 外键（副本）——
const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('副本 integrity_check = ok', Array.isArray(ic) && ic.length === 1 && ic[0].integrity_check === 'ok', JSON.stringify(ic))
check('副本 foreign_key_check 无违例', Array.isArray(fk) && fk.length === 0, `${fk.length} 处违例`)

// —— 5. 演示数据 seed 对已含「张三」的副本 → 拒绝（不改造现有数据）——
const refusal = seedDemoData(db)
check('seed 对开发库副本拒绝（不改造现有数据）', refusal.seeded === false && /独立空库|破坏现有数据|混用/.test(refusal.reason || ''), refusal.reason)
check('拒绝后副本账户余额不变', JSON.stringify(dataSnapshot(db).accounts) === JSON.stringify(after1.accounts))
db.close()

// —— 6. 演示数据 seed 在独立空库生成，重复 seed 幂等 ——
const { db: seedDb } = initDatabase({ dbPath: SEED_PATH, seed: false })
const r1 = seedDemoData(seedDb)
check('seed 在独立空库生成成功', r1.seeded === true, r1.summary ? '2 借记卡 + 1 信用卡' : '')
const counts1 = {
  cards: seedDb.prepare('SELECT COUNT(*) AS c FROM cards').get().c,
  credit: seedDb.prepare('SELECT COUNT(*) AS c FROM credit_accounts').get().c,
  statements: seedDb.prepare('SELECT COUNT(*) AS c FROM statements').get().c,
  consumptions: seedDb.prepare("SELECT COUNT(*) AS c FROM transactions WHERE flow_kind = 'external'").get().c,
}
const r2 = seedDemoData(seedDb)
const counts2 = {
  cards: seedDb.prepare('SELECT COUNT(*) AS c FROM cards').get().c,
  credit: seedDb.prepare('SELECT COUNT(*) AS c FROM credit_accounts').get().c,
  statements: seedDb.prepare('SELECT COUNT(*) AS c FROM statements').get().c,
  consumptions: seedDb.prepare("SELECT COUNT(*) AS c FROM transactions WHERE flow_kind = 'external'").get().c,
}
check('重复 seed 返回未播种（幂等）', r2.seeded === false)
check('重复 seed 不重复卡片/信用/账单/消费', JSON.stringify(counts1) === JSON.stringify(counts2), JSON.stringify(counts2))
const chk = checkDemoData(seedDb)
check('演示库 checkDemoData 通过', chk.ok === true, (chk.problems || []).join('; '))

const ic2 = seedDb.pragma('integrity_check')
const fk2 = seedDb.pragma('foreign_key_check')
check('演示库 integrity_check = ok', Array.isArray(ic2) && ic2.length === 1 && ic2[0].integrity_check === 'ok')
check('演示库 foreign_key_check 无违例', Array.isArray(fk2) && fk2.length === 0, `${fk2.length} 处违例`)
seedDb.close()

// 清理临时文件（开发库不受影响）
for (const p of [COPY_PATH, SEED_PATH, COPY_PATH + '-wal', COPY_PATH + '-shm', SEED_PATH + '-wal', SEED_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n部署演练全部通过 ✅（开发库未改动）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
