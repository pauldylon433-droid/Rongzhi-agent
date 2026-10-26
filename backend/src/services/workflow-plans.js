// 受约束 DAG 计划：两条白名单任务链（订阅审查 / 信用卡还款审查）。
// 模型只提交 flow / 参数 / 可选步骤依赖；服务端验证节点白名单、依赖、无环、步骤上限与参数，
// 再持久化并在关键节点调用既有操作单服务。计划可暂停 / 继续 / 取消 / 重试 / 修改未执行步骤 / 转人工。
// 回退只重置未执行节点，绝不反向已完成扣款；已完成操作只能按真实业务状态核验。
import { randomUUID } from 'node:crypto'
import { loadCloudStore } from '../cloud/store.js'
import { monthlyAnalytics } from './analytics.js'
import { listAccounts } from './accounts.js'
import { listSubscriptions } from './subscriptions.js'
import {
  createSubscriptionOperation, getSubscriptionOperation, cancelSubscriptionOperation,
} from './subscription-operations.js'
import {
  listCreditAccounts, createRepaymentOperation, getRepaymentOperation, cancelRepaymentOperation,
} from './credit.js'

export class WorkflowError extends Error {
  constructor(message, code = 'workflow_error') {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}

const FLOW_DEFS = {
  subscription_review: [
    { key: 'analyze_month', type: 'readonly', depends_on: [] },
    { key: 'list_subscriptions', type: 'readonly', depends_on: [] },
    { key: 'choose_subscription', type: 'selection', depends_on: ['analyze_month', 'list_subscriptions'] },
    { key: 'prepare_subscription', type: 'mutation', depends_on: ['choose_subscription'] },
    { key: 'await_confirmation', type: 'confirmation', depends_on: ['prepare_subscription'] },
    { key: 'verify_result', type: 'verify', depends_on: ['await_confirmation'] },
    { key: 'summary', type: 'summary', depends_on: ['verify_result'] },
  ],
  repayment_review: [
    { key: 'list_credit_accounts', type: 'readonly', depends_on: [] },
    { key: 'list_statements', type: 'readonly', depends_on: ['list_credit_accounts'] },
    { key: 'choose_repayment', type: 'selection', depends_on: ['list_credit_accounts', 'list_statements'] },
    { key: 'choose_payment_account', type: 'selection', depends_on: ['choose_repayment'] },
    { key: 'prepare_repayment', type: 'mutation', depends_on: ['choose_repayment', 'choose_payment_account'] },
    { key: 'await_verification', type: 'confirmation', depends_on: ['prepare_repayment'] },
    { key: 'verify_result', type: 'verify', depends_on: ['await_verification'] },
    { key: 'summary', type: 'summary', depends_on: ['verify_result'] },
  ],
}
const MAX_STEPS = 12
const INTERACTIVE = new Set(['choose_subscription', 'prepare_subscription', 'await_confirmation',
  'choose_repayment', 'choose_payment_account', 'prepare_repayment', 'await_verification', 'verify_result', 'summary'])

function canonicalNodes(flow) {
  return FLOW_DEFS[flow].map((n) => ({ ...n, status: 'pending', result: null, error: null }))
}

function validateSteps(flow, steps) {
  if (steps === undefined || steps === null) return canonicalNodes(flow)
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) throw new WorkflowError('计划步骤必须是数组且不超过 12 步', 'bad_plan')
  const canonical = new Map(FLOW_DEFS[flow].map((n) => [n.key, n]))
  const seen = new Set()
  const nodes = []
  for (const s of steps) {
    if (!s || typeof s !== 'object' || typeof s.key !== 'string') throw new WorkflowError('步骤格式不合法', 'bad_plan')
    if (!canonical.has(s.key)) throw new WorkflowError(`不在白名单内的节点：${s.key}`, 'bad_plan')
    if (seen.has(s.key)) throw new WorkflowError(`步骤重复：${s.key}`, 'bad_plan')
    seen.add(s.key)
    const deps = Array.isArray(s.depends_on) ? s.depends_on : []
    if (deps.some((d) => typeof d !== 'string' || !canonical.has(d))) throw new WorkflowError('步骤依赖不在白名单内', 'bad_plan')
    nodes.push({ key: s.key, type: canonical.get(s.key).type, depends_on: deps, status: 'pending', result: null, error: null })
  }
  for (const n of FLOW_DEFS[flow]) if (!seen.has(n.key)) throw new WorkflowError(`计划缺少节点：${n.key}`, 'bad_plan')
  // Kahn 无环校验
  const indeg = new Map(nodes.map((n) => [n.key, n.depends_on.length]))
  const queue = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key)
  let visited = 0
  while (queue.length) {
    const k = queue.shift()
    visited += 1
    for (const n of nodes) {
      if (!n.depends_on.includes(k)) continue
      indeg.set(n.key, indeg.get(n.key) - 1)
      if (indeg.get(n.key) === 0) queue.push(n.key)
    }
  }
  if (visited !== nodes.length) throw new WorkflowError('计划存在循环依赖', 'bad_plan')
  return nodes
}

