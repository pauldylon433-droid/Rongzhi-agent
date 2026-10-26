// 受约束 DAG 计划：两条白名单任务链（订阅审查 / 信用卡还款审查）。
// 模型只提交 flow / 参数 / 可选步骤依赖；服务端验证节点白名单、依赖、无环、步骤上限与参数，
// 再持久化并在关键节点调用既有操作单服务。计划可暂停 / 继续 / 取消 / 重试 / 修改未执行步骤 / 转人工。
// 回退只重置未执行节点，绝不反向已完成扣款；已完成操作只能按真实业务状态核验。
// 建单与计划版本在同一个数据库事务（本地 SQLite / 云端固定 RPC）内完成，失败不留孤单。
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

// —— 严格参数 schema：所有入口（AI / API / 修改 / 恢复）复用，非法枚举 / 额外字段 / 非法类型直接拒绝 ——
const PARAM_SPECS = {
  subscription_review: {
    create: {
      month: { kind: 'month', required: true },
      account_id: { kind: 'positive_int' },
    },
    select: {
      subscription_id: { kind: 'positive_int', required: true },
      action: { kind: 'enum', values: ['pause', 'change_source'], required: true },
      to_account_id: { kind: 'positive_int' },
    },
    modify: {
      month: { kind: 'month' },
      account_id: { kind: 'positive_int' },
      subscription_id: { kind: 'positive_int' },
      action: { kind: 'enum', values: ['pause', 'change_source'] },
      to_account_id: { kind: 'positive_int' },
    },
  },
  repayment_review: {
    create: {},
    select: {
      scope: { kind: 'enum', values: ['statement', 'all_posted'] },
      statement_id: { kind: 'positive_int' },
      from_account_id: { kind: 'positive_int', required: true },
      credit_account_id: { kind: 'positive_int' },
    },
    modify: {
      scope: { kind: 'enum', values: ['statement', 'all_posted'] },
      statement_id: { kind: 'positive_int' },
      from_account_id: { kind: 'positive_int' },
      credit_account_id: { kind: 'positive_int' },
    },
  },
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

function checkParamValue(key, spec, value) {
  if (spec.kind === 'positive_int') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new WorkflowError(`参数 ${key} 必须是正整数`, 'bad_params')
    }
    return value
  }
  if (spec.kind === 'month') {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
      throw new WorkflowError(`参数 ${key} 格式应为 YYYY-MM`, 'bad_params')
    }
    return value
  }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value)) {
      throw new WorkflowError(`参数 ${key} 仅支持：${spec.values.join(' / ')}`, 'bad_params')
    }
    return value
  }
  throw new WorkflowError(`参数 ${key} 校验规则缺失`, 'bad_params')
}

// 按阶段校验参数。返回归一化后的对象（含 select 阶段的默认 scope）。
function validateParams(flow, stage, params, existing = null) {
  const defs = PARAM_SPECS[flow]
  if (!defs || !defs[stage]) throw new WorkflowError('不支持的任务流', 'bad_flow')
  const input = params === undefined || params === null ? {} : params
  if (!isPlainObject(input)) throw new WorkflowError('params 必须是对象', 'bad_params')
  const spec = defs[stage]
  const extra = Object.keys(input).filter((k) => !Object.prototype.hasOwnProperty.call(spec, k))
  if (extra.length) throw new WorkflowError(`不支持的参数：${extra.join('、')}`, 'bad_params')
  const out = {}
  for (const [key, rule] of Object.entries(spec)) {
    if (input[key] === undefined) {
      if (rule.required) throw new WorkflowError(`缺少参数 ${key}`, 'bad_params')
      continue
    }
    out[key] = checkParamValue(key, rule, input[key])
  }
  if (stage === 'select') {
    if (flow === 'subscription_review') {
      if (out.action === 'change_source' && out.to_account_id === undefined) {
        throw new WorkflowError('更换扣款账户需要 to_account_id', 'bad_params')
      }
      if (out.action !== 'change_source' && out.to_account_id !== undefined) {
        throw new WorkflowError('仅在更换扣款账户时接受 to_account_id', 'bad_params')
      }
    } else {
      if (out.scope === undefined) out.scope = 'statement'
      if (out.scope === 'statement' && out.statement_id === undefined) {
        throw new WorkflowError('指定账单模式需要 statement_id', 'bad_params')
      }
      if (out.scope === 'all_posted' && out.statement_id !== undefined) {
        throw new WorkflowError('结清全部欠款模式不接受 statement_id', 'bad_params')
      }
    }
  }
  if (stage === 'modify' && existing) {
    // 修改后的合并参数必须保持自洽，但只校验修改涉及的字段。
    const merged = { ...existing, ...out }
    if (flow === 'subscription_review') {
      if (merged.action !== undefined) {
        if (!['pause', 'change_source'].includes(merged.action)) throw new WorkflowError('参数 action 仅支持：pause / change_source', 'bad_params')
        if (merged.action === 'change_source' && merged.to_account_id === undefined) {
          throw new WorkflowError('更换扣款账户需要 to_account_id', 'bad_params')
        }
      }
      if (merged.to_account_id !== undefined && merged.action !== 'change_source') {
        throw new WorkflowError('仅在更换扣款账户时接受 to_account_id', 'bad_params')
      }
    } else if (merged.scope !== undefined && !['statement', 'all_posted'].includes(merged.scope)) {
      throw new WorkflowError('参数 scope 仅支持：statement / all_posted', 'bad_params')
    }
  }
  return out
}

