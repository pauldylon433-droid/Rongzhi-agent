// 订阅与代扣操作服务：查询 → 暂停/取消（yellow，点击确认）→ 恢复（red，交易密码 + TOTP 强验证）。
// 本阶段仅改变本地模拟订阅授权状态（active ↔ paused / cancelled），不代表取消真实商户合同、不实际发起扣费。
// 不改余额、历史流水、金额、周期或原扣费日期。
// 暂停 / 取消 / 恢复是「操作单」流程：创建操作单不改变订阅状态，用户确认 / 强验证后才执行。
// 采用「建单时订阅版本快照 + 确认时版本 CAS」的乐观锁，防止建单后订阅状态已变化时旧单覆盖新状态。
// 操作编号 / 待办引用 / 取消逻辑与转账（transfer_operations）、银行卡（card_operations）完全独立，互不影响。
import { randomUUID } from 'node:crypto'

export const SUB_OP_EXPIRY_MS = 5 * 60 * 1000 // 操作单确认有效期：5 分钟

const OPERATION_COLS = `
  id, ref_no, user_id, subscription_id, merchant, amount_cents, billing_cycle, action,
  from_status, to_status, subscription_version, risk_level, status, created_at, expires_at, confirmed_at
`

// 创建期校验失败（→ HTTP 400）
export class SubscriptionOpError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'SubscriptionOpError'
    this.code = code
  }
}

function getById(db, id) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM subscription_operations WHERE id = ?`).get(id)
}

// 订阅当前状态（供前端展示最新订阅状态；不含版本等内部字段）
function subscriptionStatus(db, subscriptionId) {
  return db
    .prepare('SELECT id, merchant, amount_cents, billing_cycle, next_billing_date, status FROM subscriptions WHERE id = ?')
    .get(subscriptionId)
}

function toView(db, row) {
  return {
    ref_no: row.ref_no,
    subscription_id: row.subscription_id,
    merchant: row.merchant,
    amount_cents: row.amount_cents,
    billing_cycle: row.billing_cycle,
    action: row.action,
    from_status: row.from_status,
    to_status: row.to_status,
    risk_level: row.risk_level,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
    subscription: subscriptionStatus(db, row.subscription_id),
  }
}

// —— 供强验证服务（verification.js）复用的读取 / 视图 / 执行核心 ——

export function getSubscriptionOpRow(db, refNo) {
  return db.prepare(`SELECT ${OPERATION_COLS} FROM subscription_operations WHERE ref_no = ?`).get(refNo)
}

export function viewSubscriptionOperation(db, row) {
  return toView(db, row)
}

// 订阅操作执行核心：归属/版本校验 + 状态 CAS 认领操作单 + 更新订阅状态（版本自增）+ 审计。
// 黄色确认（expectedStatus='pending'）与红色强验证（'needs_verification'）复用同一套执行逻辑。
// 前置：归属、到期、终态（以及红色验证码）均已在校验通过后调用。
// outcome：'completed'（含幂等）、'failed'（订阅不存在）、'stale'（建单后订阅已变化）、'already'（已处于目标状态）。
export function finalizeSubscriptionOperation(db, userId, row, now, expectedStatus) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').get(row.subscription_id, userId)
  if (!sub) {
    db.prepare(`UPDATE subscription_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'failed', op: viewSubscriptionOperation(db, getById(db, row.id)) }
  }

  // 建单后订阅状态 / 版本已变化（含「生效→暂停→生效」回环）：旧单不能覆盖新状态
  if (sub.version !== row.subscription_version) {
    db.prepare(`UPDATE subscription_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'stale', op: viewSubscriptionOperation(db, getById(db, row.id)) }
  }
  // 订阅已处于目标状态：如实处理，不伪造一次新成功（正常流程建单时已拦截，此处为防御）
  if (sub.status === row.to_status) {
    db.prepare(`UPDATE subscription_operations SET status = 'failed' WHERE id = ? AND status = ?`).run(row.id, expectedStatus)
    return { outcome: 'already', op: viewSubscriptionOperation(db, getById(db, row.id)) }
  }

  // 原子认领（CAS）：仅目标状态 → completed，防重复 / 并发执行
  const claim = db
    .prepare(`UPDATE subscription_operations SET status = 'completed', confirmed_at = ? WHERE id = ? AND status = ?`)
    .run(now.toISOString(), row.id, expectedStatus)
  if (claim.changes !== 1) {
    return { outcome: 'completed', op: viewSubscriptionOperation(db, getById(db, row.id)) } // 幂等
  }

  // 更新订阅状态 + 版本自增（version 守卫，异常则回滚整个事务含操作单认领）
  const upd = db
    .prepare('UPDATE subscriptions SET status = ?, version = version + 1 WHERE id = ? AND version = ?')
    .run(row.to_status, row.subscription_id, row.subscription_version)
  if (upd.changes !== 1) throw new Error('订阅状态已变化，执行失败')

  db.prepare(
    `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
     VALUES (?, 'subscription_operation', ?, 'confirm', 'success', ?)`,
  ).run(
    userId,
    row.ref_no,
    JSON.stringify({ action: row.action, subscription_id: row.subscription_id, from: row.from_status, to: row.to_status }),
  )

  return { outcome: 'completed', op: viewSubscriptionOperation(db, getById(db, row.id)) }
}

// 创建订阅操作单（不改变订阅状态）。action：pause（暂停）/ resume（恢复）/ cancel（取消）。
// 服务端校验订阅归属与合法状态转换；风险级别由后端判定；cancelled 为终态不可再操作，未知状态拒绝。
export function createSubscriptionOperation(db, userId, { subscriptionId, action }, now = new Date()) {
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    throw new SubscriptionOpError('不支持的订阅操作（仅支持 pause / resume / cancel）', 'bad_action')
  }
  if (typeof subscriptionId !== 'number' || !Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
    throw new SubscriptionOpError('订阅不合法', 'bad_subscription')
  }
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').get(subscriptionId, userId)
  if (!sub) {
    throw new SubscriptionOpError('未找到该订阅', 'not_found')
  }

  let fromStatus
  let toStatus
  if (action === 'cancel') {
    // 取消：active 或 paused → cancelled（黄色确认）；cancelled 为终态，未知状态拒绝
    if (sub.status === 'cancelled') {
      throw new SubscriptionOpError('该订阅已取消，不能再次取消', 'already_cancelled')
    }
    if (sub.status !== 'active' && sub.status !== 'paused') {
      throw new SubscriptionOpError('该订阅当前状态不支持取消', 'bad_state')
    }
    fromStatus = sub.status
    toStatus = 'cancelled'
  } else {
    fromStatus = action === 'pause' ? 'active' : 'paused'
    toStatus = action === 'pause' ? 'paused' : 'active'
    if (sub.status === 'cancelled') {
      throw new SubscriptionOpError(action === 'pause' ? '该订阅已取消，不能暂停' : '该订阅已取消，不能恢复', 'cancelled')
    }
    if (sub.status === toStatus) {
      throw new SubscriptionOpError(
        action === 'pause' ? '该订阅已处于暂停状态，无需重复暂停' : '该订阅已是生效状态，无需重复恢复',
        'already_in_state',
      )
    }
    if (sub.status !== fromStatus) {
      // 未知状态（未来新增状态）不当作正常处理，直接拒绝
      throw new SubscriptionOpError('该订阅当前状态不支持此操作', 'bad_state')
    }
  }

  const riskLevel = action === 'resume' ? 'red' : 'yellow'
  const status = action === 'resume' ? 'needs_verification' : 'pending'
  const refNo = randomUUID()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + SUB_OP_EXPIRY_MS).toISOString()

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO subscription_operations
          (ref_no, user_id, subscription_id, merchant, amount_cents, billing_cycle, action,
           from_status, to_status, subscription_version, risk_level, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refNo, userId, sub.id, sub.merchant, sub.amount_cents, sub.billing_cycle, action,
        fromStatus, toStatus, sub.version, riskLevel, status, createdAt, expiresAt,
      )
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'subscription_operation', ?, 'create', ?, ?)`,
    ).run(userId, refNo, status, JSON.stringify({ action, subscription_id: sub.id }))
    return getById(db, info.lastInsertRowid)
  })
  return toView(db, run())
}

