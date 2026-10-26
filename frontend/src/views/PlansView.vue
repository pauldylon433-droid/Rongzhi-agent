<script setup>
// 计划任务（新版受约束 DAG 计划）：与旧的「最近任务」业务记录入口分开。
// 仅从后端结构化计划视图渲染：依赖、节点状态、阻断原因、可选对象与操作单引用。
// 确认 / 强验证复用现有操作单确认卡；页面本身不执行扣款，也不绕过强验证。
import { ref, computed, onMounted } from 'vue'
import {
  fetchWorkflowPlans, fetchWorkflowPlan, createWorkflowPlan, selectWorkflowPlan,
  workflowPlanAction, modifyWorkflowPlan,
} from '../api/index.js'
import { formatCentsToYuan, formatShanghaiDateTime, currentShanghaiYearMonth } from '../utils/format.js'
import SubscriptionOperationConfirmCard from '../components/SubscriptionOperationConfirmCard.vue'
import RepaymentConfirmCard from '../components/RepaymentConfirmCard.vue'

const plans = ref([])
const selectedNo = ref(null)
const detail = ref(null)
const loading = ref(true)
const detailLoading = ref(false)
const busy = ref(false)
const error = ref('')
const actionError = ref('')

const createMonth = ref(currentShanghaiYearMonth())
const selectForm = ref(defaultSelectForm())
const modifyOpen = ref(false)
const modifyForm = ref({})

const STATUS_LABEL = {
  waiting_selection: '等待选择', waiting_confirmation: '等待确认', waiting_verification: '等待强验证',
  paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', manual: '转人工',
}
const NODE_STATUS_LABEL = { pending: '未开始', completed: '已完成', failed: '失败' }
const NODE_TYPE_LABEL = {
  readonly: '只读查询', selection: '选择', mutation: '建单', confirmation: '确认 / 强验证',
  verify: '核验', summary: '汇总',
}
const FLOW_LABEL = { subscription_review: '订阅审查', repayment_review: '信用卡还款审查' }
const ACTION_LABEL = { pause: '暂停订阅', change_source: '更换扣款账户' }

function defaultSelectForm() {
  return {
    subscription_id: null, action: 'pause', to_account_id: null,
    scope: 'statement', statement_id: null, from_account_id: null, credit_account_id: null,
  }
}

function statusText(s) { return STATUS_LABEL[s] || s || '未知' }
function statusTone(s) {
  if (s === 'completed') return 'ok'
  if (['failed', 'cancelled'].includes(s)) return 'bad'
  if (['waiting_confirmation', 'waiting_verification', 'waiting_selection', 'paused', 'manual'].includes(s)) return 'warn'
  return ''
}
function nodeStatusText(s) { return NODE_STATUS_LABEL[s] || s }

const statements = computed(() => {
  const accounts = detail.value?.selectable_credit_accounts || []
  return accounts.flatMap((a) => (a.statements || [])
    .filter((s) => (s.remaining_due_cents ?? 0) > 0)
    .map((s) => ({ ...s, label: `${a.account_name} · ${s.statement_month} 账单（剩余 ${formatCentsToYuan(s.remaining_due_cents)}）` })))
})
const deposits = computed(() => detail.value?.selectable_deposit_accounts || [])
const subscriptions = computed(() => detail.value?.selectable_subscriptions || [])
const credits = computed(() => detail.value?.selectable_credit_accounts || [])

const blockingReasons = computed(() => {
  const out = []
  const d = detail.value
  if (!d) return out
  const errors = d.errors || {}
  for (const [key, message] of Object.entries(errors)) out.push(`查询失败（${key}）：${message}`)
  for (const n of d.nodes || []) {
    if (n.status === 'failed') out.push(`${n.key} 失败：${n.error || '未知原因'}`)
  }
  if (d.status === 'failed') out.push('计划处于失败状态；可重试或转人工处理。')
  return out
})

const opKind = computed(() => {
  if (!detail.value?.op) return null
  return detail.value.flow === 'subscription_review' ? 'subscription' : 'repayment'
})

function planLabel(p) {
  return `${FLOW_LABEL[p.flow] || p.flow} · ${p.plan_no.slice(0, 14)}…`
}
function planSummary(p) {
  if (p.flow === 'subscription_review') return `月份 ${p.params?.month || '—'}`
  return p.params?.scope === 'all_posted' ? '结清全部已入账欠款' : `账单 ${p.params?.statement_month || p.params?.statement_id || '—'}`
}