function canonicalNodes(flow) {
  return FLOW_DEFS[flow].map((n) => ({ ...n, status: 'pending', result: null, error: null }))
}

// 步骤依赖必须与模板完全一致：不能删除业务必需边、不能增加边、不能重复依赖、不能逆置方向。
function validateSteps(flow, steps) {
  if (steps === undefined || steps === null) return canonicalNodes(flow)
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) throw new WorkflowError('计划步骤必须是数组且不超过 12 步', 'bad_plan')
  const canonical = new Map(FLOW_DEFS[flow].map((n) => [n.key, n]))
  const seen = new Set()
  const nodes = []
  for (const s of steps) {
    if (!isPlainObject(s) || typeof s.key !== 'string') throw new WorkflowError('步骤格式不合法', 'bad_plan')
    const extra = Object.keys(s).filter((k) => !['key', 'depends_on'].includes(k))
    if (extra.length) throw new WorkflowError(`步骤不接受字段：${extra.join('、')}`, 'bad_plan')
    if (!canonical.has(s.key)) throw new WorkflowError(`不在白名单内的节点：${s.key}`, 'bad_plan')
    if (seen.has(s.key)) throw new WorkflowError(`步骤重复：${s.key}`, 'bad_plan')
    seen.add(s.key)
    const deps = s.depends_on === undefined ? [] : s.depends_on
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !canonical.has(d))) {
      throw new WorkflowError('步骤依赖不在白名单内', 'bad_plan')
    }
    if (new Set(deps).size !== deps.length) throw new WorkflowError(`步骤依赖重复：${s.key}`, 'bad_plan')
    const required = canonical.get(s.key).depends_on
    const missing = required.filter((d) => !deps.includes(d))
    const added = deps.filter((d) => !required.includes(d))
    if (missing.length || added.length) {
      throw new WorkflowError(`步骤依赖必须与模板一致：${s.key}（缺少 ${missing.join('、') || '无'}；多出 ${added.join('、') || '无'}）`, 'bad_plan')
    }
    nodes.push({ key: s.key, type: canonical.get(s.key).type, depends_on: [...required], status: 'pending', result: null, error: null })
  }
  for (const n of FLOW_DEFS[flow]) if (!seen.has(n.key)) throw new WorkflowError(`计划缺少节点：${n.key}`, 'bad_plan')
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
function clonePlan(plan) { return JSON.parse(JSON.stringify(plan)) }