// 查看操作单（读取时惰性过期，含红色待验证单）
export function getSubscriptionOperation(db, userId, refNo, now = new Date()) {
  const row = getSubscriptionOpRow(db, refNo)
  if (!row || row.user_id !== userId) return null
  if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
    db.prepare(`UPDATE subscription_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
    return viewSubscriptionOperation(db, getById(db, row.id))
  }
  return viewSubscriptionOperation(db, row)
}

// 确认并执行暂停 / 取消（黄色 pending）。普通确认接口无法执行恢复（resume 是 needs_verification，且额外守卫 action）。
// outcome：'completed'（含幂等）、'not_found'、'expired'、'cancelled'、'failed'、'stale'、'already'、
//          'needs_verification'（恢复单不可普通确认）。
export function confirmSubscriptionOperation(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getSubscriptionOpRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'pending' && now.toISOString() > row.expires_at) {
      db.prepare("UPDATE subscription_operations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id)
      return { outcome: 'expired', op: viewSubscriptionOperation(db, getById(db, row.id)) }
    }
    if (row.status === 'completed') return { outcome: 'completed', op: viewSubscriptionOperation(db, row) }
    if (row.status !== 'pending') return { outcome: row.status, op: viewSubscriptionOperation(db, row) }

    // 普通确认只能执行暂停 / 取消（yellow pending）；恢复（red）必须走强验证，不能通过普通确认绕过
    if (row.action === 'resume') return { outcome: row.status, op: viewSubscriptionOperation(db, row) }

    return finalizeSubscriptionOperation(db, userId, row, now, 'pending')
  })
  return run()
}

// 取消操作单（不改变订阅状态；含红色待验证单）。
// outcome：'cancelled'、'not_found'、'expired'、'completed'、'failed'。
export function cancelSubscriptionOperation(db, userId, refNo, now = new Date()) {
  const run = db.transaction(() => {
    const row = getSubscriptionOpRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'cancelled') return { outcome: 'cancelled', op: viewSubscriptionOperation(db, row) }
    if ((row.status === 'pending' || row.status === 'needs_verification') && now.toISOString() > row.expires_at) {
      db.prepare(`UPDATE subscription_operations SET status = 'expired' WHERE id = ? AND status = ?`).run(row.id, row.status)
      return { outcome: 'expired', op: viewSubscriptionOperation(db, getById(db, row.id)) }
    }
    if (row.status !== 'pending' && row.status !== 'needs_verification') {
      return { outcome: row.status, op: viewSubscriptionOperation(db, row) }
    }

    db.prepare(`UPDATE subscription_operations SET status = 'cancelled' WHERE id = ? AND status IN ('pending','needs_verification')`).run(row.id)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'subscription_operation', ?, 'cancel', 'success', ?)`,
    ).run(userId, row.ref_no, JSON.stringify({ action: row.action, subscription_id: row.subscription_id }))
    return { outcome: 'cancelled', op: viewSubscriptionOperation(db, getById(db, row.id)) }
  })
  return run()
}
