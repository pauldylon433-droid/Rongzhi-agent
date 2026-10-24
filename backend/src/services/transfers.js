// 模拟转账服务：创建 → 查看 → 确认 → 取消，风险判定、当日累计与防重复执行。
// 只读 AI 助手不开放转账工具；转账通过独立接口由用户明确确认后执行（演示模式）。
import { randomUUID } from 'node:crypto'
import { shanghaiNowParts, shanghaiDayRange } from '../lib/shanghai.js'

// 日累计转账强验证分级阈值（¥1000）：当日已成功转账 + 本次金额不超过该值为黄色界面确认，
// 超过则升级为红色强验证（交易密码 + TOTP）。这是风险分级阈值，不是业务金额上限，规则不变。
export const DAILY_TRANSFER_LIMIT_CENTS = 100000
export const TRANSFER_EXPIRY_MS = 5 * 60 * 1000     // 待确认有效期：5 分钟
export const MAX_REMARK_LEN = 200

const OPERATION_COLS = `
  id, ref_no, user_id, session_id, from_account_id, from_account_name, recipient_id, recipient_name,
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

// —— 供强验证服务复用的读取 / 视图 / 执行核心（避免复制第二套扣款实现） ——

export function getTransferRow(db, refNo) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM transfer_operations WHERE ref_no = ?`).get(refNo)
}

export function viewTransfer(db, row) {
  return toView(db, row)
}

// 转账执行核心：账户/余额校验 + 状态 CAS 认领 + 扣款 + 入账流水 + 审计。
// 黄色确认（expectedStatus='pending'）与红色强验证（'needs_verification'）复用同一套
// 扣款 / 流水 / 状态 CAS / 唯一索引 / 审计逻辑。
// 前置：归属、到期、终态、当日累计（以及红色验证码）均已在校验通过后调用。
export function finalizeTransfer(db, userId, row, now, expectedStatus) {
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(row.from_account_id, userId)
  if (!acct || acct.status !== 'active' || acct.account_type !== 'deposit') {
    db.prepare(`UPDATE transfer_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'failed', op: viewTransfer(db, getById(db, row.id)) }
  }
  if (acct.balance_cents < row.amount_cents) {
    db.prepare(`UPDATE transfer_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'failed', op: viewTransfer(db, getById(db, row.id)) }
  }

  // 原子认领（CAS）：仅目标状态 → completed，防重复/并发确认
  const claim = db
    .prepare(`UPDATE transfer_operations SET status = 'completed', confirmed_at = ? WHERE id = ? AND status = ?`)
    .run(now.toISOString(), row.id, expectedStatus)
  if (claim.changes !== 1) {
    return { outcome: 'completed', op: viewTransfer(db, getById(db, row.id)) }
  }

  const deduct = db
    .prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?')
    .run(row.amount_cents, row.from_account_id, row.amount_cents)
  if (deduct.changes !== 1) throw new Error('扣款失败（余额不足）') // 回滚整个事务

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

  // 权威回执：清除发起该单的原始会话的「待确认」引用（仅当仍指向本单，不影响后续新单）。
  // 后续查询据此以数据库最新状态为准，不再沿用「已生成待确认单」的旧上下文。
  if (row.session_id) {
    db.prepare(
      `UPDATE chat_sessions SET pending_transfer_ref = NULL WHERE id = ? AND pending_transfer_ref = ?`,
    ).run(row.session_id, row.ref_no)
  }

  return { outcome: 'completed', op: viewTransfer(db, getById(db, row.id)), transaction_id: txId }
}

export function listRecipients(db) {
  return db.prepare('SELECT id, name, masked_account FROM transfer_recipients ORDER BY id').all()
}