export function createLocalWorkflowOps(db, userId) {
  const sync = {
    analytics({ month, accountId }) {
      const [y, m] = String(month || '').split('-').map(Number)
      if (!y || !m) throw new WorkflowError('月份格式应为 YYYY-MM', 'bad_month')
      return monthlyAnalytics(db, userId, { year: y, month: m, asOf: new Date().toISOString(), accountId })
    },
    subscriptions() { return listSubscriptions(db, userId) },
    accounts() { return listAccounts(db, userId) },
    creditAccounts() { return listCreditAccounts(db, userId) },
    createSubscriptionOperation(payload) { return createSubscriptionOperation(db, userId, payload) },
    getSubscriptionOperation(ref) { return getSubscriptionOperation(db, userId, ref) },
    cancelSubscriptionOperation(ref) { return cancelSubscriptionOperation(db, userId, ref) },
    createRepaymentOperation(payload) { return createRepaymentOperation(db, userId, { ...payload, sessionId: payload.sessionId || null }) },
    getRepaymentOperation(ref) { return getRepaymentOperation(db, userId, ref) },
    cancelRepaymentOperation(ref) { return cancelRepaymentOperation(db, userId, ref) },
  }
  return {
    sync,
    async analytics(payload) { return sync.analytics(payload) },
    async subscriptions() { return sync.subscriptions() },
    async accounts() { return sync.accounts() },
    async creditAccounts() { return sync.creditAccounts() },
    async createSubscriptionOperation(payload) { return sync.createSubscriptionOperation(payload) },
    async getSubscriptionOperation(ref) { return sync.getSubscriptionOperation(ref) },
    async cancelSubscriptionOperation(ref) { return sync.cancelSubscriptionOperation(ref) },
    async createRepaymentOperation(payload) { return sync.createRepaymentOperation(payload) },
    async getRepaymentOperation(ref) { return sync.getRepaymentOperation(ref) },
    async cancelRepaymentOperation(ref) { return sync.cancelRepaymentOperation(ref) },
  }
}

