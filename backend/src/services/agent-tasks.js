// 跨场景任务模板服务：当前仅支持一条完整任务链——
// 「分析某月支出 → 列出生效订阅 → 用户选择 → 准备暂停单 → 界面确认 → 核验执行结果 → 汇总回执」。
//
// 安全边界：
// - 模型只负责理解意图与提取月份；服务端用白名单节点构建任务图并校验依赖，
//   不执行模型生成的任意代码 / URL / SQL / 操作步骤。
// - 只读节点自动执行；变更（暂停订阅）复用现有订阅操作单确认接口，不得代用户选择或执行。
// - 任务、节点、依赖、状态、结果摘要与业务单引用全部持久化 SQLite，刷新 / 后端重启可恢复；
//   恢复不重发模型请求、不自动重发业务操作。
import { randomUUID } from 'node:crypto'
import { monthlyAnalytics } from './analytics.js'
import { listSubscriptions } from './subscriptions.js'
import {
  createSubscriptionOperation, getSubscriptionOperation, cancelSubscriptionOperation, SubscriptionOpError,
} from './subscription-operations.js'
import { parseMonth } from '../routes/helpers.js'

// 唯一支持的跨场景任务类型
export const TASK_KIND = 'subscription_review'

// 节点白名单（顺序即执行顺序）。dependsOn 引用同白名单内的节点 key。
// type: readonly（自动执行）/ selection（等待用户选择）/ mutation（生成操作单，需确认）/ confirmation（等待界面确认）/
//       verify（只读核验）/ summary（只读汇总）。
const NODE_DEFS = [
  { key: 'monthly_analysis', label: '月度支出分析', type: 'readonly', dependsOn: [] },
  { key: 'subscription_query', label: '生效订阅查询', type: 'readonly', dependsOn: [] },
  { key: 'await_selection', label: '等待选择订阅', type: 'selection', dependsOn: ['monthly_analysis', 'subscription_query'] },
  { key: 'prepare_pause', label: '准备暂停单', type: 'mutation', dependsOn: ['await_selection'] },
  { key: 'await_confirmation', label: '等待界面确认', type: 'confirmation', dependsOn: ['prepare_pause'] },
  { key: 'verify_result', label: '核验执行结果', type: 'verify', dependsOn: ['await_confirmation'] },
  { key: 'summary', label: '汇总回执', type: 'summary', dependsOn: ['verify_result'] },
]

// 校验白名单任务图：key 唯一、依赖存在、无环、顺序连续。服务端构建时校验，不信任任何外部图描述。
function validateGraph() {
  const keys = NODE_DEFS.map((n) => n.key)
  if (new Set(keys).size !== keys.length) throw new Error('任务图节点 key 重复')
  const byKey = new Map(NODE_DEFS.map((n) => [n.key, n]))
  for (const n of NODE_DEFS) {
    for (const d of n.dependsOn) {
      if (!byKey.has(d)) throw new Error(`任务图依赖不存在：${n.key} -> ${d}`)
    }
  }
  // 拓扑排序检测环
  const indeg = new Map(NODE_DEFS.map((n) => [n.key, 0]))
  for (const n of NODE_DEFS) for (const d of n.dependsOn) indeg.set(n.key, indeg.get(n.key) + 1)
  const queue = NODE_DEFS.filter((n) => indeg.get(n.key) === 0).map((n) => n.key)
  let seen = 0
  while (queue.length) {
    const k = queue.shift()
    seen += 1
    for (const n of NODE_DEFS) {
      if (!n.dependsOn.includes(k)) continue
      const next = indeg.get(n.key) - 1
      indeg.set(n.key, next)
      if (next === 0) queue.push(n.key)
    }
  }
  if (seen !== NODE_DEFS.length) throw new Error('任务图存在循环依赖')
}
validateGraph()

export class AgentTaskError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'AgentTaskError'
    this.code = code
  }
}

const TASK_COLS = `
  id, task_no, user_id, kind, status, month, session_id, selected_subscription_id,
  op_ref, result_summary, failure_reason, created_at, updated_at, completed_at
`

