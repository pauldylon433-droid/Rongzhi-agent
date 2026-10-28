<script setup>
// 跨场景任务进度卡：展示当前步骤、等待事项、已完成结果、失败原因与继续入口。
// 所有动作直接调用任务接口；确认步骤复用 SubscriptionOperationConfirmCard（与独立订阅操作同一套规则）。
// 模型回复不决定节点完成：确认后由服务端对账（核验操作单状态 + 业务数据库订阅状态）推进。
//
// 可折叠：折叠条仅显示任务名称、真实状态、简短等待事项与「展开详情」，高度尽量一行。
// 折叠 / 展开仅切换本地展示（v-show），不触发暂停 / 取消 / 继续 / 确认，也不重新创建任务、重复请求或丢失状态。
import { ref, computed } from 'vue'
import {
  selectAgentTaskSubscription, pauseAgentTask, resumeAgentTask, cancelAgentTask, manualAgentTask,
} from '../api/index.js'
import { formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'

const props = defineProps({
  task: { type: Object, required: true },
  expanded: { type: Boolean, default: false },
})
const emit = defineEmits(['changed', 'toggle'])

const acting = ref(false)
const actionError = ref('')

const statusText = {
  waiting_selection: '等待选择',
  waiting_confirmation: '等待确认',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
  manual: '手动处理',
}
const statusTone = {
  waiting_selection: 'is-pending',
  waiting_confirmation: 'is-pending',
  completed: 'is-done',
  failed: 'is-error',
  paused: 'is-muted',
  cancelled: 'is-muted',
  manual: 'is-muted',
}

const task = computed(() => props.task)
const status = computed(() => (task.value && task.value.status) || '')

function nodeResult(key) {
  const n = (task.value && task.value.nodes || []).find((x) => x.node_key === key)
  return n && n.result ? n.result : null
}
const monthly = computed(() => nodeResult('monthly_analysis'))
const subQuery = computed(() => nodeResult('subscription_query'))

// 完成时状态（以任务完成时写入的 result_summary 快照为准，不冒充实时状态）
const SUB_STATUS_TEXT = { active: '生效中', paused: '已暂停', cancelled: '已取消' }
const completedStateText = computed(() => {
  const rs = task.value && task.value.result_summary
  if (!rs) return '—'
  if (rs.action === 'pause') return '已暂停'
  return SUB_STATUS_TEXT[rs.subscription_status] || rs.subscription_status || '—'
})
const completedAtText = computed(() => {
  const at = task.value && task.value.completed_at
  return at ? formatShanghaiDateTime(at) : ''
})

// 折叠条上的简短等待事项 / 结果摘要（不冒充「已开始 / 已完成」）
const collapsedSummary = computed(() => {
  const sel = task.value && task.value.selected_subscription && task.value.selected_subscription.merchant
  const done = task.value && task.value.result_summary && task.value.result_summary.merchant
  switch (status.value) {
    case 'waiting_selection': return '待选择要暂停的订阅'
    case 'waiting_confirmation': return sel ? `待确认暂停「${sel}」` : '待确认暂停订阅'
    case 'completed': return done ? `已暂停「${done}」` : '任务已完成'
    case 'failed': return (task.value && task.value.failure_reason) || '任务失败'
    case 'paused': return '任务已暂停'
    case 'cancelled': return '任务已取消'
    case 'manual': return '已转手动处理'
    default: return ''
  }
})

// 五步可视化进度：映射服务端白名单节点（分析账单→查询订阅→选择订阅→等待确认→核验回执）。
// 仅依据节点真实完成状态与任务状态推导，不伪造进度。
function nodeStatus(key) {
  const n = (task.value && task.value.nodes || []).find((x) => x.node_key === key)
  return n ? n.status : 'pending'
}
const steps = computed(() => {
  const st = status.value
  const done1 = nodeStatus('monthly_analysis') === 'completed'
  const done2 = nodeStatus('subscription_query') === 'completed'
  const done3 = nodeStatus('await_selection') === 'completed' || st === 'waiting_confirmation' || st === 'completed'
  const done4 = nodeStatus('await_confirmation') === 'completed' || st === 'completed'
  const done5 = st === 'completed'
  const activeIdx = st === 'waiting_selection' ? 2 : st === 'waiting_confirmation' ? 3 : -1
  return [
    { label: '分析账单', done: done1 },
    { label: '查询订阅', done: done2 },
    { label: '选择订阅', done: done3 },
    { label: '等待确认', done: done4 },
    { label: '核验回执', done: done5 },
  ].map((s, i) => ({ ...s, active: i === activeIdx }))
})

const isTerminal = computed(() => ['completed', 'cancelled', 'manual'].includes(status.value))
const isPaused = computed(() => status.value === 'paused')
const isFailed = computed(() => status.value === 'failed')
const waitingSelection = computed(() => status.value === 'waiting_selection')
const waitingConfirmation = computed(() => status.value === 'waiting_confirmation')

const stepText = computed(() => {
  switch (status.value) {
    case 'waiting_selection': return '请选择要暂停的一项生效订阅'
    case 'waiting_confirmation': {
      const m = task.value && task.value.selected_subscription && task.value.selected_subscription.merchant
      return m ? `请在下方确认暂停「${m}」` : '请在下方确认暂停订阅'
    }
    case 'completed': return '任务已完成'
    case 'failed': return '任务已失败'
    case 'paused': return '任务已暂停'
    case 'cancelled': return '任务已取消'
    case 'manual': return '已转手动处理'
    default: return ''
  }
})

async function run(fn) {
  actionError.value = ''
  acting.value = true
  try {
    await fn()
  } catch (e) {
    actionError.value = e && e.message ? e.message : '操作失败'
  } finally {
    acting.value = false
  }
}

async function onSelect(sub) {
  await run(async () => {
    await selectAgentTaskSubscription(task.value.task_no, sub.id)
    emit('changed')
  })
}
async function onPause() {
  await run(async () => {
    await pauseAgentTask(task.value.task_no)
    emit('changed')
  })
}
async function onResume() {
  await run(async () => {
    await resumeAgentTask(task.value.task_no)
    emit('changed')
  })
}
async function onCancel() {
  await run(async () => {
    await cancelAgentTask(task.value.task_no)
    emit('changed')
  })
}
async function onManual() {
  await run(async () => {
    await manualAgentTask(task.value.task_no)
    emit('changed')
  })
}

// 确认卡上的「确认暂停 / 取消」回调：业务状态已变化，通知父级重新拉取（服务端对账推进任务）
function onOpChanged() {
  emit('changed')
}
</script>

<template>
  <div v-if="task" class="atc">
    <!-- 折叠条：单行任务名 + 真实状态 + 简短待办 + 展开/收起（点击不触发任何任务动作） -->
    <button
      type="button"
      class="atc-toggle-head"
      :aria-expanded="expanded ? 'true' : 'false'"
      @click="emit('toggle')"
    >
      <span class="atc-title-row">
        <span class="atc-title">跨场景任务 · 订阅审查</span>
        <span v-if="task.month" class="atc-month">{{ task.month }}</span>
      </span>
      <span class="atc-head-right">
        <span class="atc-status" :class="statusTone[status] || 'is-muted'">{{ statusText[status] || status }}</span>
        <span v-if="isTerminal" class="atc-history">历史任务</span>
        <span v-if="!expanded && collapsedSummary" class="atc-summary">{{ collapsedSummary }}</span>
        <span class="atc-toggle" aria-hidden="true">{{ expanded ? '收起' : '展开详情' }}</span>
      </span>
    </button>

    <!-- 展开区：进度、快照、订阅选择、确认卡、完整回执 / 失败详情 / 操作入口 -->
    <div v-show="expanded" class="atc-body">
      <ol class="atc-steps">
        <li v-for="(s, i) in steps" :key="i" class="atc-step-item" :class="{ 'is-done': s.done, 'is-active': s.active }">
          <span class="atc-step-dot">{{ s.done ? '✓' : i + 1 }}</span>
          <span class="atc-step-label">{{ s.label }}</span>
        </li>
      </ol>

      <p class="atc-step">{{ stepText }}</p>

      <!-- 已完成结果：月度分析快照 + 生效订阅（标明月份与时间，不冒充实时） -->
      <div v-if="monthly || subQuery" class="atc-results">
        <div v-if="monthly" class="atc-result">
          <span class="atc-result-label">{{ monthly.month }} 支出</span>
          <b class="atc-result-value">{{ formatCentsToYuan(monthly.expense_cents) }} 元（{{ monthly.posted_count }} 笔已入账）</b>
          <span class="atc-result-note">快照于 {{ formatShanghaiDateTime(monthly.as_of) }}</span>
        </div>
        <div v-if="subQuery" class="atc-result">
          <span class="atc-result-label">生效订阅</span>
          <b class="atc-result-value">{{ subQuery.count }} 项</b>
          <span class="atc-result-note">快照于 {{ formatShanghaiDateTime(subQuery.as_of) }}</span>
        </div>
      </div>

      <!-- 等待选择：列出可选择的生效订阅（以实时业务状态为准） -->
      <div v-if="waitingSelection" class="atc-select">
        <p v-if="!task.selectable_subscriptions || !task.selectable_subscriptions.length" class="atc-empty">
          当前没有生效中的订阅可暂停。
        </p>
        <button
          v-for="s in task.selectable_subscriptions"
          :key="s.id"
          class="atc-select-item"
          :disabled="acting"
          @click="onSelect(s)"
        >
          <span>{{ s.merchant }}</span>
          <span class="atc-select-meta">{{ formatCentsToYuan(s.amount_cents) }} 元 / {{ s.billing_cycle === 'yearly' ? '按年' : '按月' }}</span>
          <span class="atc-select-act">选择并暂停</span>
        </button>
      </div>

      <!-- 等待确认：复用订阅操作确认卡（橙色边框 + 提示，明确这是跨场景任务确认） -->
      <div v-else-if="waitingConfirmation && task.op" class="atc-confirm">
        <p class="atc-confirm-hint">跨场景任务确认：确认后由系统核验操作单与订阅状态，核验通过才判定任务完成。</p>
        <SubscriptionOperationConfirmCard :op="task.op" @confirmed="onOpChanged" @cancelled="onOpChanged" />
      </div>

      <!-- 已完成：汇总回执（服务端生成，不编造节省金额） -->
      <div v-else-if="status === 'completed' && task.result_summary" class="atc-receipt">
        <p class="atc-receipt-title">已暂停「{{ task.result_summary.merchant }}」</p>
        <dl class="atc-detail">
          <div class="atc-row"><dt>分析月份</dt><dd>{{ task.result_summary.month }}</dd></div>
          <div class="atc-row"><dt>该月支出</dt><dd>{{ formatCentsToYuan(task.result_summary.expense_cents) }} 元</dd></div>
          <div class="atc-row"><dt>订阅每期金额</dt><dd>{{ formatCentsToYuan(task.result_summary.amount_cents) }} 元 / {{ task.result_summary.billing_cycle === 'yearly' ? '按年' : '按月' }}</dd></div>
          <div class="atc-row"><dt>完成时状态</dt><dd>{{ completedStateText }}</dd></div>
          <div v-if="completedAtText" class="atc-row"><dt>完成时间</dt><dd>{{ completedAtText }}</dd></div>
          <div class="atc-row"><dt>操作编号</dt><dd class="mono">{{ task.result_summary.op_ref }}</dd></div>
        </dl>
        <p class="atc-note">{{ task.result_summary.note }}</p>
      </div>

      <!-- 失败：失败原因 + 安全继续入口 -->
      <div v-else-if="isFailed" class="atc-failed">
        <p class="atc-failed-text">{{ task.failure_reason || '任务失败' }}</p>
      </div>

      <p v-if="actionError" class="atc-error">{{ actionError }}</p>

      <!-- 操作入口 -->
      <div class="atc-actions">
        <button v-if="waitingSelection || waitingConfirmation" class="btn-ghost" :disabled="acting" @click="onPause">
          暂停任务
        </button>
        <button v-if="isPaused || isFailed" class="btn" :disabled="acting" @click="onResume">
          继续
        </button>
        <button v-if="!isTerminal" class="btn-ghost" :disabled="acting" @click="onCancel">
          取消任务
        </button>
        <button v-if="!isTerminal" class="btn-ghost" :disabled="acting" @click="onManual">
          转手动处理
        </button>
      </div>

      <p v-if="status === 'manual'" class="atc-manual">已转手动处理，请在「订阅与代扣」分区自行操作暂停 / 取消。</p>
    </div>
  </div>
</template>

<style scoped>
.atc {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
}
.atc-toggle-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}
.atc-toggle-head:hover { background: #f8fafc; }
.atc-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex-shrink: 1;
}
.atc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.atc-month {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.atc-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.atc-status {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
.atc-status.is-done { background: #dcfce7; color: #15803d; }
.atc-status.is-pending { background: #fef3c7; color: #92400e; }
.atc-status.is-error { background: #fee2e2; color: #b91c1c; }
.atc-status.is-muted { background: #f1f5f9; color: #64748b; }
.atc-history {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #4338ca;
  white-space: nowrap;
}
.atc-summary {
  font-size: 13px;
  color: #475569;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
}
.atc-toggle {
  font-size: 13px;
  color: var(--blue);
  font-weight: 500;
  white-space: nowrap;
}
.atc-body {
  padding: 2px 14px 14px;
  border-top: 1px solid var(--border);
}
.atc-steps {
  list-style: none;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 12px 0 12px;
  padding: 0;
  flex-wrap: wrap;
}
.atc-step-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 58px;
}
.atc-step-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: #e2e8f0;
  color: #64748b;
}
.atc-step-item.is-done .atc-step-dot {
  background: #dcfce7;
  color: #15803d;
}
.atc-step-item.is-active .atc-step-dot {
  background: var(--blue);
  color: #fff;
}
.atc-step-label {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.atc-step-item.is-active .atc-step-label {
  color: var(--blue);
  font-weight: 600;
}
.atc-step {
  margin: 0 0 10px;
  font-size: 13px;
  color: #475569;
}
.atc-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.atc-result {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.atc-result-label { color: var(--muted); }
.atc-result-value { color: var(--navy); font-variant-numeric: tabular-nums; }
.atc-result-note { color: var(--muted); font-size: 12px; }
.atc-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}
.atc-select-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  text-align: left;
}
.atc-select-item:hover:not(:disabled) { border-color: var(--blue); background: #f8fafc; }
.atc-select-item:disabled { opacity: 0.6; cursor: not-allowed; }
.atc-select-meta { color: var(--muted); font-size: 13px; }
.atc-select-act { color: var(--blue); font-weight: 600; font-size: 13px; white-space: nowrap; }
.atc-empty { margin: 0; font-size: 13px; color: var(--muted); }
.atc-confirm {
  margin-top: 8px;
  padding: 12px;
  border: 1px solid #fdba74;
  border-radius: 10px;
  background: #fff7ed;
}
.atc-confirm-hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: #9a3412;
}
.atc-receipt { border: 1px solid #bbf7d0; background: #f0fdf4; border-radius: 8px; padding: 12px; }
.atc-receipt-title { margin: 0 0 10px; font-size: 15px; font-weight: 700; color: #15803d; }
.atc-detail { margin: 0; }
.atc-row { display: flex; gap: 12px; padding: 4px 0; font-size: 13px; }
.atc-row dt { flex-shrink: 0; width: 88px; color: var(--muted); }
.atc-row dd { margin: 0; color: var(--text); word-break: break-all; }
.atc-row .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.atc-note { margin: 10px 0 0; font-size: 12px; color: #166534; }
.atc-failed { margin: 8px 0; padding: 10px 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; }
.atc-failed-text { margin: 0; font-size: 13px; color: #b91c1c; }
.atc-error { margin: 8px 0 0; font-size: 13px; color: #b91c1c; }
.atc-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.atc-manual { margin: 10px 0 0; font-size: 13px; color: #64748b; }
</style>