function selectLocalSync(db, userId, plan, params) {
  if (plan.status !== 'waiting_selection') throw new WorkflowError('当前计划状态不可选择', 'bad_state')
  if (plan.flow === 'subscription_review') {
    if (!node(plan, 'choose_subscription') || !depsDone(plan, 'choose_subscription')) {
      throw new WorkflowError('前置分析未完成或失败，不能选择订阅', 'bad_state')
    }
    const id = params.subscription_id
    const sub = listSubscriptions(db, userId).find((x) => Number(x.id) === id && x.status === 'active')
    if (!sub) throw new WorkflowError('订阅不存在或不是生效状态', 'bad_subscription')
    const action = params.action
    const opRef = `wf-${plan.plan_no}-v${plan._version}-sub`
    const op = createSubscriptionOperation(db, userId, {
      subscriptionId: id, action, toAccountId: action === 'change_source' ? params.to_account_id : undefined,
      refNo: opRef,
    })
    plan.params = { ...plan.params, subscription_id: id, action,
      to_account_id: action === 'change_source' ? params.to_account_id : undefined }
    mark(plan, 'choose_subscription', 'completed', { subscription_id: id, merchant: sub.merchant, action })
    mark(plan, 'prepare_subscription', 'completed', { ref_no: op.ref_no, status: op.status, risk_level: op.risk_level })
    plan.op_ref = op.ref_no; plan.status = 'waiting_confirmation'
    return plan
  }
  if (!depsDone(plan, 'choose_repayment')) throw new WorkflowError('前置账单 / 账户信息未完成或失败', 'bad_state')
  const opRef = `wf-${plan.plan_no}-v${plan._version}-repay`
  const op = createRepaymentOperation(db, userId, {
    scope: params.scope, statementId: params.scope === 'statement' ? params.statement_id : undefined,
    fromAccountId: params.from_account_id,
    creditAccountId: params.credit_account_id,
    refNo: opRef,
  })
  plan.params = { ...plan.params, scope: params.scope,
    statement_id: params.scope === 'statement' ? params.statement_id : undefined,
    from_account_id: params.from_account_id, credit_account_id: params.credit_account_id }
  mark(plan, 'choose_repayment', 'completed', { scope: params.scope, statement_id: plan.params.statement_id, credit_account_id: params.credit_account_id })
  mark(plan, 'choose_payment_account', 'completed', { from_account_id: params.from_account_id })
  mark(plan, 'prepare_repayment', 'completed', { ref_no: op.ref_no, status: op.status, amount_cents: op.amount_cents, risk_level: op.risk_level })
  plan.op_ref = op.ref_no; plan.status = 'waiting_verification'
  return plan
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
  function saveRow(plan) {
    const now = new Date().toISOString()
    const info = db.prepare(
      `UPDATE workflow_plans SET status = ?, plan_json = ?, version = version + 1, updated_at = ?,
         completed_at = ? WHERE plan_no = ? AND user_id = ? AND version = ?`,
    ).run(plan.status, JSON.stringify(plan), now, plan.completed_at || null, plan.plan_no, userId, plan._version)
    if (info.changes !== 1) throw new WorkflowError('计划已被并发修改，请刷新后重试', 'conflict')
    return load(plan.plan_no)
  }
  function cancelOpAtomic(plan, cancelRef) {
    if (!cancelRef) return
    const r = plan.flow === 'subscription_review'
      ? cancelSubscriptionOperation(db, userId, cancelRef)
      : cancelRepaymentOperation(db, userId, cancelRef)
    if (r.outcome === 'completed') throw new WorkflowError('操作已完成，计划状态已变化，请刷新后重试', 'conflict')
    if (r.outcome === 'not_found') throw new WorkflowError('计划关联的操作单不存在', 'not_found')
  }
  return {
    // 计划版本校验 + 建单 + 关联 + 保存：同一 SQLite 事务，失败整体回滚。
    selectAtomic(planNo, params) {
      return db.transaction(() => {
        const plan = load(planNo)
        if (!plan) throw new WorkflowError('计划不存在', 'not_found')
        selectLocalSync(db, userId, plan, params)
        return saveRow(plan)
      })()
    },
    // 生命周期变更 + 取消待确认单 + 版本 CAS：同一事务。
    saveAtomic(plan, cancelRef = null) {
      return db.transaction(() => {
        cancelOpAtomic(plan, cancelRef)
        return saveRow(plan)
      })()
    },
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
    async save(plan) { return saveRow(plan) },
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
  async function get(planNo) {
    const snap = await loadSnap()
    return hydrate((snap.workflow_plans || []).find((p) => p.plan_no === planNo))
  }
  // 预览：JS 只负责生成计划 JSON 与确定性操作单编号；真正的建单、版本校验与保存由数据库函数在单事务内完成。
  function selectPreview(plan, params, opRef) {
    const preview = clonePlan(plan)
    if (plan.flow === 'subscription_review') {
      mark(preview, 'choose_subscription', 'completed', { subscription_id: params.subscription_id, action: params.action })
      mark(preview, 'prepare_subscription', 'completed', {
        ref_no: opRef, status: params.action === 'change_source' ? 'needs_verification' : 'pending',
      })
      preview.params = { ...preview.params, subscription_id: params.subscription_id, action: params.action,
        to_account_id: params.action === 'change_source' ? params.to_account_id : undefined }
      preview.status = 'waiting_confirmation'
    } else {
      mark(preview, 'choose_repayment', 'completed', {
        scope: params.scope, statement_id: params.scope === 'statement' ? params.statement_id : undefined,
        credit_account_id: params.credit_account_id,
      })
      mark(preview, 'choose_payment_account', 'completed', { from_account_id: params.from_account_id })
      mark(preview, 'prepare_repayment', 'completed', { ref_no: opRef, status: 'needs_verification' })
      preview.params = { ...preview.params, scope: params.scope,
        statement_id: params.scope === 'statement' ? params.statement_id : undefined,
        from_account_id: params.from_account_id, credit_account_id: params.credit_account_id }
      preview.status = 'waiting_verification'
    }
    preview.op_ref = opRef
    return preview
  }
  return {
    async get(planNo) { return get(planNo) },
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
    // 云端原子选择：数据库函数在单事务内校验计划版本 / 状态、创建操作单（确定性编号）、保存计划。
    async selectAtomic(planNo, params) {
      const plan = await get(planNo)
      if (!plan) throw new WorkflowError('计划不存在', 'not_found')
      const opRef = `wf-${plan.plan_no}-v${plan._version}-${plan.flow === 'subscription_review' ? 'sub' : 'repay'}`
      const preview = selectPreview(plan, params, opRef)
      const opPayload = plan.flow === 'subscription_review'
        ? { subscription_id: params.subscription_id, action: params.action,
          ...(params.action === 'change_source' ? { to_account_id: params.to_account_id } : {}), ref_no: opRef }
        : { scope: params.scope, from_account_id: params.from_account_id,
          ...(params.scope === 'statement' ? { statement_id: params.statement_id } : {}),
          ...(params.credit_account_id !== undefined ? { credit_account_id: params.credit_account_id } : {}), ref_no: opRef }
      const row = await client.write('plan', 'select', {
        plan_no: planNo, base_version: plan._version, flow: plan.flow, status: preview.status,
        plan_json: preview, op_payload: opPayload,
      }, userId)
      if (!row || row.conflict) throw new WorkflowError('计划已被并发修改，请刷新后重试', 'conflict')
      if (row.outcome === 'not_found') throw new WorkflowError('计划不存在', 'not_found')
      if (row.outcome === 'bad_state') throw new WorkflowError('当前计划状态不可选择', 'bad_state')
      return hydrate(row)
    },
    // 云端原子生命周期变更：数据库函数在同一事务内校验版本、取消待确认单、保存计划。
    async saveAtomic(plan, cancelRef = null) {
      const row = await client.write('plan', 'transition', {
        plan_no: plan.plan_no, base_version: plan._version, flow: plan.flow, status: plan.status,
        plan_json: plan, completed_at: plan.completed_at || null, cancel_ref: cancelRef || null,
      }, userId)
      if (!row || row.conflict) throw new WorkflowError('计划已被并发修改，请刷新后重试', 'conflict')
      if (row.outcome === 'completed_conflict') throw new WorkflowError('操作已完成，计划状态已变化，请刷新后重试', 'conflict')
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
        ...(payload.refNo ? { ref_no: payload.refNo } : {}),
      }, userId)
      return (await storeForView()).subscriptionOpByRef(r.ref_no)
    },
    async getSubscriptionOperation(ref) { return (await storeForView()).subscriptionOpByRef(ref) },
    async cancelSubscriptionOperation(ref) { return client.write('subscription', 'cancel', { ref_no: ref }, userId) },
    async createRepaymentOperation(payload) {
      const r = await client.write('repayment', 'create', {
        scope: payload.scope, statement_id: payload.statementId, from_account_id: payload.fromAccountId,
        credit_account_id: payload.creditAccountId, session_id: payload.sessionId,
        ...(payload.refNo ? { ref_no: payload.refNo } : {}),
      }, userId)
      return (await storeForView()).repaymentByRef(r.ref_no)
    },
    async getRepaymentOperation(ref) { return (await storeForView()).repaymentByRef(ref) },
    async cancelRepaymentOperation(ref) { return client.write('repayment', 'cancel', { ref_no: ref }, userId) },
    _snapshot: loadSnap,
  }
}

