// 银行卡操作服务：查询 → 临时冻结（yellow，点击确认）→ 解冻（red，交易密码 + TOTP 强验证）。
// 本阶段仅改变卡片状态（active ↔ frozen），不触碰余额、交易流水、订阅或日限额。
// 冻结 / 解冻是「操作单」流程：创建操作单不改变卡片状态，用户确认 / 强验证后才执行。
// 采用「建单时卡片版本快照 + 确认时版本 CAS」的乐观锁，防止建单后卡片状态已变化时旧单覆盖新状态。
// 操作编号 / 待办引用 / 取消逻辑与转账（transfer_operations）完全独立，互不影响。
import { randomUUID } from 'node:crypto'

export const CARD_OP_EXPIRY_MS = 5 * 60 * 1000 // 操作单确认有效期：5 分钟

const OPERATION_COLS = `
  id, ref_no, user_id, card_id, card_masked, card_type, action, from_status, to_status,
  card_version, risk_level, status, created_at, expires_at, confirmed_at
`

// 创建期校验失败（→ HTTP 400）
export class CardOpError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'CardOpError'
    this.code = code
  }
}

function getById(db, id) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM card_operations WHERE id = ?`).get(id)
}

// 卡片当前状态（供前端展示最新卡片状态；不含版本等内部字段）
function cardStatus(db, cardId) {
  return db
    .prepare('SELECT id, masked_card_number, card_type, status, daily_limit_cents FROM cards WHERE id = ?')
    .get(cardId)
}

function toView(db, row) {
  return {
    ref_no: row.ref_no,
    card_id: row.card_id,
    masked_card_number: row.card_masked,
    card_type: row.card_type,
    action: row.action,
    from_status: row.from_status,
    to_status: row.to_status,
    risk_level: row.risk_level,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
    card: cardStatus(db, row.card_id),
  }
}

// —— 供强验证服务（verification.js）复用的读取 / 视图 / 执行核心 ——

export function getCardOpRow(db, refNo) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM card_operations WHERE ref_no = ?`).get(refNo)
}

export function viewCardOperation(db, row) {
  return toView(db, row)
}

// 卡片操作执行核心：归属/版本校验 + 状态 CAS 认领操作单 + 更新卡片状态（版本自增）+ 审计。
// 黄色确认（expectedStatus='pending'）与红色强验证（'needs_verification'）复用同一套执行逻辑。
// 前置：归属、到期、终态（以及红色验证码）均已在校验通过后调用。
// outcome：'completed'（含幂等）、'failed'（卡片不存在）、'stale'（建单后卡片已变化）、'already'（已处于目标状态）。
export function finalizeCardOperation(db, userId, row, now, expectedStatus) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(row.card_id, userId)
  if (!card) {
    db.prepare(`UPDATE card_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'failed', op: viewCardOperation(db, getById(db, row.id)) }
  }

  // 建单后卡片状态 / 版本已变化（含「正常→冻结→正常」回环）：旧单不能覆盖新状态
  if (card.version !== row.card_version) {
    db.prepare(`UPDATE card_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'stale', op: viewCardOperation(db, getById(db, row.id)) }
  }
  // 卡片已处于目标状态：如实处理，不伪造一次新成功（正常流程建单时已拦截，此处为防御）
  if (card.status === row.to_status) {
    db.prepare(`UPDATE card_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'already', op: viewCardOperation(db, getById(db, row.id)) }
  }

  // 原子认领（CAS）：仅目标状态 → completed，防重复 / 并发执行
  const claim = db
    .prepare(`UPDATE card_operations SET status = 'completed', confirmed_at = ? WHERE id = ? AND status = ?`)
    .run(now.toISOString(), row.id, expectedStatus)
  if (claim.changes !== 1) {
    return { outcome: 'completed', op: viewCardOperation(db, getById(db, row.id)) } // 幂等
  }

  // 更新卡片状态 + 版本自增（version 守卫，异常则回滚整个事务含操作单认领）
  const upd = db
    .prepare('UPDATE cards SET status = ?, version = version + 1 WHERE id = ? AND version = ?')
    .run(row.to_status, row.card_id, row.card_version)
  if (upd.changes !== 1) throw new Error('卡片状态已变化，执行失败')

  db.prepare(
    `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
     VALUES (?, 'card_operation', ?, 'confirm', 'success', ?)`,
  ).run(
    userId,
    row.ref_no,
    JSON.stringify({ action: row.action, card_id: row.card_id, from: row.from_status, to: row.to_status }),
  )

  // 完成同步（与转账一致）：清除发起该单的会话「待确认」引用，避免会话保留已完成的旧「待确认」上下文。
  // 银行卡操作单无 session_id 列，按引用号反向清除（操作单 ref 全局唯一，属单一会话，无歧义）。
  db.prepare('UPDATE chat_sessions SET pending_card_op_ref = NULL WHERE pending_card_op_ref = ?').run(row.ref_no)

  return { outcome: 'completed', op: viewCardOperation(db, getById(db, row.id)) }
}

// 创建银行卡操作单（不改变卡片状态）。action：freeze（冻结）/ unfreeze（解冻）。
// 服务端校验卡片归属与合法状态转换：冻结 active→frozen；解冻 frozen→active；注销等状态不能操作。
export function createCardOperation(db, userId, { cardId, action }, now = new Date()) {
  if (action !== 'freeze' && action !== 'unfreeze') {
    throw new CardOpError('不支持的卡片操作（仅支持 freeze / unfreeze）', 'bad_action')
  }
  if (typeof cardId !== 'number' || !Number.isSafeInteger(cardId) || cardId <= 0) {
    throw new CardOpError('卡片不合法', 'bad_card')
  }
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId)
  if (!card) {
    throw new CardOpError('未找到该银行卡', 'not_found')
  }

  const fromStatus = action === 'freeze' ? 'active' : 'frozen'
  const toStatus = action === 'freeze' ? 'frozen' : 'active'

  if (card.status === 'cancelled') {
    throw new CardOpError(action === 'freeze' ? '该卡已注销，不能冻结' : '该卡已注销，不能解冻', 'cancelled')
  }
  if (card.status === toStatus) {
    throw new CardOpError(action === 'freeze' ? '该卡已处于冻结状态，无需重复冻结' : '该卡已是正常状态，无需重复解冻', 'already_in_state')
  }
  if (card.status !== fromStatus) {
    // 未知状态（未来新增状态）不当作正常处理，直接拒绝
    throw new CardOpError('该卡当前状态不支持此操作', 'bad_state')
  }

  const riskLevel = action === 'freeze' ? 'yellow' : 'red'
  const status = action === 'freeze' ? 'pending' : 'needs_verification'
  const refNo = randomUUID()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + CARD_OP_EXPIRY_MS).toISOString()

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO card_operations
          (ref_no, user_id, card_id, card_masked, card_type, action, from_status, to_status,
           card_version, risk_level, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refNo, userId, card.id, card.masked_card_number, card.card_type, action, fromStatus, toStatus,
        card.version, riskLevel, status, createdAt, expiresAt,
      )
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'card_operation', ?, 'create', ?, ?)`,
    ).run(userId, refNo, status, JSON.stringify({ action, card_id: card.id }))
    return getById(db, info.lastInsertRowid)
  })
  return toView(db, run())
}

