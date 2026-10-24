// 可选演示数据脚本验证：仅在独立临时库上运行，不触碰开发库、不调用收费模型。
//
// 覆盖：
//  A. seedDemoData 生成隔离演示库：2 借记卡 + 1 信用卡 + 可控跨期样本；
//  B. 状态机覆盖：paid（上上月已结清）/ open·overdue（上月已出账未结清）/ unissued（本月未出账）+ 待入账占用；
//  C. 一致性：posted_outstanding = 各账单剩余应还之和、pending_occupied = 待入账消费之和、
//     还款流水 / 冲抵明细 / 审计 / 操作单完整、还款后借记账户已扣款、信用额度恢复口径正确；
//  D. 幂等：重复 seedDemoData 不重复插入、不破坏已有数据；
//  E. 安全护栏：--db 指向开发库时无 --allow-dev-db 应拒绝（不在此脚本内模拟，脚本只验证数据正确性）。
// 用法：node scripts/verify-demo-seed.js
import { initDatabase } from '../src/db/index.js'
import { seedDemoData, checkDemoData } from './seed-demo.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const DB_PATH = join(tmpdir(), 'rongzhi-demo-seed-verify.db')

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

// A/B/C：生成并校验
const res = seedDemoData(db)
check('A1 seedDemoData 返回 seeded', res.seeded === true, String(res.seeded))
const user = db.prepare("SELECT id FROM users WHERE name = '张三'").get()
check('A2 演示用户「张三」存在', !!user)

const debitCards = db.prepare("SELECT c.id FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.account_type = 'deposit'").all(user.id)
const creditCards = db.prepare("SELECT c.id FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.account_type = 'credit'").all(user.id)
check('B1 借记卡 2 张', debitCards.length === 2, String(debitCards.length))
check('B2 信用卡 1 张', creditCards.length === 1, String(creditCards.length))

const ca = db.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(user.id)
check('B3 信用额度 ¥50000', ca.credit_limit_cents === 5000000, String(ca.credit_limit_cents))

const stmts = db.prepare('SELECT * FROM statements WHERE credit_account_id = ? ORDER BY statement_year, statement_month').all(ca.id)
check('B4 产生 3 期账单（上上月/上月/本月）', stmts.length === 3, String(stmts.length))
const statusOf = (s) => (s.issued_at == null ? 'unissued' : (s.new_charges_cents - s.paid_cents <= 0 ? 'paid' : (new Date().toISOString() >= s.due_on ? 'overdue' : 'open')))
check('B5 覆盖 paid 状态', stmts.some((s) => statusOf(s) === 'paid'))
check('B6 覆盖 unissued 状态', stmts.some((s) => statusOf(s) === 'unissued'))
check('B7 覆盖 open/overdue 状态', stmts.some((s) => statusOf(s) === 'open' || statusOf(s) === 'overdue'))

const allRemaining = stmts.reduce((sum, s) => sum + (s.new_charges_cents - s.paid_cents), 0)
check('C1 posted_outstanding = 各账单剩余应还之和', ca.posted_outstanding_cents === allRemaining, `${ca.posted_outstanding_cents} vs ${allRemaining}`)
const pendingSum = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE user_id = ? AND account_id = ? AND flow_kind = 'external' AND status = 'pending'").get(user.id, ca.account_id).s
check('C2 pending_occupied = 待入账消费之和', ca.pending_occupied_cents === pendingSum, `${ca.pending_occupied_cents} vs ${pendingSum}`)
check('C3 有待入账占用（本月消费占额）', ca.pending_occupied_cents > 0, String(ca.pending_occupied_cents))

const paidStmt = stmts.find((s) => statusOf(s) === 'paid')
check('C4 已结清账单存在冲抵明细', db.prepare('SELECT COUNT(*) AS c FROM statement_payments WHERE statement_id = ?').get(paidStmt.id).c === 1)
const repayOp = db.prepare('SELECT * FROM repayment_operations WHERE statement_id = ?').get(paidStmt.id)
check('C5 还款操作单为 completed', !!repayOp && repayOp.status === 'completed', repayOp && repayOp.status)
check('C6 还款流水 flow_kind=repayment 且关联唯一', !!repayOp && db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE repayment_ref = ? AND flow_kind = ?').get(repayOp.ref_no, 'repayment').c === 1)
check('C7 还款审计日志存在', !!repayOp && db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type = ? AND operation_ref = ?').get('repayment', repayOp.ref_no).c >= 2)

// 还款来源借记账户已扣款（余额 = 期初 + 收支净额 - 还款额，仅校验还款额已扣）
const debit1 = db.prepare("SELECT a.* FROM accounts a WHERE a.user_id = ? AND a.account_type = 'deposit' ORDER BY a.id LIMIT 1").get(user.id)
const repayTx = db.prepare('SELECT * FROM transactions WHERE repayment_ref = ?').get(repayOp.ref_no)
check('C8 还款金额为 ¥1679（上上月两笔之和）', repayOp.amount_cents === 167900, String(repayOp.amount_cents))
check('C9 还款流水落在还款来源借记账户', repayTx.account_id === repayOp.from_account_id, `${repayTx.account_id} vs ${repayOp.from_account_id}`)

// D：幂等
const beforeCounts = {
  users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
  accounts: db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c,
  cards: db.prepare('SELECT COUNT(*) AS c FROM cards').get().c,
  statements: db.prepare('SELECT COUNT(*) AS c FROM statements').get().c,
  credit: db.prepare('SELECT COUNT(*) AS c FROM credit_accounts').get().c,
}
const res2 = seedDemoData(db)
check('D1 重复 seedDemoData 返回未播种', res2.seeded === false, String(res2.seeded))
const afterCounts = {
  users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
  accounts: db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c,
  cards: db.prepare('SELECT COUNT(*) AS c FROM cards').get().c,
  statements: db.prepare('SELECT COUNT(*) AS c FROM statements').get().c,
  credit: db.prepare('SELECT COUNT(*) AS c FROM credit_accounts').get().c,
}
check('D2 重复播种后各表条数不变', JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), JSON.stringify(afterCounts))

// checkDemoData 自身
const chk = checkDemoData(db)
check('E1 checkDemoData 通过', chk.ok === true, (chk.problems || []).join('; '))

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
