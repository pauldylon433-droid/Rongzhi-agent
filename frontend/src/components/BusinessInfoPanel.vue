<script setup>
// 右侧业务信息栏：账户 + 「当前业务」（跟随当前会话最新操作/任务）+ 「历史任务」（本会话较早的业务）。
// 关联方式：真实会话（useChatSession 当前会话消息）+ 结构化工具结果（toolRecords 的 ref_no/task_no）
//           + 任务 ID + 操作引用，绝不解析 AI 回复文字、绝不猜测。
// 「当前业务」为当前会话消息中按顺序最后出现的那条业务事件（转账 / 银行卡操作 / 订阅操作 / 跨场景任务）；
// 状态 / 对象 / 金额 / 周期 / 等待事项 / 结果引用均来自真实接口回读（fetchTransfer / fetchCardOperation /
// fetchSubscriptionOperation / fetchAgentTask），无可靠数据时保留结构化快照、不伪造。
// 切换会话 / 新建对话 / 历史恢复 / 刷新均由 messages 重新推导；异步迟到响应按「key 归属 + 每键最新请求」双重丢弃，
// 不覆盖新业务：key 已不在当前会话事件中 → 丢弃；同一 key 更早发起的响应晚到 → 丢弃。
import { ref, computed, onMounted, watch, reactive } from 'vue'
import {
  fetchAccounts, fetchAgentTask, fetchTransfer, fetchCardOperation, fetchSubscriptionOperation, fetchRepayment,
} from '../api/index.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useTasksSignal } from '../composables/useTasksSignal.js'
import { useTransferSignal } from '../composables/useTransferSignal.js'
import { useCardOpSignal } from '../composables/useCardOpSignal.js'
import { useSubscriptionOpSignal } from '../composables/useSubscriptionOpSignal.js'
import { useRepaymentSignal } from '../composables/useRepaymentSignal.js'
import { useChatSession } from '../composables/useChatSession.js'
import { deriveBusinessEvents } from '../utils/businessEvents.js'
import { createRequestGuard } from '../utils/requestGuard.js'
import { formatMoney, formatCentsToYuan } from '../utils/format.js'

const { sessionId, messages } = useChatSession()

const accounts = ref([])
const loading = ref(true)
const error = ref('')

const KIND_LABEL = { transfer: '转账', card_op: '银行卡操作', subscription_op: '订阅操作', repayment: '信用卡还款', task: '跨场景任务' }
const OP_STATUS_TEXT = {
  pending: '待确认', needs_verification: '需强验证', completed: '已完成',
  cancelled: '已取消', expired: '已过期', failed: '已失效',
}
const TASK_STATUS_TEXT = {
  waiting_selection: '等待选择', waiting_confirmation: '等待确认', completed: '已完成',
  failed: '失败', paused: '已暂停', cancelled: '已取消', manual: '手动处理',
}
const CYCLE_TEXT = { monthly: '按月', yearly: '按年' }
const SUB_ACTION = { pause: '暂停', resume: '恢复', cancel: '取消', change_source: '更换扣款账户' }

const events = computed(() => deriveBusinessEvents(messages.value))
const current = computed(() => events.value[events.value.length - 1] || null)
const history = computed(() => events.value.slice(0, -1).reverse())

// 权威状态缓存：key（ref_no / task_no）→ 接口回读的完整视图
const statusMap = reactive({})

// 每键「最新请求」守卫：同一 key 的多次回读并发（确认后刷新 / 初始加载 / 切换会话重开）时，
// 仅最新发起的那次响应可写入，丢弃旧 pending 晚于 completed 返回的迟到响应。
const guard = createRequestGuard()

const primaryAccount = computed(() => accounts.value[0] || null)

