// 模拟转账服务：创建 → 查看 → 确认 → 取消，风险判定、当日累计与防重复执行。
// 只读 AI 助手不开放转账工具；转账通过独立接口由用户明确确认后执行（演示模式）。
import { randomUUID } from 'node:crypto'
import { shanghaiNowParts, shanghaiDayRange } from '../lib/shanghai.js'

export const DAILY_TRANSFER_LIMIT_CENTS = 100000 // 日累计成功转账上限：¥1000
export const TRANSFER_EXPIRY_MS = 5 * 60 * 1000     // 待确认有效期：5 分钟
export const MAX_REMARK_LEN = 200

const OPERATION_COLS = `
  id, ref_no, user_id, from_account_id, from_account_name, recipient_id, recipient_name,
  recipient_masked_account, amount_cents, remark, status, risk_level,
  created_at, expires_at, confirmed_at
`

// 创建期校验失败（→ HTTP 400）
export class TransferError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'TransferError'
    this.code = code
  }
}

function getById(db, id) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM transfer_operations WHERE id = ?`).get(id)
}

function transactionIdFor(db, refNo) {
  const t = db.prepare('SELECT id FROM transactions WHERE transfer_ref = ?').get(refNo)
  return t ? t.id : null
}

function toView(db, row) {
  const v = {
    ref_no: row.ref_no,
    from_account_id: row.from_account_id,
    from_account_name: row.from_account_name,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name,
    recipient_masked_account: row.recipient_masked_account,
    amount_cents: row.amount_cents,
    remark: row.remark,
    status: row.status,
    risk_level: row.risk_level,
    created_at: row.created_at,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
  }
  if (row.status === 'completed') v.transaction_id = transactionIdFor(db, row.ref_no)
  return v
}

// 上海自然日内已成功（completed）转账金额合计
function todayCompletedTransferCents(db, userId, now) {
  const { year, month, day } = shanghaiNowParts(now.getTime())
  const { start, end } = shanghaiDayRange(year, month, day)
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transfer_operations
       WHERE user_id = ? AND status = 'completed' AND confirmed_at >= ? AND confirmed_at < ?`,
    )
    .get(userId, start, end).s
}

export function listRecipients(db) {
  return db.prepare('SELECT id, name, masked_account FROM transfer_recipients ORDER BY id').all()
}