function node(plan, key) { return plan.nodes.find((n) => n.key === key) }
function mark(plan, key, status, result = null, error = null) {
  const n = node(plan, key)
  if (n) { n.status = status; n.result = result; n.error = error }
}
function resetInteractive(plan) {
  for (const n of plan.nodes) if (INTERACTIVE.has(n.key)) { n.status = 'pending'; n.result = null; n.error = null }
  plan.op_ref = null
}
function resetAll(plan) {
  for (const n of plan.nodes) { n.status = 'pending'; n.result = null; n.error = null }
  plan.op_ref = null
}
function depsDone(plan, key) {
  const n = node(plan, key)
  return n && n.depends_on.every((d) => node(plan, d)?.status === 'completed')
}

export function createLocalWorkflowOps(db, userId) {
  return {
    async analytics({ month, accountId }) {
      const [y, m] = String(month || '').split('-').map(Number)
      if (!y || !m) throw new WorkflowError('月份格式应为 YYYY-MM', 'bad_month')
      return monthlyAnalytics(db, userId, { year: y, month: m, asOf: new Date().toISOString(), accountId })
    },
    async subscriptions() { return listSubscriptions(db, userId) },
    async accounts() { return listAccounts(db, userId) },
    async creditAccounts() { return listCreditAccounts(db, userId) },
    async createSubscriptionOperation(payload) { return createSubscriptionOperation(db, userId, payload) },
    async getSubscriptionOperation(ref) { return getSubscriptionOperation(db, userId, ref) },
    async cancelSubscriptionOperation(ref) { return cancelSubscriptionOperation(db, userId, ref) },
    async createRepaymentOperation(payload) { return createRepaymentOperation(db, userId, { ...payload, sessionId: payload.sessionId || null }) },
    async getRepaymentOperation(ref) { return getRepaymentOperation(db, userId, ref) },
    async cancelRepaymentOperation(ref) { return cancelRepaymentOperation(db, userId, ref) },
  }
}