// 查看操作单（读取时惰性过期，含红色待验证单）
export function getCardOperation(db, userId, refNo, now = new Date()) {
  const row = getCardOpRow(db, refNo)
  if (!row || row.user_id !== userId) return null
  if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
    db.prepare(`UPDATE card_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
    return viewCardOperation(db, getById(db, row.id))
  }
  return viewCardOperation(db, row)
}

// 确认并执行冻结（黄色 pending）。普通确认接口无法执行解冻（unfreeze 是 needs_verification，且额外守卫 action）。
// outcome：'completed'（含幂等）、'not_found'、'expired'、'cancelled'、'failed'、'stale'、'already'、
//          'needs_verification'（解冻单不可普通确认）。
export function confirmCardOperation(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getCardOpRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'pending' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE card_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'expired', op: viewCardOperation(db, getById(db, row.id)) }
    }
    if (row.status === 'completed') return { outcome: 'completed', op: viewCardOperation(db, row) }
    if (row.status !== 'pending') return { outcome: row.status, op: viewCardOperation(db, row) }

    // 普通确认只能执行冻结（yellow pending）；解冻（red）必须走强验证，不能通过普通确认绕过
    if (row.action !== 'freeze') return { outcome: row.status, op: viewCardOperation(db, row) }

    return finalizeCardOperation(db, userId, row, now, 'pending')
  })
  return run()
}

// 取消操作单（不改变卡片状态；含红色待验证单）。
// outcome：'cancelled'、'not_found'、'expired'、'completed'、'failed'。
export function cancelCardOperation(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getCardOpRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'cancelled') return { outcome: 'cancelled', op: viewCardOperation(db, row) }
    if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
      db.prepare(`UPDATE card_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
      return { outcome: 'expired', op: viewCardOperation(db, getById(db, row.id)) }
    }
    if (row.status !== 'pending' && row.status !== 'needs_verification') {
      return { outcome: row.status, op: viewCardOperation(db, row) }
    }

    db.prepare(`UPDATE card_operations SET status = 'cancelled' WHERE id = ? AND status IN ('pending','needs_verification')`).run(row.id)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'card_operation', ?, 'cancel', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ action: row.action, card_id: row.card_id }))
    return { outcome: 'cancelled', op: viewCardOperation(db, getById(db, row.id)) }
  })
  return run()
}