export function createWorkflowService({ store, ops, audit = null }) {
  const opReader = (plan) => (plan.flow === 'subscription_review'
    ? ops.getSubscriptionOperation(plan.op_ref)
    : ops.getRepaymentOperation(plan.op_ref))

  // 只读节点失败即标记 failed；依赖未完成时选择入口会拒绝，不会继续后续业务节点。
  async function refreshReadonly(plan, { force = false } = {}) {
    for (const n of plan.nodes) {
      if (n.type !== 'readonly') continue
      if (n.status === 'completed' && !force) continue
      const queriedAt = new Date().toISOString()
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
        n.status = 'completed'; n.error = null
        n.queried_at = queriedAt; n.query_plan_version = plan._version ?? null
      } catch (e) {
        n.status = 'failed'; n.error = String(e && e.message ? e.message : e)
        n.queried_at = queriedAt; n.query_plan_version = plan._version ?? null
      }
    }
  }

  async function view(plan) {
    const errors = {}
    const safe = async (key, fn, fallback) => {
      try { return await fn() } catch (e) { errors[key] = String(e && e.message ? e.message : e); return fallback }
    }
    const subscriptions = await safe('subscriptions', () => ops.subscriptions(), [])
    const accounts = await safe('accounts', () => ops.accounts(), [])
    const credits = await safe('credit_accounts', () => ops.creditAccounts(), [])
    let op = null
    if (plan.op_ref) op = await safe('operation', () => opReader(plan), null)
    return {
      plan_no: plan.plan_no, flow: plan.flow, status: plan.status, params: plan.params,
      nodes: plan.nodes.map((n) => ({ key: n.key, type: n.type, status: n.status, depends_on: n.depends_on,
        result: n.result, error: n.error, queried_at: n.queried_at || null, query_plan_version: n.query_plan_version ?? null })),
      op_ref: plan.op_ref || null, op,
      selectable_subscriptions: subscriptions.filter((s) => s.status === 'active'),
      selectable_credit_accounts: credits,
      selectable_deposit_accounts: accounts.filter((a) => a.account_type === 'deposit' && a.status === 'active'),
      errors: Object.keys(errors).length ? errors : null,
      created_at: plan.created_at, updated_at: plan.updated_at, completed_at: plan.completed_at || null,
    }
  }

  // 操作单完成后：先完成确认 / 强验证节点，再核验与汇总；任何前置节点未完成都不会把计划标记完成。
  async function reconcile(plan, ctx = {}) {
    if (!['waiting_confirmation', 'waiting_verification'].includes(plan.status)) return plan
    if (!plan.op_ref) return plan
    let op
    try { op = await opReader(plan) } catch (e) {
      mark(plan, 'verify_result', 'failed', null, `查询操作单失败：${e && e.message ? e.message : e}`)
      plan.status = 'failed'
      return plan
    }
    if (!op) { mark(plan, 'verify_result', 'failed', null, '操作单不存在'); plan.status = 'failed'; return plan }
    if (op.status === 'completed') {
      const confirmKey = plan.flow === 'subscription_review' ? 'await_confirmation' : 'await_verification'
      mark(plan, confirmKey, 'completed', { op_ref: op.ref_no, status: op.status, confirmed_at: op.completed_at || null })
      let verified = true
      let verifyError = null
      if (plan.flow === 'subscription_review') {
        try {
          const subs = await ops.subscriptions()
          const sub = subs.find((s) => Number(s.id) === Number(plan.params.subscription_id))
          const action = plan.params.action || 'pause'
          if (!sub) verified = false
          else if (action === 'pause' && sub.status !== 'paused') verified = false
          else if (action === 'change_source' && Number(sub.account_id) !== Number(plan.params.to_account_id)) verified = false
          if (!verified) verifyError = '业务状态与操作单不一致'
        } catch (e) {
          verified = false
          verifyError = `查询订阅状态失败：${e && e.message ? e.message : e}`
        }
      }
      if (!verified) {
        mark(plan, 'verify_result', 'failed', { op_ref: op.ref_no, status: op.status }, verifyError)
        plan.status = 'failed'
        return plan
      }
      mark(plan, 'verify_result', 'completed', { op_ref: op.ref_no, status: op.status })
      if (!depsDone(plan, 'summary')) {
        mark(plan, 'verify_result', 'failed', null, '汇总前置节点未全部完成')
        plan.status = 'failed'
        return plan
      }
      const summary = { op_ref: op.ref_no, op_status: op.status, flow: plan.flow, params: plan.params,
        note: '已完成操作以服务端操作单状态为准；本计划不提供已完成扣款的直接撤销。' }
      mark(plan, 'summary', 'completed', summary)
      const unfinished = plan.nodes.filter((n) => n.key !== 'summary' && n.status !== 'completed')
      if (unfinished.length) {
        plan.status = 'failed'
        return plan
      }
      plan.status = 'completed'; plan.completed_at = new Date().toISOString()
      await audit?.record({ request_id: ctx.requestId || null, session_id: ctx.sessionId || null,
        plan_id: plan.plan_no, operation_ref: op.ref_no, category: 'plan',
        action: 'completed', result: 'ok', detail: { flow: plan.flow, plan_version: plan._version } })
      return plan
    }
    if (['cancelled', 'expired'].includes(op.status)) {
      resetInteractive(plan); plan.status = 'waiting_selection'
      await refreshReadonly(plan, { force: true })
      return plan
    }
    if (op.status === 'failed') {
      mark(plan, 'verify_result', 'failed', { op_ref: op.ref_no, status: op.status }, '操作单已失效')
      plan.status = 'failed'
    }
    return plan
  }

  async function get(planNo, ctx = {}) {
    let plan = await store.get(planNo)
    if (!plan) return null
    const before = JSON.stringify({ status: plan.status, op_ref: plan.op_ref, nodes: plan.nodes, completed_at: plan.completed_at })
    await reconcile(plan, ctx)
    if (plan.status === 'waiting_selection') await refreshReadonly(plan)
    if (JSON.stringify({ status: plan.status, op_ref: plan.op_ref, nodes: plan.nodes, completed_at: plan.completed_at }) !== before) {
      plan = store.saveAtomic ? await store.saveAtomic(plan, null) : await store.save(plan)
    }
    return view(plan)
  }

  async function create({ flow, params = {}, steps = null }, ctx = {}) {
    if (!FLOW_DEFS[flow]) throw new WorkflowError('不支持的任务流', 'bad_flow')
    const normalized = validateParams(flow, 'create', params)
    const plan = {
      plan_no: `wf-${randomUUID()}`, flow, status: 'waiting_selection', params: normalized,
      nodes: validateSteps(flow, steps), op_ref: null,
    }
    await refreshReadonly(plan)
    const saved = await store.create(plan)
    await audit?.record({ request_id: ctx.requestId || null, session_id: ctx.sessionId || null,
      plan_id: saved.plan_no, category: 'plan', action: 'create', result: 'ok',
      detail: { flow, params: sanitizeParams(normalized), steps: plan.nodes.map((n) => n.key), plan_version: saved._version } })
    return view(saved)
  }

  function sanitizeParams(params) {
    return Object.fromEntries(Object.entries(params).filter(([k]) => !/password|totp|secret|key/i.test(k)))
  }

  async function mutate(planNo, fn, action, ctx = {}) {
    const plan = await store.get(planNo)
    if (!plan) throw new WorkflowError('计划不存在', 'not_found')
    const cancelRef = await fn(plan, ctx)
    const saved = store.saveAtomic ? await store.saveAtomic(plan, cancelRef || null) : await store.save(plan)
    await audit?.record({ request_id: ctx.requestId || null, session_id: ctx.sessionId || null,
      plan_id: saved.plan_no, operation_ref: saved.op_ref || null, category: 'plan',
      action, result: saved.status, detail: { flow: saved.flow, plan_version: saved._version, cancel_ref: cancelRef || null } })
    return view(saved)
  }

  async function select(planNo, params, ctx = {}) {
    const existing = await store.get(planNo)
    if (!existing) throw new WorkflowError('计划不存在', 'not_found')
    const normalized = validateParams(existing.flow, 'select', params)
    if (store.selectAtomic) {
      const saved = await store.selectAtomic(planNo, normalized)
      await audit?.record({ request_id: ctx.requestId || null, session_id: ctx.sessionId || null,
        plan_id: saved.plan_no, operation_ref: saved.op_ref || null, category: 'plan',
        action: 'select', result: saved.status, detail: { flow: saved.flow, plan_version: saved._version } })
      return view(saved)
    }
    await mutate(planNo, async (plan) => {
      if (plan.status !== 'waiting_selection') throw new WorkflowError('当前计划状态不可选择', 'bad_state')
      if (plan.flow === 'subscription_review') {
        if (!node(plan, 'choose_subscription') || !depsDone(plan, 'choose_subscription')) throw new WorkflowError('前置分析未完成或失败，不能选择订阅', 'bad_state')
        const sub = (await ops.subscriptions()).find((s) => Number(s.id) === normalized.subscription_id && s.status === 'active')
        if (!sub) throw new WorkflowError('订阅不存在或不是生效状态', 'bad_subscription')
        const op = await ops.createSubscriptionOperation({ subscriptionId: normalized.subscription_id, action: normalized.action,
          toAccountId: normalized.action === 'change_source' ? normalized.to_account_id : undefined })
        plan.params = { ...plan.params, ...normalized }
        if (normalized.action !== 'change_source') delete plan.params.to_account_id
        mark(plan, 'choose_subscription', 'completed', { subscription_id: normalized.subscription_id, merchant: sub.merchant, action: normalized.action })
        mark(plan, 'prepare_subscription', 'completed', { ref_no: op.ref_no, status: op.status, risk_level: op.risk_level })
        plan.op_ref = op.ref_no; plan.status = 'waiting_confirmation'
      } else {
        if (!depsDone(plan, 'choose_repayment')) throw new WorkflowError('前置账单 / 账户信息未完成或失败', 'bad_state')
        const op = await ops.createRepaymentOperation({ scope: normalized.scope,
          statementId: normalized.scope === 'statement' ? normalized.statement_id : undefined,
          fromAccountId: normalized.from_account_id, creditAccountId: normalized.credit_account_id })
        plan.params = { ...plan.params, ...normalized,
          statement_id: normalized.scope === 'statement' ? normalized.statement_id : undefined }
        mark(plan, 'choose_repayment', 'completed', { scope: normalized.scope, statement_id: plan.params.statement_id, credit_account_id: normalized.credit_account_id })
        mark(plan, 'choose_payment_account', 'completed', { from_account_id: normalized.from_account_id })
        mark(plan, 'prepare_repayment', 'completed', { ref_no: op.ref_no, status: op.status, amount_cents: op.amount_cents, risk_level: op.risk_level })
        plan.op_ref = op.ref_no; plan.status = 'waiting_verification'
      }
      return null
    }, 'select', ctx)
  }

  async function pause(planNo, ctx = {}) {
    return mutate(planNo, async (plan, ctx) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return null
      if (plan.op_ref) {
        const op = await opReader(plan)
        if (op?.status === 'completed') { await reconcile(plan, ctx); return null }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          plan.status = 'paused'
          return plan.op_ref
        }
      }
      plan.status = 'paused'
      return null
    }, 'pause', ctx)
  }

  async function resume(planNo, ctx = {}) {
    return mutate(planNo, async (plan, ctx) => {
      if (plan.status === 'paused') {
        resetInteractive(plan); plan.status = 'waiting_selection'
        await refreshReadonly(plan, { force: true })
        return null
      }
      await reconcile(plan, ctx)
      return null
    }, 'resume', ctx)
  }

  async function cancel(planNo, ctx = {}) {
    return mutate(planNo, async (plan, ctx) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return null
      if (plan.op_ref) {
        const op = await opReader(plan)
        if (op?.status === 'completed') { await reconcile(plan, ctx); return null }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          plan.status = 'cancelled'
          return plan.op_ref
        }
      }
      plan.status = 'cancelled'
      return null
    }, 'cancel', ctx)
  }

  async function retry(planNo, ctx = {}) {
    return mutate(planNo, async (plan, ctx) => {
      if (plan.status !== 'failed') throw new WorkflowError('仅失败计划可重试', 'bad_state')
      resetAll(plan); plan.status = 'waiting_selection'
      await refreshReadonly(plan, { force: true })
      return null
    }, 'retry', ctx)
  }

  async function modify(planNo, params, ctx = {}) {
    const existing = await store.get(planNo)
    if (!existing) throw new WorkflowError('计划不存在', 'not_found')
    const normalized = validateParams(existing.flow, 'modify', params, existing.params)
    return mutate(planNo, async (plan, ctx) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) throw new WorkflowError('完成 / 取消的计划不可修改', 'bad_state')
      let cancelRef = null
      if (plan.op_ref) {
        const op = await opReader(plan)
        if (op?.status === 'completed') {
          await reconcile(plan, ctx)
          throw new WorkflowError('操作已完成，不能修改', 'completed')
        }
        if (op && ['pending', 'needs_verification'].includes(op.status)) cancelRef = plan.op_ref
      }
      resetAll(plan)
      plan.params = { ...plan.params, ...normalized }
      if (plan.flow === 'subscription_review' && plan.params.action !== 'change_source') delete plan.params.to_account_id
      if (plan.flow === 'repayment_review' && plan.params.scope === 'all_posted') delete plan.params.statement_id
      plan.status = 'waiting_selection'
      await refreshReadonly(plan, { force: true })
      return cancelRef
    }, 'modify', ctx)
  }

  async function manual(planNo, ctx = {}) {
    return mutate(planNo, async (plan, ctx) => {
      if (['completed', 'cancelled', 'manual'].includes(plan.status)) return null
      if (plan.op_ref) {
        const op = await opReader(plan)
        if (op?.status === 'completed') { await reconcile(plan, ctx); return null }
        if (op && ['pending', 'needs_verification'].includes(op.status)) {
          plan.status = 'manual'
          return plan.op_ref
        }
      }
      plan.status = 'manual'
      return null
    }, 'manual', ctx)
  }

  async function list(limit) {
    const rows = await store.list(limit)
    return Promise.all(rows.map(view))
  }
  return { create, get, select, pause, resume, cancel, retry, modify, manual, list }
}