export function createLocalWorkflowStore(db, userId) {
  const load = (planNo) => {
    const row = db.prepare('SELECT * FROM workflow_plans WHERE plan_no = ? AND user_id = ?').get(planNo, userId)
    if (!row) return null
    let plan
    try { plan = JSON.parse(row.plan_json) } catch { throw new WorkflowError('计划数据损坏', 'corrupt') }
    return { ...plan, plan_no: row.plan_no, flow: row.flow, status: row.status, _version: row.version,
      created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at }
  }
  return {
    async get(planNo) { return load(planNo) },
    async list(limit = 30) {
      return db.prepare('SELECT plan_no FROM workflow_plans WHERE user_id = ? ORDER BY id DESC LIMIT ?')
        .all(userId, Math.min(Math.max(Number(limit) || 30, 1), 100)).map((r) => load(r.plan_no)).filter(Boolean)
    },
    async create(plan) {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO workflow_plans (plan_no, user_id, flow, status, plan_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(plan.plan_no, userId, plan.flow, plan.status, JSON.stringify(plan), now, now)
      return load(plan.plan_no)
    },
    async save(plan) {
      const now = new Date().toISOString()
      const info = db.prepare(
        `UPDATE workflow_plans SET status = ?, plan_json = ?, version = version + 1, updated_at = ?,
           completed_at = ? WHERE plan_no = ? AND user_id = ? AND version = ?`,
      ).run(plan.status, JSON.stringify(plan), now, plan.completed_at || null, plan.plan_no, userId, plan._version)
      if (info.changes !== 1) throw new WorkflowError('计划已被并发修改，请刷新后重试', 'conflict')
      return load(plan.plan_no)
    },
  }
}

export function createCloudWorkflowStore({ client, userId }) {
  const loadSnap = async () => (await loadCloudStore({ client, userId })).snapshot
  const hydrate = (row) => {
    if (!row) return null
    const plan = row.plan_json && typeof row.plan_json === 'object' ? row.plan_json : {}
    return { ...plan, plan_no: row.plan_no, flow: row.flow, status: row.status, _version: Number(row.version) || 0,
      created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null }
  }
  return {
    async get(planNo) {
      const snap = await loadSnap()
      return hydrate((snap.workflow_plans || []).find((p) => p.plan_no === planNo))
    },
    async list(limit = 30) {
      const snap = await loadSnap()
      return (snap.workflow_plans || []).slice(0, Math.min(Math.max(Number(limit) || 30, 1), 100)).map(hydrate)
    },
    async create(plan) {
      const row = await client.write('plan', 'create', {
        plan_no: plan.plan_no, flow: plan.flow, status: plan.status, plan_json: plan,
      }, userId)
      return hydrate(row)
    },
    async save(plan) {
      const row = await client.write('plan', 'save', {
        plan_no: plan.plan_no, base_version: plan._version, status: plan.status,
        plan_json: plan, completed_at: plan.completed_at || null,
      }, userId)
      if (row && row.conflict) throw new WorkflowError('计划已被并发修改，请刷新后重试', 'conflict')
      return hydrate(row)
    },
  }
}

export function createCloudWorkflowOps({ client, userId }) {
  const loadSnap = async () => (await loadCloudStore({ client, userId })).snapshot
  const storeForView = () => loadCloudStore({ client, userId })
  return {
    async analytics({ month, accountId }) {
      const [y, m] = String(month || '').split('-').map(Number)
      if (!y || !m) throw new WorkflowError('月份格式应为 YYYY-MM', 'bad_month')
      return (await storeForView()).analytics({ year: y, month: m, asOf: new Date().toISOString(), accountId })
    },
    async subscriptions() { return (await storeForView()).subscriptions() },
    async accounts() { return (await storeForView()).accounts() },
    async creditAccounts() { return (await storeForView()).creditAccounts() },
    async createSubscriptionOperation(payload) {
      const r = await client.write('subscription', 'create', {
        subscription_id: payload.subscriptionId, action: payload.action,
        ...(payload.toAccountId !== undefined ? { to_account_id: payload.toAccountId } : {}),
      }, userId)
      return (await storeForView()).subscriptionOpByRef(r.ref_no)
    },
    async getSubscriptionOperation(ref) { return (await storeForView()).subscriptionOpByRef(ref) },
    async cancelSubscriptionOperation(ref) { return client.write('subscription', 'cancel', { ref_no: ref }, userId) },
    async createRepaymentOperation(payload) {
      const r = await client.write('repayment', 'create', {
        scope: payload.scope, statement_id: payload.statementId, from_account_id: payload.fromAccountId,
        credit_account_id: payload.creditAccountId, session_id: payload.sessionId,
      }, userId)
      return (await storeForView()).repaymentByRef(r.ref_no)
    },
    async getRepaymentOperation(ref) { return (await storeForView()).repaymentByRef(ref) },
    async cancelRepaymentOperation(ref) { return client.write('repayment', 'cancel', { ref_no: ref }, userId) },
    _snapshot: loadSnap,
  }
}

export function createWorkflowService({ store, ops, audit = null }) {
  async function refreshReadonly(plan) {
    for (const n of plan.nodes) {
      if (n.type !== 'readonly' || n.status === 'completed') continue
      try {
        if (n.key === 'analyze_month') {
          n.result = await ops.analytics({ month: plan.params.month, accountId: plan.params.account_id })
        } else if (n.key === 'list_subscriptions') {
          n.result = (await ops.subscriptions()).filter((s) => s.status === 'active')
        } else if (n.key === 'list_credit_accounts') {
          n.result = await ops.creditAccounts()
        } else if (n.key === 'list_statements') {
          const accounts = await ops.creditAccounts()
          n.result = accounts.flatMap((a) => a.statements.map((s) => ({ ...s, card: a.card, account_name: a.account_name })))
        }
        n.status = 'completed'
      } catch (e) {
        n.status = 'failed'; n.error = e.message
      }
    }
  }

  async function view(plan) {
    const subscriptions = await ops.subscriptions().catch(() => [])
    const accounts = await ops.accounts().catch(() => [])
    const credits = await ops.creditAccounts().catch(() => [])
    const op = plan.op_ref
      ? (plan.flow === 'subscription_review'
          ? await ops.getSubscriptionOperation(plan.op_ref).catch(() => null)
          : await ops.getRepaymentOperation(plan.op_ref).catch(() => null))
      : null
    return {
      plan_no: plan.plan_no, flow: plan.flow, status: plan.status, params: plan.params,
      nodes: plan.nodes.map((n) => ({ key: n.key, type: n.type, status: n.status, depends_on: n.depends_on, result: n.result, error: n.error })),
      op_ref: plan.op_ref || null, op,
      selectable_subscriptions: subscriptions.filter((s) => s.status === 'active'),
      selectable_credit_accounts: credits,
      selectable_deposit_accounts: accounts.filter((a) => a.account_type === 'deposit' && a.status === 'active'),
      created_at: plan.created_at, updated_at: plan.updated_at, completed_at: plan.completed_at || null,
    }
  }

  async function reconcile(plan) {
    if (!['waiting_confirmation', 'waiting_verification'].includes(plan.status)) return plan
    if (!plan.op_ref) return plan
    const op = plan.flow === 'subscription_review'
      ? await ops.getSubscriptionOperation(plan.op_ref)
      : await ops.getRepaymentOperation(plan.op_ref)
    if (!op) { mark(plan, 'verify_result', 'failed', null, '操作单不存在'); plan.status = 'failed'; return plan }
    if (op.status === 'completed') {
      let verified = true
      if (plan.flow === 'subscription_review') {
        const subs = await ops.subscriptions()
        const sub = subs.find((s) => Number(s.id) === Number(plan.params.subscription_id))
        const action = plan.params.action || 'pause'
        if (!sub) verified = false
        else if (action === 'pause' && sub.status !== 'paused') verified = false
        else if (action === 'change_source' && Number(sub.account_id) !== Number(plan.params.to_account_id)) verified = false
        mark(plan, 'verify_result', verified ? 'completed' : 'failed', { op_ref: op.ref_no, status: op.status }, verified ? null : '业务状态与操作单不一致')
        if (!verified) { plan.status = 'failed'; return plan }
      } else {
        mark(plan, 'verify_result', 'completed', { op_ref: op.ref_no, status: op.status })
      }
      const summary = { op_ref: op.ref_no, op_status: op.status, flow: plan.flow, params: plan.params,
        note: '已完成操作以服务端操作单状态为准；本计划不提供已完成扣款的直接撤销。' }
      mark(plan, 'summary', 'completed', summary)
      plan.status = 'completed'; plan.completed_at = new Date().toISOString()
      await audit?.record({ plan_id: plan.plan_no, operation_ref: op.ref_no, category: 'plan',
        action: 'completed', result: 'ok', detail: { flow: plan.flow } })
      return plan
    }
    if (['cancelled', 'expired'].includes(op.status)) {
      resetInteractive(plan); plan.status = 'waiting_selection'
      await refreshReadonly(plan)
      return plan
    }
    if (op.status === 'failed') {
      mark(plan, 'verify_result', 'failed', { op_ref: op.ref_no, status: op.status }, '操作单已失效')
      plan.status = 'failed'
    }
    return plan
  }

  async function get(planNo) {
    let plan = await store.get(planNo)
    if (!plan) return null
    const before = JSON.stringify({ status: plan.status, op_ref: plan.op_ref, nodes: plan.nodes, completed_at: plan.completed_at })
    await reconcile(plan)
    if (plan.status === 'waiting_selection') await refreshReadonly(plan)
    if (JSON.stringify({ status: plan.status, op_ref: plan.op_ref, nodes: plan.nodes, completed_at: plan.completed_at }) !== before) {
      plan = await store.save(plan)
    }
    return view(plan)
  }

  async function create({ flow, params = {}, steps = null }) {
    if (!FLOW_DEFS[flow]) throw new WorkflowError('不支持的任务流', 'bad_flow')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new WorkflowError('params 必须是对象', 'bad_params')
    if (flow === 'subscription_review' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(params.month || ''))) {
      throw new WorkflowError('subscription_review 需要 month=YYYY-MM', 'bad_month')
    }
    const plan = {
      plan_no: `wf-${randomUUID()}`, flow, status: 'waiting_selection', params: { ...params },
      nodes: validateSteps(flow, steps), op_ref: null,
    }
    await refreshReadonly(plan)
    const saved = await store.create(plan)
    await audit?.record({ plan_id: saved.plan_no, category: 'plan', action: 'create', result: 'ok',
      detail: { flow, params: sanitizeParams(params), steps: plan.nodes.map((n) => n.key) } })
    return view(saved)
  }

  function sanitizeParams(params) {
    return Object.fromEntries(Object.entries(params).filter(([k]) => !/password|totp|secret|key/i.test(k)))
  }

  async function mutate(planNo, fn, action) {
    const plan = await store.get(planNo)
    if (!plan) throw new WorkflowError('计划不存在', 'not_found')
    await fn(plan)
    const saved = await store.save(plan)
    await audit?.record({ plan_id: saved.plan_no, operation_ref: saved.op_ref || null, category: 'plan',
      action, result: saved.status, detail: { flow: saved.flow } })
    return view(saved)
  }

  async function select(planNo, params) {
    return mutate(planNo, async (plan) => {
      if (plan.status !== 'waiting_selection') throw new WorkflowError('当前计划状态不可选择', 'bad_state')
      if (plan.flow === 'subscription_review') {
        if (!node(plan, 'choose_subscription') || !depsDone(plan, 'choose_subscription')) throw new WorkflowError('前置分析未完成', 'bad_state')
        const id = Number(params.subscription_id)
        const sub = (await ops.subscriptions()).find((s) => Number(s.id) === id && s.status === 'active')
        if (!sub) throw new WorkflowError('订阅不存在或不是生效状态', 'bad_subscription')
        const action = params.action === 'change_source' ? 'change_source' : 'pause'
        if (action === 'change_source' && !Number.isSafeInteger(Number(params.to_account_id))) throw new WorkflowError('更换来源需要 to_account_id', 'bad_account')
        const op = await ops.createSubscriptionOperation({ subscriptionId: id, action,
          toAccountId: action === 'change_source' ? Number(params.to_account_id) : undefined })
        plan.params = { ...plan.params, subscription_id: id, action, to_account_id: action === 'change_source' ? Number(params.to_account_id) : undefined }
        mark(plan, 'choose_subscription', 'completed', { subscription_id: id, merchant: sub.merchant, action })
        mark(plan, 'prepare_subscription', 'completed', { ref_no: op.ref_no, status: op.status, risk_level: op.risk_level })
        plan.op_ref = op.ref_no; plan.status = 'waiting_confirmation'
      } else {
        if (!depsDone(plan, 'choose_repayment')) throw new WorkflowError('前置账单 / 账户信息未完成', 'bad_state')
        const scope = params.scope === 'all_posted' ? 'all_posted' : 'statement'
        if (scope === 'statement' && !Number.isSafeInteger(Number(params.statement_id))) throw new WorkflowError('指定账单模式需要 statement_id', 'bad_statement')
        const fromId = Number(params.from_account_id)
        const dep = (await ops.accounts()).find((a) => Number(a.id) === fromId && a.account_type === 'deposit' && a.status === 'active')
        if (!dep) throw new WorkflowError('付款账户不可用', 'bad_account')
        const op = await ops.createRepaymentOperation({ scope, statementId: scope === 'statement' ? Number(params.statement_id) : undefined,
          fromAccountId: fromId, creditAccountId: params.credit_account_id ? Number(params.credit_account_id) : undefined })
        plan.params = { ...plan.params, scope, statement_id: scope === 'statement' ? Number(params.statement_id) : undefined,
          from_account_id: fromId, credit_account_id: params.credit_account_id ? Number(params.credit_account_id) : undefined }
        mark(plan, 'choose_repayment', 'completed', { scope, statement_id: plan.params.statement_id, credit_account_id: plan.params.credit_account_id })
        mark(plan, 'choose_payment_account', 'completed', { from_account_id: fromId, account_name: dep.account_name })
        mark(plan, 'prepare_repayment', 'completed', { ref_no: op.ref_no, status: op.status, amount_cents: op.amount_cents, risk_level: op.risk_level })
        plan.op_ref = op.ref_no; plan.status = 'waiting_verification'
      }
    }, 'select')
  }

  async function pause(planNo) {
    return mutate(planNo, async (plan) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return
      if (plan.op_ref) {
        const op = plan.flow === 'subscription_review' ? await ops.getSubscriptionOperation(plan.op_ref) : await ops.getRepaymentOperation(plan.op_ref)
        if (op?.status === 'completed') { await reconcile(plan); return }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          if (plan.flow === 'subscription_review') await ops.cancelSubscriptionOperation(plan.op_ref)
          else await ops.cancelRepaymentOperation(plan.op_ref)
        }
      }
      plan.status = 'paused'
    }, 'pause')
  }

  async function resume(planNo) {
    return mutate(planNo, async (plan) => {
      if (plan.status === 'paused') { resetInteractive(plan); plan.status = 'waiting_selection'; await refreshReadonly(plan) }
      else await reconcile(plan)
    }, 'resume')
  }

  async function cancel(planNo) {
    return mutate(planNo, async (plan) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return
      if (plan.op_ref) {
        const op = plan.flow === 'subscription_review' ? await ops.getSubscriptionOperation(plan.op_ref) : await ops.getRepaymentOperation(plan.op_ref)
        if (op?.status === 'completed') { await reconcile(plan); return }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          if (plan.flow === 'subscription_review') await ops.cancelSubscriptionOperation(plan.op_ref)
          else await ops.cancelRepaymentOperation(plan.op_ref)
        }
      }
      plan.status = 'cancelled'
    }, 'cancel')
  }

  async function retry(planNo) {
    return mutate(planNo, async (plan) => {
      if (plan.status !== 'failed') throw new WorkflowError('仅失败计划可重试', 'bad_state')
      resetAll(plan); plan.status = 'waiting_selection'; await refreshReadonly(plan)
    }, 'retry')
  }

  async function modify(planNo, params) {
    return mutate(planNo, async (plan) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) throw new WorkflowError('完成 / 取消的计划不可修改', 'bad_state')
      if (plan.op_ref) {
        const op = plan.flow === 'subscription_review' ? await ops.getSubscriptionOperation(plan.op_ref) : await ops.getRepaymentOperation(plan.op_ref)
        if (op?.status === 'completed') { await reconcile(plan); throw new WorkflowError('操作已完成，不能修改', 'completed') }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          if (plan.flow === 'subscription_review') await ops.cancelSubscriptionOperation(plan.op_ref)
          else await ops.cancelRepaymentOperation(plan.op_ref)
        }
      }
      resetAll(plan)
      plan.params = { ...plan.params, ...params }
      plan.status = 'waiting_selection'
      await refreshReadonly(plan)
    }, 'modify')
  }

  async function manual(planNo) {
    return mutate(planNo, async (plan) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return
      if (plan.op_ref) {
        const op = plan.flow === 'subscription_review' ? await ops.getSubscriptionOperation(plan.op_ref) : await ops.getRepaymentOperation(plan.op_ref)
        if (op?.status === 'completed') { await reconcile(plan); return }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          if (plan.flow === 'subscription_review') await ops.cancelSubscriptionOperation(plan.op_ref)
          else await ops.cancelRepaymentOperation(plan.op_ref)
        }
      }
      plan.status = 'manual'
    }, 'manual')
  }

  async function list(limit) {
    const rows = await store.list(limit)
    return Promise.all(rows.map(view))
  }
  return { create, get, select, pause, resume, cancel, retry, modify, manual, list }
}