// 创建转账单（不扣款）。校验金额 / 收款人 / 账户状态与余额，风险级别由后端判定。
export function createTransfer(db, userId, { recipientId, amountCents, remark, fromAccountId }, now = new Date()) {
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new TransferError('金额必须为正整数（单位：分）', 'bad_amount')
  }
  if (typeof recipientId !== 'number' || !Number.isSafeInteger(recipientId) || recipientId <= 0) {
    throw new TransferError('收款人不合法', 'bad_recipient')
  }
  const recipient = db.prepare('SELECT id, name, masked_account FROM transfer_recipients WHERE id = ?').get(recipientId)
  if (!recipient) {
    throw new TransferError('收款人不存在', 'bad_recipient')
  }
  let fromAcct
  if (fromAccountId !== undefined) {
    if (typeof fromAccountId !== 'number' || !Number.isSafeInteger(fromAccountId) || fromAccountId <= 0) {
      throw new TransferError('付款账户不合法', 'bad_account')
    }
    fromAcct = db
      .prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'")
      .get(fromAccountId, userId)
  } else {
    fromAcct = db
      .prepare("SELECT * FROM accounts WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1")
      .get(userId)
  }
  if (!fromAcct) {
    throw new TransferError('没有可用的付款账户', 'no_account')
  }
  if (fromAcct.balance_cents < amountCents) {
    throw new TransferError('账户余额不足', 'insufficient_balance')
  }
  const cleanRemark = typeof remark === 'string' ? remark.trim() : ''
  if (cleanRemark.length > MAX_REMARK_LEN) {
    throw new TransferError(`备注过长（最多 ${MAX_REMARK_LEN} 字符）`, 'bad_remark')
  }

  const todayCum = todayCompletedTransferCents(db, userId, now)
  const riskLevel = todayCum + amountCents > DAILY_TRANSFER_LIMIT_CENTS ? 'red' : 'yellow'
  const status = riskLevel === 'red' ? 'needs_verification' : 'pending'
  const refNo = randomUUID()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + TRANSFER_EXPIRY_MS).toISOString()

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO transfer_operations
          (ref_no, user_id, from_account_id, from_account_name, recipient_id, recipient_name,
           recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refNo, userId, fromAcct.id, fromAcct.account_name, recipient.id, recipient.name,
        recipient.masked_account, amountCents, cleanRemark, status, riskLevel, createdAt, expiresAt,
      )
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'transfer', ?, 'create', ?, ?)`,
    ).run(userId, refNo, status, JSON.stringify({ amount_cents: amountCents, recipient_id: recipient.id }))
    return getById(db, info.lastInsertRowid)
  })
  return toView(db, run())
}

// 查看转账单（读取时惰性过期）
export function getTransfer(db, userId, refNo, now = new Date()) {
  const row = db.prepare(`SELECT ${OPERATION_COLS} FROM transfer_operations WHERE ref_no = ?`).get(refNo)
  if (!row || row.user_id !== userId) return null
  if (row.status === 'pending' && now.toISOString() > row.expires_at) {
    db.prepare("UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
    return toView(db, getById(db, row.id))
  }
  return toView(db, row)
}

// 确认并执行转账（同一事务内：扣款 + 入账流水 + 更新状态 + 审计）。
// outcome：'completed'（含幂等原回执）、'not_found'、'expired'、'cancelled'、
//          'needs_verification'、'failed'。
export function confirmTransfer(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = db.prepare(`SELECT ${OPERATION_COLS} FROM transfer_operations WHERE ref_no = ?`).get(refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'pending' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'expired', op: toView(db, getById(db, row.id)) }
    }
    if (row.status === 'completed') {
      return { outcome: 'completed', op: toView(db, row) }
    }
    if (row.status !== 'pending') {
      return { outcome: row.status, op: toView(db, row) }
    }

    const acct = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(row.from_account_id, userId)
    if (!acct || acct.status !== 'active') {
      db.prepare("UPDATE transfer_operations SET status = 'failed' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'failed', op: toView(db, getById(db, row.id)) }
    }

    // 创建后可能又有转账成功，确认时重新判断当日累计
    const todayCum = todayCompletedTransferCents(db, userId, now)
    if (todayCum + row.amount_cents > DAILY_TRANSFER_LIMIT_CENTS) {
      db.prepare("UPDATE transfer_operations SET status = 'needs_verification' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'needs_verification', op: toView(db, getById(db, row.id)) }
    }

    if (acct.balance_cents < row.amount_cents) {
      db.prepare("UPDATE transfer_operations SET status = 'failed' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'failed', op: toView(db, getById(db, row.id)) }
    }

    // 原子认领（CAS）：仅 pending → completed，防重复/并发确认
    const claim = db
      .prepare("UPDATE transfer_operations SET status = 'completed', confirmed_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), row.id)
    if (claim.changes !== 1) {
      return { outcome: 'completed', op: toView(db, getById(db, row.id)) }
    }

    const deduct = db
      .prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?')
      .run(row.amount_cents, row.from_account_id, row.amount_cents)
    if (deduct.changes !== 1) {
      throw new Error('扣款失败（余额不足）') // 回滚整个事务
    }

    const txInfo = db
      .prepare(
        `INSERT INTO transactions
          (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, transfer_ref)
         VALUES (?, ?, 'expense', ?, '转账', ?, ?, ?, 'posted', ?)`,
      )
      .run(userId, row.from_account_id, row.amount_cents, row.recipient_name, row.remark || '转账', now.toISOString(), row.ref_no)
    const txId = txInfo.lastInsertRowid

    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'transfer', ?, 'confirm', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ amount_cents: row.amount_cents, transaction_id: txId }))

    return { outcome: 'completed', op: toView(db, getById(db, row.id)), transaction_id: txId }
  })
  return run()
}

// 取消转账单（不扣款）。outcome：'cancelled'、'not_found'、'expired'、'completed'、
// 'needs_verification'、'failed'。
export function cancelTransfer(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = db.prepare(`SELECT ${OPERATION_COLS} FROM transfer_operations WHERE ref_no = ?`).get(refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'cancelled') return { outcome: 'cancelled', op: toView(db, row) }
    if (row.status === 'pending' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'expired', op: toView(db, getById(db, row.id)) }
    }
    if (row.status !== 'pending') {
      return { outcome: row.status, op: toView(db, row) }
    }

    db.prepare("UPDATE transfer_operations SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(row.id)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'transfer', ?, 'cancel', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ amount_cents: row.amount_cents }))
    return { outcome: 'cancelled', op: toView(db, getById(db, row.id)) }
  })
  return run()
}