function viewOf(e) {
  return e ? statusMap[e.key] || null : null
}
function statusOf(e) {
  const v = viewOf(e)
  return (v && v.status) || (e && e.status) || ''
}
function kindLabel(e) { return KIND_LABEL[e.kind] || e.kind || '' }
function statusTextFor(e) {
  const s = statusOf(e)
  if (!s) return '—'
  return (e.kind === 'task' ? TASK_STATUS_TEXT[s] : OP_STATUS_TEXT[s]) || s
}
function toneFor(e) {
  const s = statusOf(e)
  if (e.kind === 'task') {
    if (s === 'completed') return 'is-done'
    if (s === 'failed') return 'is-error'
    if (s === 'waiting_selection' || s === 'waiting_confirmation') return 'is-pending'
    return 'is-muted'
  }
  if (s === 'completed') return 'is-done'
  if (s === 'failed') return 'is-error'
  if (s === 'pending' || s === 'needs_verification') return 'is-pending'
  return 'is-muted'
}
function actionText(e) {
  const v = viewOf(e)
  const a = (v && v.action) || (e && e.action) || null
  if (e.kind === 'transfer') return '转账'
  if (e.kind === 'card_op') return a === 'unfreeze' ? '解冻' : '冻结'
  if (e.kind === 'subscription_op') return SUB_ACTION[a] || a || ''
  if (e.kind === 'repayment') return '还款'
  return ''
}
function objectText(e) {
  const v = viewOf(e)
  switch (e.kind) {
    case 'transfer': return (v && v.recipient_name) || e.object || '—'
    case 'card_op': return (v && v.masked_card_number) || e.object || '—'
    case 'subscription_op': return (v && v.merchant) || e.object || '—'
    case 'repayment': return (v && v.credit_account_name) || e.object || '—'
    case 'task': return '订阅审查'
    default: return '—'
  }
}

// —— 当前业务（最新一条）——
const curView = computed(() => viewOf(current.value))
const curStatus = computed(() => statusOf(current.value))
const curStatusText = computed(() => statusTextFor(current.value))
const curTone = computed(() => toneFor(current.value))
const curKind = computed(() => (current.value ? kindLabel(current.value) : ''))
const curObject = computed(() => (current.value ? objectText(current.value) : ''))
const curMonth = computed(() => {
  if (!current.value || current.value.kind !== 'task') return ''
  return (curView.value && curView.value.month) || current.value.month || ''
})
const curMetaLabel = computed(() => {
  if (!current.value) return ''
  if (current.value.kind === 'card_op') return '卡类型'
  if (current.value.kind === 'task') return '订阅'
  if (current.value.kind === 'repayment') return '账期'
  return '金额'
})
const curMeta = computed(() => {
  const e = current.value
  if (!e) return ''
  const v = curView.value
  if (e.kind === 'transfer' || e.kind === 'subscription_op') {
    const c = (v && Number.isInteger(v.amount_cents)) ? v.amount_cents : e.amountCents
    if (c == null) return ''
    const cyc = (v && v.billing_cycle) || e.billingCycle || null
    return `${formatCentsToYuan(c)} 元${cyc ? ' / ' + (CYCLE_TEXT[cyc] || cyc) : ''}`
  }
  if (e.kind === 'card_op') {
    return (v && v.card_type) || e.objectSub || ''
  }
  if (e.kind === 'task') {
    const rs = v && v.result_summary
    const sel = v && v.selected_subscription
    const sub = rs && rs.merchant ? rs : sel
    if (sub && sub.merchant) {
      return `${formatCentsToYuan(sub.amount_cents)} 元${sub.billing_cycle ? ' / ' + (CYCLE_TEXT[sub.billing_cycle] || sub.billing_cycle) : ''}`
    }
    return ''
  }
  if (e.kind === 'repayment') {
    return (v && v.statement_month) || e.objectSub || ''
  }
  return ''
})
const curStageText = computed(() => {
  const e = current.value
  if (!e) return ''
  const v = curView.value
  const s = curStatus.value
  if (e.kind === 'task') {
    const rs = v && v.result_summary
    const sel = v && v.selected_subscription
    switch (s) {
      case 'waiting_selection': return '等待选择：请选择要暂停的一项订阅'
      case 'waiting_confirmation': return sel ? `待确认：请在任务卡确认暂停「${sel.merchant}」` : '待确认：请在任务卡确认暂停'
      case 'completed': return rs && rs.merchant ? `已暂停「${rs.merchant}」` : '任务已完成'
      case 'failed': return (v && v.failure_reason) || '任务失败'
      case 'paused': return '任务已暂停'
      case 'cancelled': return '任务已取消'
      case 'manual': return '已转手动处理'
      default: return s || ''
    }
  }
  const act = actionText(e)
  switch (s) {
    case 'pending': return `待确认${act}`
    case 'needs_verification': return `需交易密码 + 动态验证码强验证${act}`
    case 'completed': return `已完成${act}`
    case 'cancelled': return `已取消${act}`
    case 'expired': return '已过期（未执行）'
    case 'failed': return '已失效（未执行）'
    default: return s || ''
  }
})
const curRef = computed(() => {
  const e = current.value
  if (!e) return ''
  return e.kind === 'task' ? `任务编号 ${e.taskNo}` : `操作编号 ${e.refNo}`
})