async function loadList({ keepSelection = true } = {}) {
  loading.value = true
  error.value = ''
  try {
    const rows = await fetchWorkflowPlans()
    plans.value = rows
    if (!keepSelection || !rows.some((p) => p.plan_no === selectedNo.value)) {
      selectedNo.value = rows[0]?.plan_no || null
    }
    if (selectedNo.value) await loadDetail(selectedNo.value)
    else detail.value = null
  } catch (e) {
    error.value = e && e.message ? e.message : '加载计划失败'
  } finally {
    loading.value = false
  }
}

async function loadDetail(planNo) {
  if (!planNo) return
  detailLoading.value = true
  actionError.value = ''
  try {
    detail.value = await fetchWorkflowPlan(planNo)
    applySelectDefaults(detail.value)
  } catch (e) {
    detail.value = null
    actionError.value = e && e.message ? e.message : '加载计划详情失败'
  } finally {
    detailLoading.value = false
  }
}

function applySelectDefaults(d) {
  const next = defaultSelectForm()
  if (d.flow === 'subscription_review') {
    next.subscription_id = subscriptions.value[0]?.id ?? null
    next.to_account_id = deposits.value[0]?.id ?? null
  } else {
    next.statement_id = statements.value[0]?.id ?? null
    next.from_account_id = deposits.value[0]?.id ?? null
    next.credit_account_id = credits.value[0]?.id ?? null
  }
  selectForm.value = next
  modifyForm.value = {
    month: d.params?.month || currentShanghaiYearMonth(),
    action: d.params?.action || 'pause',
    to_account_id: d.params?.to_account_id ?? deposits.value[0]?.id ?? null,
    scope: d.params?.scope || 'statement',
    statement_id: d.params?.statement_id ?? statements.value[0]?.id ?? null,
    from_account_id: d.params?.from_account_id ?? deposits.value[0]?.id ?? null,
    credit_account_id: d.params?.credit_account_id ?? credits.value[0]?.id ?? null,
  }
}

async function choose(planNo) {
  selectedNo.value = planNo
  modifyOpen.value = false
  await loadDetail(planNo)
}

async function run(fn) {
  busy.value = true
  actionError.value = ''
  try {
    await fn()
    await loadList()
  } catch (e) {
    actionError.value = e && e.message ? e.message : '操作失败'
  } finally {
    busy.value = false
  }
}

function createPlan(flow) {
  const params = flow === 'subscription_review' ? { month: createMonth.value } : {}
  run(async () => {
    const view = await createWorkflowPlan({ flow, params })
    selectedNo.value = view.plan_no
  })
}

function buildSelectParams() {
  const d = detail.value
  if (!d) throw new Error('未选择计划')
  if (d.flow === 'subscription_review') {
    if (!selectForm.value.subscription_id) throw new Error('请选择订阅')
    const payload = { subscription_id: Number(selectForm.value.subscription_id), action: selectForm.value.action }
    if (selectForm.value.action === 'change_source') {
      if (!selectForm.value.to_account_id) throw new Error('请选择新的扣款账户')
      payload.to_account_id = Number(selectForm.value.to_account_id)
    }
    return payload
  }
  if (!selectForm.value.from_account_id) throw new Error('请选择付款账户')
  const payload = { scope: selectForm.value.scope, from_account_id: Number(selectForm.value.from_account_id) }
  if (selectForm.value.scope === 'statement') {
    if (!selectForm.value.statement_id) throw new Error('请选择账单')
    payload.statement_id = Number(selectForm.value.statement_id)
  } else if (selectForm.value.credit_account_id) {
    payload.credit_account_id = Number(selectForm.value.credit_account_id)
  }
  return payload
}

function submitSelect() {
  run(async () => {
    await selectWorkflowPlan(detail.value.plan_no, buildSelectParams())
  })
}

function act(action) {
  run(async () => { await workflowPlanAction(detail.value.plan_no, action) })
}

function submitModify() {
  run(async () => {
    const d = detail.value
    let params
    if (d.flow === 'subscription_review') {
      params = { month: modifyForm.value.month, action: modifyForm.value.action }
      if (modifyForm.value.action === 'change_source') params.to_account_id = Number(modifyForm.value.to_account_id)
    } else {
      params = { scope: modifyForm.value.scope }
      if (modifyForm.value.scope === 'statement') params.statement_id = Number(modifyForm.value.statement_id)
      if (modifyForm.value.from_account_id) params.from_account_id = Number(modifyForm.value.from_account_id)
      if (modifyForm.value.credit_account_id) params.credit_account_id = Number(modifyForm.value.credit_account_id)
    }
    await modifyWorkflowPlan(d.plan_no, params)
    modifyOpen.value = false
  })
}

