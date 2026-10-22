<script setup>
// 跨场景任务进度卡：展示当前步骤、等待事项、已完成结果、失败原因与继续入口。
// 所有动作直接调用任务接口；确认步骤复用 SubscriptionOperationConfirmCard（与独立订阅操作同一套规则）。
// 模型回复不决定节点完成：确认后由服务端对账（核验操作单状态 + 业务数据库订阅状态）推进。
import { ref, computed } from 'vue'
import {
  selectAgentTaskSubscription, pauseAgentTask, resumeAgentTask, cancelAgentTask, manualAgentTask,
} from '../api/index.js'
import { formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'

const props = defineProps({
  task: { type: Object, required: true },
})
const emit = defineEmits(['changed'])

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
    <div class="atc-head">
      <div class="atc-title-row">
        <span class="atc-title">跨场景任务 · 订阅审查</span>
        <span v-if="task.month" class="atc-month">{{ task.month }}</span>
      </div>
      <span class="atc-status" :class="statusTone[status] || 'is-muted'">{{ statusText[status] || status }}</span>
    </div>

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

    <!-- 等待确认：复用订阅操作确认卡 -->
    <div v-else-if="waitingConfirmation && task.op && task.op.status !== 'completed'" class="atc-confirm">
      <SubscriptionOperationConfirmCard :op="task.op" @confirmed="onOpChanged" @cancelled="onOpChanged" />
    </div>

    <!-- 已完成：汇总回执（服务端生成，不编造节省金额） -->
    <div v-else-if="status === 'completed' && task.result_summary" class="atc-receipt">
      <p class="atc-receipt-title">已暂停「{{ task.result_summary.merchant }}」</p>
      <dl class="atc-detail">
        <div class="atc-row"><dt>分析月份</dt><dd>{{ task.result_summary.month }}</dd></div>
        <div class="atc-row"><dt>该月支出</dt><dd>{{ formatCentsToYuan(task.result_summary.expense_cents) }} 元</dd></div>
        <div class="atc-row"><dt>订阅每期金额</dt><dd>{{ formatCentsToYuan(task.result_summary.amount_cents) }} 元 / {{ task.result_summary.billing_cycle === 'yearly' ? '按年' : '按月' }}</dd></div>
        <div class="atc-row"><dt>当前状态</dt><dd>已暂停</dd></div>
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
</template>

<style scoped>
.atc {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  background: #fff;
}
.atc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.atc-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.atc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.atc-month {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
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
.atc-confirm { margin-top: 8px; }
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