async function loadAccounts() {
  try {
    accounts.value = await fetchAccounts()
  } catch (e) {
    error.value = e && e.message ? e.message : '加载账户失败'
  }
}

async function fetchAuthoritative(e) {
  if (!e || !e.key) return
  const token = guard.next(e.key)
  try {
    let view = null
    if (e.kind === 'task') view = await fetchAgentTask(e.taskNo)
    else if (e.kind === 'transfer') view = await fetchTransfer(e.refNo)
    else if (e.kind === 'card_op') view = await fetchCardOperation(e.refNo)
    else if (e.kind === 'subscription_op') view = await fetchSubscriptionOperation(e.refNo)
    else if (e.kind === 'repayment') view = await fetchRepayment(e.refNo)
    // 双重丢弃：本次仍为该 key 最新发起的请求，且该 key 仍属于当前会话事件时才写入。
    // —— 覆盖：同一 key 旧 pending 晚于 completed 返回；切换会话后的旧响应；切换后重开同一 key 的旧响应。
    if (view && guard.isLatest(e.key, token) && events.value.some((x) => x.key === e.key)) {
      statusMap[e.key] = view
    }
  } catch {
    // 回读失败保留结构化快照，不伪造状态
  }
}

async function refreshStatuses() {
  const targets = []
  if (current.value) targets.push(current.value)
  for (const h of history.value.slice(0, 5)) targets.push(h)
  await Promise.all(targets.map((t) => fetchAuthoritative(t)))
}

async function load() {
  loading.value = true
  error.value = ''
  await Promise.all([loadAccounts(), refreshStatuses()])
  loading.value = false
}

onMounted(load)

// 转账 / 银行卡 / 订阅 / 任务状态变化后回读权威状态；账户余额随 dataRefresh 刷新；
// 切换会话 / 新业务随 events 重新推导。
const { version: dataVersion } = useDataRefresh()
const { version: tasksVersion } = useTasksSignal()
const { version: transferVersion } = useTransferSignal()
const { version: cardOpVersion } = useCardOpSignal()
const { version: subOpVersion } = useSubscriptionOpSignal()
const { version: repaymentVersion } = useRepaymentSignal()

watch([events, sessionId, dataVersion, tasksVersion, transferVersion, cardOpVersion, subOpVersion, repaymentVersion], () => {
  loadAccounts()
  refreshStatuses()
})
</script>