function taskById(db, id) {
  return db.prepare(`SELECT ${TASK_COLS} FROM agent_tasks WHERE id = ?`).get(id)
}
function taskByNo(db, taskNo) {
  return db.prepare(`SELECT ${TASK_COLS} FROM agent_tasks WHERE task_no = ?`).get(taskNo)
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function nodeLabel(key) {
  return (NODE_DEFS.find((n) => n.key === key) || {}).label || key
}

function getNode(db, taskId, key) {
  return db.prepare('SELECT * FROM agent_task_nodes WHERE task_id = ? AND node_key = ?').get(taskId, key)
}

function setNode(db, taskId, key, status, { result, error, now } = {}) {
  db.prepare(
    `UPDATE agent_task_nodes
       SET status = ?, result_json = ?, error = ?, completed_at = ?
     WHERE task_id = ? AND node_key = ?`,
  ).run(status, result != null ? JSON.stringify(result) : null, error || null, status === 'completed' ? now : null, taskId, key)
}

// 当前订阅视图（真实状态，供前端展示）
function subscriptionView(db, userId, subscriptionId) {
  if (!subscriptionId) return null
  return (
    db
      .prepare('SELECT id, merchant, amount_cents, billing_cycle, next_billing_date, status FROM subscriptions WHERE id = ? AND user_id = ?')
      .get(subscriptionId, userId) || null
  )
}

// 任务视图：节点状态 + 当前真实订阅 / 操作单状态（以数据库为准），供前端渲染与继续。
function viewTask(db, userId, row, now) {
  if (!row) return null
  const nodes = db
    .prepare('SELECT node_key, status, result_json, error FROM agent_task_nodes WHERE task_id = ? ORDER BY seq ASC')
    .all(row.id)
    .map((n) => ({
      node_key: n.node_key,
      label: nodeLabel(n.node_key),
      status: n.status,
      result: parseJson(n.result_json, null),
      error: n.error || '',
    }))

  const op = row.op_ref ? getSubscriptionOperation(db, userId, row.op_ref, new Date(now)) : null
  return {
    task_no: row.task_no,
    kind: row.kind,
    status: row.status,
    month: row.month,
    session_id: row.session_id, // 发起该任务的助手会话（前端据此把任务绑定到当前对话）
    selected_subscription_id: row.selected_subscription_id,
    selected_subscription: subscriptionView(db, userId, row.selected_subscription_id),
    op_ref: row.op_ref,
    op,
    selectable_subscriptions: listSubscriptions(db, userId).filter((s) => s.status === 'active'),
    result_summary: parseJson(row.result_summary, null),
    failure_reason: row.failure_reason || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    nodes,
  }
}

// 只读节点自动执行（幂等：仅补执行未完成者）。月度分析与订阅查询复用原始统计 / 查询函数。
function runReadonlyNodes(db, userId, task, now) {
  const iso = new Date(now).toISOString()
  const mNode = getNode(db, task.id, 'monthly_analysis')
  if (mNode && mNode.status === 'pending') {
    const parsed = parseMonth(task.month)
    const result = monthlyAnalytics(db, userId, { ...parsed, asOf: iso })
    setNode(db, task.id, 'monthly_analysis', 'completed', { result, now })
  }
  const sNode = getNode(db, task.id, 'subscription_query')
  if (sNode && sNode.status === 'pending') {
    const active = listSubscriptions(db, userId).filter((s) => s.status === 'active')
    setNode(db, task.id, 'subscription_query', 'completed', {
      result: { month: task.month, as_of: iso, active_subscriptions: active, count: active.length },
      now,
    })
  }
}

// 汇总回执：以月度分析快照 + 选定订阅 + 操作单真实状态为准，不编造「长期未使用」或「节省金额」。
function buildSummary(db, userId, task, now) {
  const mNode = getNode(db, task.id, 'monthly_analysis')
  const monthly = mNode && mNode.result_json ? parseJson(mNode.result_json, null) : null
  const sub = subscriptionView(db, userId, task.selected_subscription_id)
  const op = task.op_ref ? getSubscriptionOperation(db, userId, task.op_ref, new Date(now)) : null
  return {
    month: task.month,
    expense_cents: monthly ? monthly.expense_cents : null,
    posted_count: monthly ? monthly.posted_count : null,
    analyzed_as_of: monthly ? monthly.as_of : null,
    action: 'pause',
    merchant: sub ? sub.merchant : null,
    amount_cents: sub ? sub.amount_cents : null,
    billing_cycle: sub ? sub.billing_cycle : null,
    subscription_status: sub ? sub.status : null,
    op_ref: task.op_ref,
    op_status: op ? op.status : null,
    confirmed_at: op ? op.confirmed_at : null,
    note: '暂停成功不等于已退款或已实现某金额的节省；不同扣费周期不能直接相加成月度费用。',
    as_of: new Date(now).toISOString(),
  }
}

// 回到「等待选择」：清除选定订阅与操作单引用，重置交互 / 终态节点（只读节点保留）。
function resetToSelection(db, task, now) {
  db.prepare(
    `UPDATE agent_task_nodes SET status = 'pending', result_json = NULL, error = NULL, completed_at = NULL
      WHERE task_id = ? AND node_key IN ('await_selection','prepare_pause','await_confirmation','verify_result','summary')`,
  ).run(task.id)
  db.prepare(
    `UPDATE agent_tasks SET status = 'waiting_selection', selected_subscription_id = NULL, op_ref = NULL,
       failure_reason = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, task.id)
}

// 标记任务失败（不反向任何已发生的业务变更）
function failTask(db, task, now, reason) {
  db.prepare(
    `UPDATE agent_tasks SET status = 'failed', failure_reason = ?, completed_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(reason, now, task.id)
}

// 标记任务完成（写入汇总回执）
function completeTask(db, task, now, summary) {
  db.prepare(
    `UPDATE agent_tasks SET status = 'completed', result_summary = ?, failure_reason = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(summary), now, now, task.id)
}

// 对账 / 前进：只读推进（核验结果、汇总）与失败 / 取消 / 过期检测，绝不重发模型请求、绝不重发业务操作。
// 在 GET（刷新 / 重启恢复）与确认后由前端触发；等待态保持不动。
function reconcile(db, userId, task, now) {
  // 终态与暂停态不自动推进
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'manual' || task.status === 'paused') {
    return
  }
  if (task.status === 'failed') return

  if (task.status === 'waiting_selection') {
    runReadonlyNodes(db, userId, task, now)
    return
  }

  if (task.status === 'waiting_confirmation') {
    const op = task.op_ref ? getSubscriptionOperation(db, userId, task.op_ref, new Date(now)) : null
    if (!op) {
      setNode(db, task.id, 'verify_result', 'failed', { error: '操作单不存在', now })
      failTask(db, task, now, '关联操作单不存在，任务终止')
      return
    }
    if (op.status === 'completed') {
      // 核验业务数据库：订阅确实已处于「暂停」态，模型回复 / 界面文案不决定完成。
      const sub = subscriptionView(db, userId, task.selected_subscription_id)
      if (!sub || sub.status !== 'paused') {
        setNode(db, task.id, 'verify_result', 'failed', { error: '订阅状态与操作单不一致', now })
        failTask(db, task, now, '订阅状态与操作单不一致，任务终止')
        return
      }
      setNode(db, task.id, 'await_confirmation', 'completed', { result: { ref_no: op.ref_no, status: op.status }, now })
      setNode(db, task.id, 'verify_result', 'completed', { result: { ref_no: op.ref_no, subscription_status: sub.status }, now })
      const summary = buildSummary(db, userId, task, now)
      setNode(db, task.id, 'summary', 'completed', { result: summary, now })
      completeTask(db, task, now, summary)
      return
    }
    if (op.status === 'cancelled' || op.status === 'expired') {
      // 变更从未发生：回到等待选择，允许重新选择（不伪造「已取消」业务结果）
      resetToSelection(db, task, now)
      return
    }
    if (op.status === 'failed') {
      setNode(db, task.id, 'verify_result', 'failed', { error: '操作单失效（订阅状态已变化或已处于目标状态）', now })
      failTask(db, task, now, '暂停操作单失效：订阅状态已变化或已处于目标状态，未执行')
      return
    }
    // pending / needs_verification：仍在等待界面确认，保持不动
    return
  }
}

// —— 对外接口 ——

// 创建任务（模型工具调用入口）：构建白名单任务图 + 节点，自动执行只读节点，落到「等待选择」。
export function createTask(db, userId, { month, sessionId = null }, now = Date.now()) {
  const parsed = parseMonth(month)
  if (!parsed) throw new AgentTaskError('月份格式应为 YYYY-MM（月份 01-12）', 'bad_month')

  const taskNo = `task-${randomUUID()}`
  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO agent_tasks (task_no, user_id, kind, status, month, session_id, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting_selection', ?, ?, ?, ?)`,
      )
      .run(taskNo, userId, TASK_KIND, month, sessionId, now, now)
    const taskId = info.lastInsertRowid
    const insNode = db.prepare(
      `INSERT INTO agent_task_nodes (task_id, node_key, seq, status, depends_on) VALUES (?, ?, ?, 'pending', ?)`,
    )
    NODE_DEFS.forEach((n, i) => insNode.run(taskId, n.key, i, JSON.stringify(n.dependsOn)))
    return taskId
  })

  const taskId = run()
  const task = taskById(db, taskId)
  runReadonlyNodes(db, userId, task, now)
  return viewTask(db, userId, taskByNo(db, taskNo), now)
}