function onOpChanged() {
  loadList()
}

onMounted(() => loadList({ keepSelection: false }))
</script>

<template>
  <div class="view-page plans-page">
    <header class="view-page-head">
      <div>
        <h1 class="view-page-title">计划任务</h1>
        <p class="view-page-subtitle">受约束的跨场景 DAG 计划（新版）。旧的「最近任务」业务记录仍保留在独立入口，两者不混用。</p>
      </div>
      <button class="btn-ghost btn-sm" :disabled="busy || loading" @click="loadList()">刷新</button>
    </header>

    <div v-if="error" class="plans-alert bad">{{ error }}</div>

    <div class="plans-create">
      <div class="plans-create-row">
        <span class="plans-create-title">新建订阅审查</span>
        <input v-model="createMonth" class="plans-input" type="month" aria-label="订阅审查月份" />
        <button class="btn btn-sm" :disabled="busy" @click="createPlan('subscription_review')">创建</button>
      </div>
      <div class="plans-create-row">
        <span class="plans-create-title">新建信用卡还款审查</span>
        <span class="plans-create-hint">从账单与账户中选择并生成强验证还款单</span>
        <button class="btn btn-sm" :disabled="busy" @click="createPlan('repayment_review')">创建</button>
      </div>
    </div>

    <div class="plans-layout">
      <aside class="plans-list" aria-label="计划列表">
        <div v-if="loading" class="plans-empty">加载中…</div>
        <div v-else-if="!plans.length" class="plans-empty">暂无计划。可在上方新建，或通过 AI 助手创建。</div>
        <button
          v-for="p in plans"
          :key="p.plan_no"
          class="plans-item"
          :class="{ 'is-active': p.plan_no === selectedNo }"
          @click="choose(p.plan_no)"
        >
          <span class="plans-item-top">
            <strong>{{ FLOW_LABEL[p.flow] || p.flow }}</strong>
            <span class="plans-badge" :class="statusTone(p.status)">{{ statusText(p.status) }}</span>
          </span>
          <span class="plans-item-sub">{{ planSummary(p) }}</span>
          <span class="plans-item-no">{{ p.plan_no }}</span>
          <span class="plans-item-time">{{ formatShanghaiDateTime(p.updated_at || p.created_at) }}</span>
        </button>
      </aside>

      <section class="plans-detail">
        <div v-if="!detail && !detailLoading" class="plans-empty">选择左侧计划查看依赖、状态与操作入口。</div>
        <div v-else-if="detailLoading" class="plans-empty">加载计划详情…</div>

        <template v-else>
          <div class="plans-detail-head">
            <div>
              <h2 class="plans-detail-title">{{ FLOW_LABEL[detail.flow] || detail.flow }}</h2>
              <div class="plans-detail-meta">
                <span class="plans-badge" :class="statusTone(detail.status)">{{ statusText(detail.status) }}</span>
                <code>{{ detail.plan_no }}</code>
                <span>更新 {{ formatShanghaiDateTime(detail.updated_at) }}</span>
              </div>
            </div>
            <div class="plans-actions">
              <button v-if="detail.status === 'paused'" class="btn btn-sm" :disabled="busy" @click="act('resume')">继续</button>
              <button v-if="!['completed', 'cancelled', 'manual'].includes(detail.status)" class="btn-ghost btn-sm" :disabled="busy" @click="act('pause')">暂停</button>
              <button v-if="detail.status === 'failed'" class="btn btn-sm" :disabled="busy" @click="act('retry')">重试</button>
              <button v-if="!['completed', 'cancelled', 'manual'].includes(detail.status)" class="btn-ghost btn-sm" :disabled="busy" @click="modifyOpen = !modifyOpen">修改</button>
              <button v-if="!['completed', 'cancelled', 'manual'].includes(detail.status)" class="btn-ghost btn-sm" :disabled="busy" @click="act('manual')">转人工</button>
              <button v-if="!['completed', 'cancelled', 'manual'].includes(detail.status)" class="btn-ghost btn-sm danger" :disabled="busy" @click="act('cancel')">取消</button>
            </div>
          </div>

          <div v-if="actionError" class="plans-alert bad">{{ actionError }}</div>
          <div v-if="blockingReasons.length" class="plans-alert warn">
            <strong>当前阻断 / 失败原因</strong>
            <ul><li v-for="(r, i) in blockingReasons" :key="i">{{ r }}</li></ul>
          </div>

          <div v-if="modifyOpen" class="plans-panel">
            <h3 class="plans-panel-title">修改计划参数（未执行步骤）</h3>
            <p class="plans-note">修改会取消原待确认操作单并回到等待选择；已完成的扣款不会被撤销。</p>
            <div v-if="detail.flow === 'subscription_review'" class="plans-form">
              <label>月份 <input v-model="modifyForm.month" class="plans-input" type="month" /></label>
              <label>操作
                <select v-model="modifyForm.action" class="select">
                  <option value="pause">暂停订阅</option>
                  <option value="change_source">更换扣款账户</option>
                </select>
              </label>
              <label v-if="modifyForm.action === 'change_source'">新扣款账户
                <select v-model.number="modifyForm.to_account_id" class="select">
                  <option v-for="a in deposits" :key="a.id" :value="a.id">{{ a.account_name }}</option>
                </select>
              </label>
            </div>
            <div v-else class="plans-form">
              <label>还款范围
                <select v-model="modifyForm.scope" class="select">
                  <option value="statement">指定账单</option>
                  <option value="all_posted">结清全部已入账欠款</option>
                </select>
              </label>
              <label v-if="modifyForm.scope === 'statement'">账单
                <select v-model.number="modifyForm.statement_id" class="select">
                  <option v-for="s in statements" :key="s.id" :value="s.id">{{ s.label }}</option>
                </select>
              </label>
              <label>付款账户
                <select v-model.number="modifyForm.from_account_id" class="select">
                  <option v-for="a in deposits" :key="a.id" :value="a.id">{{ a.account_name }}</option>
                </select>
              </label>
            </div>
            <div class="plans-form-actions">
              <button class="btn btn-sm" :disabled="busy" @click="submitModify">保存修改</button>
              <button class="btn-ghost btn-sm" @click="modifyOpen = false">取消</button>
            </div>
          </div>

          <div v-if="detail.status === 'waiting_selection'" class="plans-panel">
            <h3 class="plans-panel-title">选择下一步业务参数</h3>
            <div v-if="detail.flow === 'subscription_review'" class="plans-form">
              <label>订阅
                <select v-model.number="selectForm.subscription_id" class="select">
                  <option v-for="s in subscriptions" :key="s.id" :value="s.id">{{ s.merchant }}（{{ formatCentsToYuan(s.amount_cents) }} / {{ s.billing_cycle }}）</option>
                </select>
              </label>
              <label>操作
                <select v-model="selectForm.action" class="select">
                  <option value="pause">暂停订阅</option>
                  <option value="change_source">更换扣款账户</option>
                </select>
              </label>
              <label v-if="selectForm.action === 'change_source'">新扣款账户
                <select v-model.number="selectForm.to_account_id" class="select">
                  <option v-for="a in deposits" :key="a.id" :value="a.id">{{ a.account_name }}</option>
                </select>
              </label>
            </div>
            <div v-else class="plans-form">
              <label>还款范围
                <select v-model="selectForm.scope" class="select">
                  <option value="statement">指定账单</option>
                  <option value="all_posted">结清全部已入账欠款</option>
                </select>
              </label>
              <label v-if="selectForm.scope === 'statement'">账单
                <select v-model.number="selectForm.statement_id" class="select">
                  <option v-for="s in statements" :key="s.id" :value="s.id">{{ s.label }}</option>
                </select>
              </label>
              <label v-else>信用卡
                <select v-model.number="selectForm.credit_account_id" class="select">
                  <option v-for="c in credits" :key="c.id" :value="c.id">{{ c.account_name }}</option>
                </select>
              </label>
              <label>付款账户
                <select v-model.number="selectForm.from_account_id" class="select">
                  <option v-for="a in deposits" :key="a.id" :value="a.id">{{ a.account_name }}</option>
                </select>
              </label>
            </div>
            <div class="plans-form-actions">
              <button class="btn btn-sm" :disabled="busy" @click="submitSelect">选择并生成操作单</button>
            </div>
          </div>

          <div v-if="detail.op && opKind === 'subscription'" class="plans-panel">
            <h3 class="plans-panel-title">订阅操作确认</h3>
            <SubscriptionOperationConfirmCard :op="detail.op" @confirmed="onOpChanged" @cancelled="onOpChanged" />
          </div>
          <div v-if="detail.op && opKind === 'repayment'" class="plans-panel">
            <h3 class="plans-panel-title">信用卡还款确认（红色强验证）</h3>
            <RepaymentConfirmCard :op="detail.op" @confirmed="onOpChanged" @cancelled="onOpChanged" />
          </div>

          <div class="plans-panel">
            <h3 class="plans-panel-title">依赖与节点状态</h3>
            <div class="plans-nodes">
              <div v-for="n in detail.nodes" :key="n.key" class="plans-node" :class="n.status">
                <div class="plans-node-main">
                  <strong>{{ n.key }}</strong>
                  <span class="plans-node-type">{{ NODE_TYPE_LABEL[n.type] || n.type }}</span>
                  <span class="plans-badge" :class="n.status === 'completed' ? 'ok' : n.status === 'failed' ? 'bad' : ''">{{ nodeStatusText(n.status) }}</span>
                </div>
                <div class="plans-node-deps">
                  依赖：<template v-if="n.depends_on.length">{{ n.depends_on.join('、') }}</template><template v-else>无</template>
                  <span v-if="n.queried_at"> · 查询于 {{ formatShanghaiDateTime(n.queried_at) }}</span>
                </div>
                <div v-if="n.error" class="plans-node-error">{{ n.error }}</div>
                <pre v-if="n.result" class="plans-node-result">{{ JSON.stringify(n.result, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.plans-page { display: flex; flex-direction: column; gap: 14px; }
.plans-alert { border-radius: 10px; padding: 10px 14px; font-size: 13px; }
.plans-alert.bad { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.plans-alert.warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
.plans-alert ul { margin: 6px 0 0; padding-left: 18px; }
.plans-create { display: flex; flex-wrap: wrap; gap: 10px; }
.plans-create-row { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid var(--border, #e5e7eb); border-radius: 10px; padding: 8px 12px; }
.plans-create-title { font-size: 13px; font-weight: 600; }
.plans-create-hint { font-size: 12px; color: #6b7280; }
.plans-input { border: 1px solid #d1d5db; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; background: #fff; }
.plans-layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 14px; align-items: start; }
.plans-list { display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 240px); overflow: auto; padding-right: 2px; }
.plans-item { text-align: left; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; background: #fff; border: 1px solid var(--border, #e5e7eb); border-radius: 10px; cursor: pointer; }
.plans-item.is-active { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, .12); }
.plans-item-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.plans-item-sub { font-size: 12px; color: #4b5563; }
.plans-item-no { font-size: 11px; color: #9ca3af; word-break: break-all; }
.plans-item-time { font-size: 11px; color: #9ca3af; }
.plans-badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; background: #f3f4f6; color: #4b5563; }
.plans-badge.ok { background: #ecfdf5; color: #047857; }
.plans-badge.bad { background: #fef2f2; color: #b91c1c; }
.plans-badge.warn { background: #fffbeb; color: #92400e; }
.plans-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.plans-detail-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.plans-detail-title { margin: 0; font-size: 18px; }
.plans-detail-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: #6b7280; margin-top: 4px; }
.plans-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plans-actions .danger { color: #b91c1c; }
.plans-panel { background: #fff; border: 1px solid var(--border, #e5e7eb); border-radius: 12px; padding: 12px 14px; }
.plans-panel-title { margin: 0 0 8px; font-size: 14px; }
.plans-note { margin: 0 0 8px; font-size: 12px; color: #6b7280; }
.plans-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.plans-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4b5563; }
.plans-form-actions { display: flex; gap: 8px; margin-top: 10px; }
.plans-empty { padding: 28px 16px; text-align: center; color: #6b7280; font-size: 13px; background: #fff; border: 1px dashed #d1d5db; border-radius: 12px; }
.plans-nodes { display: flex; flex-direction: column; gap: 8px; }
.plans-node { border: 1px solid #e5e7eb; border-radius: 10px; padding: 8px 10px; background: #fcfdff; }
.plans-node.failed { border-color: #fecaca; background: #fff7f7; }
.plans-node.completed { border-color: #bbf7d0; }
.plans-node-main { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
.plans-node-type { font-size: 11px; color: #6b7280; }
.plans-node-deps { font-size: 11px; color: #6b7280; margin-top: 4px; }
.plans-node-error { font-size: 12px; color: #b91c1c; margin-top: 4px; }
.plans-node-result { margin: 6px 0 0; font-size: 11px; color: #4b5563; background: #f8fafc; border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 900px) {
  .plans-layout { grid-template-columns: 1fr; }
  .plans-list { max-height: 260px; }
  .plans-form label { width: 100%; }
  .plans-form .select, .plans-form .plans-input { width: 100%; }
}
</style>