<template>
  <aside class="biz-info">
    <p v-if="loading" class="biz-empty">正在加载业务信息…</p>
    <div v-else-if="error" class="biz-error">
      <p>{{ error }}</p>
      <button class="btn-ghost btn-sm" @click="load">重试</button>
    </div>

    <template v-else>
      <!-- 账户 -->
      <div v-if="primaryAccount" class="biz-block">
        <h4 class="biz-title">账户</h4>
        <div class="biz-account">
          <span class="biz-account-name">{{ primaryAccount.account_name }}（{{ primaryAccount.currency }}）</span>
          <span class="biz-account-balance">{{ formatMoney(primaryAccount.balance_cents, primaryAccount.currency) }}</span>
        </div>
      </div>

      <!-- 当前业务（跟随当前会话最新操作 / 任务） -->
      <div class="biz-block">
        <h4 class="biz-title">当前业务</h4>
        <div v-if="current" class="biz-now">
          <div class="biz-now-head">
            <span class="biz-now-kind">{{ curKind }}</span>
            <span v-if="curMonth" class="biz-now-month">{{ curMonth }}</span>
            <span class="biz-now-status" :class="curTone">{{ curStatusText }}</span>
          </div>

          <div class="biz-node">
            <span class="biz-node-label">对象</span>
            <span class="biz-node-value">{{ curObject }}</span>
          </div>
          <div v-if="curMeta" class="biz-node">
            <span class="biz-node-label">{{ curMetaLabel }}</span>
            <span class="biz-node-value">{{ curMeta }}</span>
          </div>

          <!-- 等待事项 / 结果（以接口回读的真实状态为准） -->
          <div class="biz-stage" :class="curTone">
            <span class="biz-stage-text">{{ curStageText }}</span>
            <span v-if="curRef" class="biz-stage-hint mono">{{ curRef }}</span>
          </div>
        </div>
        <p v-else class="biz-empty">当前对话暂无业务操作。</p>
      </div>

      <!-- 历史任务（本会话较早的业务，与当前业务区分） -->
      <div v-if="history.length" class="biz-block">
        <h4 class="biz-title">历史任务</h4>
        <ul class="biz-tasks">
          <li v-for="h in history" :key="h.key" class="biz-task-row">
            <span class="biz-task-kind">{{ kindLabel(h) }}</span>
            <span class="biz-task-name">{{ objectText(h) }}</span>
            <span class="biz-task-status" :class="toneFor(h)">{{ statusTextFor(h) }}</span>
          </li>
        </ul>
      </div>

      <p class="biz-queried">数据均为模拟，仅供演示；状态以服务端接口回读为准。</p>
    </template>
  </aside>
</template>

<style scoped>
.biz-info {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  font-size: 14px;
}
.biz-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.biz-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.biz-error p {
  margin: 0;
  color: #b91c1c;
  font-size: 13px;
}
.btn-sm {
  padding: 3px 10px;
  font-size: 12px;
}
.biz-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.biz-block:last-of-type {
  border-bottom: none;
}
.biz-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.biz-account {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.biz-account-name {
  color: var(--text);
}
.biz-account-balance {
  font-size: 18px;
  font-weight: 700;
  color: var(--navy);
  font-variant-numeric: tabular-nums;
}

/* 当前业务 */
.biz-now {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.biz-now-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.biz-now-kind {
  color: var(--text);
  font-weight: 600;
}
.biz-now-month {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.biz-now-status {
  margin-left: auto;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
.biz-now-status.is-done { background: #dcfce7; color: #15803d; }
.biz-now-status.is-pending { background: #fef3c7; color: #92400e; }
.biz-now-status.is-error { background: #fee2e2; color: #b91c1c; }
.biz-now-status.is-muted { background: #f1f5f9; color: #64748b; }
.biz-node {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.biz-node-label { color: var(--muted); flex-shrink: 0; }
.biz-node-value { color: var(--text); font-variant-numeric: tabular-nums; word-break: break-all; text-align: right; }
.biz-stage {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f8fafc;
  border: 1px solid var(--border);
}
.biz-stage.is-done { background: #f0fdf4; border-color: #bbf7d0; }
.biz-stage.is-pending { background: #fffbeb; border-color: #fde68a; }
.biz-stage.is-error { background: #fef2f2; border-color: #fecaca; }
.biz-stage-text { color: var(--text); font-weight: 600; }
.biz-stage.is-done .biz-stage-text { color: #15803d; }
.biz-stage.is-error .biz-stage-text { color: #b91c1c; }
.biz-stage-hint { color: var(--muted); font-size: 12px; }
.biz-stage-hint.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.biz-tasks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.biz-task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.biz-task-kind {
  color: var(--muted);
  flex-shrink: 0;
  font-size: 12px;
}
.biz-task-name {
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.biz-task-status {
  color: var(--muted);
  flex-shrink: 0;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
}
.biz-task-status.is-done { background: #dcfce7; color: #15803d; }
.biz-task-status.is-pending { background: #fef3c7; color: #92400e; }
.biz-task-status.is-error { background: #fee2e2; color: #b91c1c; }
.biz-task-status.is-muted { background: #f1f5f9; color: #64748b; }
.biz-queried {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
