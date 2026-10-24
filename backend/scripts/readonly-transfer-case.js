// 原案例只读核查脚本：以只读方式打开开发库，核对「转账已成功但 AI 曾答待确认」案例的真实数据，
// 不重放、不回滚、不重新转账、不写入任何数据。
// 用法：node scripts/readonly-transfer-case.js [数据库路径]
import Database from 'better-sqlite3'
import { DEFAULT_DB_PATH } from '../src/db/connection.js'

const dbPath = process.argv[2] || DEFAULT_DB_PATH
const db = new Database(dbPath, { readonly: true, fileMustExist: true })

const REF = '0e0e8420-0336-4127-95c6-8653a99cacba'

const transfer = db.prepare('SELECT * FROM transfer_operations WHERE ref_no = ?').get(REF)
const tx63 = db.prepare('SELECT * FROM transactions WHERE id = 63').get()
const txByRef = db.prepare('SELECT * FROM transactions WHERE transfer_ref = ?').get(REF)

console.log('== 原案例转账单（只读） ==')
if (transfer) {
  console.log({
    ref_no: transfer.ref_no,
    user_id: transfer.user_id,
    session_id: transfer.session_id,
    from_account_id: transfer.from_account_id,
    from_account_name: transfer.from_account_name,
    recipient_name: transfer.recipient_name,
    amount_cents: transfer.amount_cents,
    status: transfer.status,
    risk_level: transfer.risk_level,
    created_at: transfer.created_at,
    confirmed_at: transfer.confirmed_at,
  })
} else {
  console.log('（未找到该转账单）')
}

console.log('\n== 流水 id=63（只读） ==')
if (tx63) {
  console.log({
    id: tx63.id,
    user_id: tx63.user_id,
    account_id: tx63.account_id,
    direction: tx63.direction,
    amount_cents: tx63.amount_cents,
    merchant: tx63.merchant,
    status: tx63.status,
    transfer_ref: tx63.transfer_ref,
    transaction_at: tx63.transaction_at,
  })
} else {
  console.log('（未找到 id=63 的流水）')
}

console.log('\n== 按转账单编号关联的流水（只读） ==')
if (txByRef) {
  console.log({ id: txByRef.id, direction: txByRef.direction, amount_cents: txByRef.amount_cents, status: txByRef.status, transfer_ref: txByRef.transfer_ref })
} else {
  console.log('（无按该单编号关联的流水）')
}

if (transfer) {
  const acct = db.prepare('SELECT account_name, balance_cents FROM accounts WHERE id = ?').get(transfer.from_account_id)
  console.log('\n== 付款账户当前余额（只读） ==')
  console.log(acct || '（未找到付款账户）')
}

db.close()
console.log('\n只读核查完成：未执行任何写入。')