// 读取某助手会话最近一笔转账的权威状态（供聊天上下文注入；不扫描全部历史，仅单条按会话索引查询）。
// 返回精简回执（真实操作状态、金额、付款账户、收款人、流水引用、确认时间），无会话或无转账返回 null。
export function latestTransferForSession(db, userId, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  const row = db
    .prepare(
      `SELECT ${OPERATION_COLS} FROM transfer_operations
       WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, sessionId)
  if (!row) return null
  const v = viewTransfer(db, row)
  return {
    ref_no: row.ref_no,
    status: row.status,
    amount_cents: row.amount_cents,
    from_account_name: row.from_account_name,
    recipient_name: row.recipient_name,
    transaction_id: v.transaction_id || null,
    confirmed_at: row.confirmed_at,
  }
}

// 创建转账单（不扣款）。校验金额 / 收款人 / 账户状态与余额，风险级别由后端判定。
// sessionId 为发起该单的助手会话（可空）：确认时据此把权威回执关联回原始会话，而非「确认时恰好打开的会话」。
export function createTransfer(db, userId, { recipientId, amountCents, remark, fromAccountId, sessionId }, now = new Date()) {
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
    // 信用卡账户（account_type='credit'）不得作为对外付款账户；不得自动替换成借记卡。
    if (fromAcct && fromAcct.account_type !== 'deposit') {
      throw new TransferError('信用卡账户不可用于对外转账，请选择借记卡关联的活期账户', 'bad_account')
    }
  } else {
    fromAcct = db
      .prepare("SELECT * FROM accounts WHERE user_id = ? AND status = 'active' AND account_type = 'deposit' ORDER BY id LIMIT 1")
      .get(userId)
  }
  if (!fromAcct) {
    throw new TransferError('没有可用的付款账户', 'no_account')
  }
  if (fromAcct.account_type !== 'deposit') {
    throw new TransferError('信用卡账户不可用于对外转账', 'bad_account')
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
          (ref_no, user_id, session_id, from_account_id, from_account_name, recipient_id, recipient_name,
           recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refNo, userId, typeof sessionId === 'string' && sessionId ? sessionId : null,
        fromAcct.id, fromAcct.account_name, recipient.id, recipient.name,
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

// 查看转账单（读取时惰性过期，含红色待验证单）
export function getTransfer(db, userId, refNo, now = new Date()) {
  const row = getTransferRow(db, refNo)
  if (!row || row.user_id !== userId) return null
  if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
    db.prepare(`UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
    return viewTransfer(db, getById(db, row.id))
  }
  return viewTransfer(db, row)
}

// 确认并执行转账（同一事务内：扣款 + 入账流水 + 更新状态 + 审计）。
// outcome：'completed'（含幂等原回执）、'not_found'、'expired'、'cancelled'、
//          'needs_verification'、'failed'。
export function confirmTransfer(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getTransferRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'pending' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'expired', op: viewTransfer(db, getById(db, row.id)) }
    }
    if (row.status === 'completed') return { outcome: 'completed', op: viewTransfer(db, row) }
    if (row.status !== 'pending') return { outcome: row.status, op: viewTransfer(db, row) }

    // 创建后可能又有转账成功，确认时重新判断当日累计（仍过线则转红，进入强验证）。
    // 状态与风险等级在同一事务、同一 CAS 条件（status='pending'）下一起写入，
    // 返回视图 / 后续 GET / 助手状态查询 / 最终回执均读取同一份权威字段。
    const todayCum = todayCompletedTransferCents(db, userId, now)
    if (todayCum + row.amount_cents > DAILY_TRANSFER_LIMIT_CENTS) {
      const upgrade = db
        .prepare("UPDATE transfer_operations SET status = 'needs_verification', risk_level = 'red' WHERE id = ? AND status = 'pending'")
        .run(row.id)
      if (upgrade.changes === 1) {
        // 仅记录业务元数据（金额 / 当日累计 / 阈值），不含任何凭据或验证码。
        db.prepare(
          `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
           VALUES (?, 'transfer', ?, 'risk_upgrade', 'needs_verification', ?)`,
        ).run(userId, row.ref_no, JSON.stringify({
          amount_cents: row.amount_cents,
          today_completed_cents: todayCum,
          limit_cents: DAILY_TRANSFER_LIMIT_CENTS,
        }))
      }
      return { outcome: 'needs_verification', op: viewTransfer(db, getById(db, row.id)) }
    }

    return finalizeTransfer(db, userId, row, now, 'pending')
  })
  return run()
}

// 取消转账单（不扣款；含红色待验证单）。outcome：'cancelled'、'not_found'、'expired'、'completed'、'failed'。
export function cancelTransfer(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getTransferRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'cancelled') return { outcome: 'cancelled', op: viewTransfer(db, row) }
    if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
      db.prepare(`UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
      return { outcome: 'expired', op: viewTransfer(db, getById(db, row.id)) }
    }
    if (row.status !== 'pending' && row.status !== 'needs_verification') {
      return { outcome: row.status, op: viewTransfer(db, row) }
    }

    db.prepare(`UPDATE transfer_operations SET status = 'cancelled' WHERE id = ? AND status IN ('pending','needs_verification')`).run(row.id)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'transfer', ?, 'cancel', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ amount_cents: row.amount_cents }))
    return { outcome: 'cancelled', op: viewTransfer(db, getById(db, row.id)) }
  })
  return run()
}