// 用户选择订阅：等待选择 → 校验订阅归属与生效状态 → 生成暂停操作单（不执行）→ 等待界面确认。
export function selectSubscription(db, userId, taskNo, subscriptionId, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return { outcome: 'not_found' }
  if (task.status !== 'waiting_selection') return { outcome: 'bad_state', task: viewTask(db, userId, task, now) }

  if (typeof subscriptionId !== 'number' || !Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
    throw new AgentTaskError('subscription_id 必须为正整数', 'bad_subscription')
  }
  // 归属 + 生效状态由服务端校验（不信任快照，重新读业务库）
  const sub = db
    .prepare('SELECT id, status FROM subscriptions WHERE id = ? AND user_id = ?')
    .get(subscriptionId, userId)
  if (!sub) throw new AgentTaskError('未找到该订阅', 'not_found')
  if (sub.status !== 'active') throw new AgentTaskError('该订阅当前不是生效状态，不能暂停', 'not_active')

  // 生成暂停操作单（不改变订阅状态）；失败则任务失败并如实说明
  let op
  try {
    op = createSubscriptionOperation(db, userId, { subscriptionId: sub.id, action: 'pause' }, new Date(now))
  } catch (e) {
    if (e instanceof SubscriptionOpError) {
      setNode(db, task.id, 'prepare_pause', 'failed', { error: e.message, now })
      failTask(db, task, now, `准备暂停单失败：${e.message}`)
      return { outcome: 'failed', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
    }
    throw e
  }

  // 记录选择 + 完成准备节点 + 落到等待确认（单事务；不嵌套到 createSubscriptionOperation 的事务）
  db.transaction(() => {
    setNode(db, task.id, 'await_selection', 'completed', { result: { subscription_id: sub.id, merchant: op.merchant }, now })
    setNode(db, task.id, 'prepare_pause', 'completed', { result: { ref_no: op.ref_no }, now })
    db.prepare(
      `UPDATE agent_tasks SET status = 'waiting_confirmation', selected_subscription_id = ?, op_ref = ?, failure_reason = NULL, updated_at = ? WHERE id = ?`,
    ).run(sub.id, op.ref_no, now, task.id)
  })()

  return { outcome: 'selected', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
}

// 读取任务（刷新 / 重启恢复）：先对账再返回；不重发模型请求、不重发业务操作。
export function getTask(db, userId, taskNo, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return null
  reconcile(db, userId, task, now)
  return viewTask(db, userId, taskByNo(db, taskNo), now)
}

// 最近任务（轻量入口）：按更新时间倒序；对账后返回真实状态。
export function listRecentTasks(db, userId, limit = 20, now = Date.now()) {
  const rows = db
    .prepare('SELECT * FROM agent_tasks WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(userId, limit)
  return rows.map((r) => {
    reconcile(db, userId, r, now)
    return viewTask(db, userId, taskByNo(db, r.task_no), now)
  })
}

// 暂停任务：关联的未执行操作单必须在后端也被阻断（取消操作单），不能只隐藏前端按钮。
// 若操作单已完成（确认与取消竞态，事务结果为准），不反向业务变更，转为对账完成。
export function pauseTask(db, userId, taskNo, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return { outcome: 'not_found' }
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'manual') {
    return { outcome: task.status, task: viewTask(db, userId, task, now) }
  }
  if (task.op_ref) {
    const cr = cancelSubscriptionOperation(db, userId, task.op_ref, new Date(now))
    if (cr.outcome === 'completed') {
      // 操作单已确认完成（变更已发生）：不反向，按真实结果对账
      reconcile(db, userId, taskByNo(db, taskNo), now)
      return { outcome: 'completed', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
    }
  }
  db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?').run('paused', now, task.id)
  return { outcome: 'paused', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
}

// 继续任务：重新检查任务、订阅版本与操作单有效期；过期 / 失效单不直接执行，需重新生成并再次确认。
export function resumeTask(db, userId, taskNo, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return { outcome: 'not_found' }
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'manual') {
    return { outcome: task.status, task: viewTask(db, userId, task, now) }
  }
  if (task.status === 'failed') {
    // 失败后安全继续：重新选择（重新校验）
    resetToSelection(db, task, now)
    return { outcome: 'waiting_selection', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
  }
  if (task.status === 'waiting_selection' || task.status === 'waiting_confirmation') {
    reconcile(db, userId, task, now)
    return { outcome: taskByNo(db, taskNo).status, task: viewTask(db, userId, taskByNo(db, taskNo), now) }
  }
  if (task.status === 'paused') {
    if (task.selected_subscription_id != null) {
      // 之前在「等待确认」：重新检查订阅仍为生效后，重新生成操作单并要求再次确认
      const sub = db
        .prepare('SELECT id, status FROM subscriptions WHERE id = ? AND user_id = ?')
        .get(task.selected_subscription_id, userId)
      if (!sub || sub.status !== 'active') {
        resetToSelection(db, task, now)
        return { outcome: 'waiting_selection', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
      }
      let op
      try {
        op = createSubscriptionOperation(db, userId, { subscriptionId: sub.id, action: 'pause' }, new Date(now))
      } catch (e) {
        if (e instanceof SubscriptionOpError) {
          resetToSelection(db, task, now)
          return { outcome: 'waiting_selection', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
        }
        throw e
      }
      db.transaction(() => {
        setNode(db, task.id, 'prepare_pause', 'completed', { result: { ref_no: op.ref_no }, now })
        db.prepare('UPDATE agent_tasks SET status = ?, op_ref = ?, failure_reason = NULL, updated_at = ? WHERE id = ?')
          .run('waiting_confirmation', op.ref_no, now, task.id)
      })()
      return { outcome: 'waiting_confirmation', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
    }
    db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?').run('waiting_selection', now, task.id)
    return { outcome: 'waiting_selection', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
  }
  return { outcome: task.status, task: viewTask(db, userId, task, now) }
}

// 取消任务：关联未执行操作单在后端阻断；已确认的订阅变更不会因取消任务被自动反向操作。
export function cancelTask(db, userId, taskNo, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return { outcome: 'not_found' }
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'manual') {
    return { outcome: task.status, task: viewTask(db, userId, task, now) }
  }
  if (task.op_ref) {
    const cr = cancelSubscriptionOperation(db, userId, task.op_ref, new Date(now))
    if (cr.outcome === 'completed') {
      reconcile(db, userId, taskByNo(db, taskNo), now)
      return { outcome: 'completed', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
    }
  }
  db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', now, task.id)
  return { outcome: 'cancelled', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
}

// 转手动处理：阻断关联未执行操作单；复用已有订阅操作入口，不虚假显示已接通客服。
export function manualTask(db, userId, taskNo, now = Date.now()) {
  const task = taskByNo(db, taskNo)
  if (!task || task.user_id !== userId) return { outcome: 'not_found' }
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'manual') {
    return { outcome: task.status, task: viewTask(db, userId, task, now) }
  }
  if (task.op_ref) cancelSubscriptionOperation(db, userId, task.op_ref, new Date(now))
  db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?').run('manual', now, task.id)
  return { outcome: 'manual', task: viewTask(db, userId, taskByNo(db, taskNo), now) }
}
