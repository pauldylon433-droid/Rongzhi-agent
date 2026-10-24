// 业务活动聚合（只读）：把转账 / 银行卡 / 订阅 / 跨场景任务四类真实业务记录合并为一条时间线，
// 供「最近任务」统一列表展示。事实来源为原业务表（transfer_operations / card_operations /
// subscription_operations / agent_tasks），不拼接聊天 toolRecords、不生成新记录、不猜测会话关联。
//
// 关联去重：跨场景任务通过 selectSubscription 生成的关联订阅操作单（agent_tasks.op_ref 指向的
// subscription_operations.ref_no）不重复列在「订阅操作」里，避免用户误以为同一暂停被执行了两次。
// 独立的订阅操作（不经任务模板）正常列出。
import { listRecentTasks } from './agent-tasks.js'

const KIND_ORDER = { transfer: 0, card_op: 1, subscription_op: 2, repayment: 3, task: 4 }

function toEpochMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

function toIso(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

// 任务对象（订阅商户）：完成时取 result_summary，否则取 selected_subscription 快照。
function taskMerchant(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  return (rs && rs.merchant) || (sel && sel.merchant) || ''
}
function taskAmount(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  if (rs && Number.isInteger(rs.amount_cents)) return rs.amount_cents
  if (sel && Number.isInteger(sel.amount_cents)) return sel.amount_cents
  return null
}
function taskCycle(t) {
  const rs = t && t.result_summary
  const sel = t && t.selected_subscription
  return (rs && rs.billing_cycle) || (sel && sel.billing_cycle) || null
}

// status 归一化为数组：支持单个状态或逗号分隔的多个状态（如「待确认」= pending,waiting_confirmation，
// 独立操作单 pending 与跨场景任务 waiting_confirmation 语义同属「等待界面确认」）。
function normalizeStatus(status) {
  if (!status) return null
  const list = Array.isArray(status) ? status : String(status).split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : null
}

// 列表记录统一形状（轻量，供列表 / 只读详情展示）：
// key（type+编号唯一）、kind、ref_no / task_no、status、action、object、amount_cents、
// billing_cycle、month、op_ref、created_at / updated_at / completed_at（均为 UTC ISO 或 null）。
export function listActivity(db, userId, { type, status, limit = 50, offset = 0 } = {}) {
  const rows = []

  // 转账操作单
  db.prepare(
    `SELECT ref_no, recipient_name, amount_cents, status, created_at, confirmed_at
       FROM transfer_operations WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .all(userId)
    .forEach((r) => {
      const createdMs = toEpochMs(r.created_at)
      rows.push({
        key: `transfer:${r.ref_no}`, kind: 'transfer', ref_no: r.ref_no, task_no: null,
        status: r.status, action: null, object: r.recipient_name,
        amount_cents: r.amount_cents, billing_cycle: null, month: null, op_ref: null,
        created_at: r.created_at, created_ms: createdMs,
        completed_at: toIso(r.confirmed_at), updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    })

  // 银行卡操作单（无 session_id 列，按 user_id 归属查询，兼容历史记录）
  db.prepare(
    `SELECT ref_no, card_masked, action, status, created_at, confirmed_at
       FROM card_operations WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .all(userId)
    .forEach((r) => {
      const createdMs = toEpochMs(r.created_at)
      rows.push({
        key: `card_op:${r.ref_no}`, kind: 'card_op', ref_no: r.ref_no, task_no: null,
        status: r.status, action: r.action, object: r.card_masked,
        amount_cents: null, billing_cycle: null, month: null, op_ref: null,
        created_at: r.created_at, created_ms: createdMs,
        completed_at: toIso(r.confirmed_at), updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    })

  // 订阅操作单（无 session_id 列）：排除跨场景任务的关联子操作单，避免与任务重复计数。
  db.prepare(
    `SELECT ref_no, merchant, amount_cents, billing_cycle, action, status, created_at, confirmed_at
       FROM subscription_operations
      WHERE user_id = ?
        AND ref_no NOT IN (SELECT op_ref FROM agent_tasks WHERE user_id = ? AND op_ref IS NOT NULL)
      ORDER BY created_at DESC, id DESC`,
  )
    .all(userId, userId)
    .forEach((r) => {
      const createdMs = toEpochMs(r.created_at)
      rows.push({
        key: `subscription_op:${r.ref_no}`, kind: 'subscription_op', ref_no: r.ref_no, task_no: null,
        status: r.status, action: r.action, object: r.merchant,
        amount_cents: r.amount_cents, billing_cycle: r.billing_cycle, month: null, op_ref: null,
        created_at: r.created_at, created_ms: createdMs,
        completed_at: toIso(r.confirmed_at), updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    })

  // 信用卡还款操作单
  db.prepare(
    `SELECT ref_no, credit_account_name, statement_month, amount_cents, status, created_at, confirmed_at
       FROM repayment_operations WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .all(userId)
    .forEach((r) => {
      const createdMs = toEpochMs(r.created_at)
      rows.push({
        key: `repayment:${r.ref_no}`, kind: 'repayment', ref_no: r.ref_no, task_no: null,
        status: r.status, action: 'repay', object: `${r.credit_account_name} · ${r.statement_month}`,
        amount_cents: r.amount_cents, billing_cycle: null, month: r.statement_month || null, op_ref: null,
        created_at: r.created_at, created_ms: createdMs,
        completed_at: toIso(r.confirmed_at), updated_at: toIso(r.confirmed_at) || r.created_at,
      })
    })

  // 跨场景任务：复用 listRecentTasks 的「对账 + 视图」以取得真实状态，仅取轻量字段。
  for (const t of listRecentTasks(db, userId, 1000)) {
    const createdMs = toEpochMs(t.created_at)
    rows.push({
      key: `task:${t.task_no}`, kind: 'task', ref_no: null, task_no: t.task_no,
      status: t.status, action: null, object: taskMerchant(t),
      amount_cents: taskAmount(t), billing_cycle: taskCycle(t), month: t.month || null,
      op_ref: t.op_ref || null,
      created_at: toIso(t.created_at), created_ms: createdMs,
      completed_at: toIso(t.completed_at), updated_at: toIso(t.updated_at),
    })
  }

  const statusList = normalizeStatus(status)
  let filtered = rows
  if (type) filtered = filtered.filter((r) => r.kind === type)
  if (statusList) filtered = filtered.filter((r) => statusList.includes(r.status))

  // 创建时间倒序，稳定 tie-break（kind 固定顺序 + 编号），保证分页稳定
  filtered.sort((a, b) => {
    if (a.created_ms !== b.created_ms) return b.created_ms - a.created_ms
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    const ak = a.task_no || a.ref_no || ''
    const bk = b.task_no || b.ref_no || ''
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })

  const total = filtered.length
  const page = filtered.slice(offset, offset + limit).map(({ created_ms, ...rest }) => rest)
  return { rows: page, total }
}
