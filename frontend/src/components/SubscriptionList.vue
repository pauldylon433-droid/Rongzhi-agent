<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchSubscriptions, fetchCards, createSubscriptionOperation } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import SectionState from './SectionState.vue'
import MerchantLogo from './MerchantLogo.vue'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'

const { data, loading, error, load } = useAsyncData(fetchSubscriptions)
const { version } = useDataRefresh()

const op = ref(null) // 当前订阅操作单初始视图（确认卡组件内部回读最新状态）
const creating = ref(false)
const opError = ref('')

onMounted(load)

// 任何一处完成暂停 / 恢复 / 取消后，订阅列表自动回读最新状态（保持当前筛选不变）
watch(version, () => {
  load()
})

const statusText = { active: '生效', paused: '暂停', cancelled: '已取消' }
const cycleText = { monthly: '按月', yearly: '按年' }
function statusTone(status) {
  return { active: 'is-ok', paused: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}
function cycleLabel(cycle) {
  return cycleText[cycle] || cycle || '—'
}

// —— 按状态筛选（仅前端完整列表过滤；接口返回完整列表、无分页）——
const subStatusFilter = ref('') // '' = 全部

// 状态枚举与后端一致（active / paused / cancelled），不按商户名、扣费日期或金额猜测
const SUB_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'active', label: '生效' },
  { value: 'paused', label: '暂停' },
  { value: 'cancelled', label: '已取消' },
]

// 按状态筛选，保持接口原有记录顺序；未知状态仅在「全部」中展示（statusText 兜底「未知状态」）
const filteredSubs = computed(() => {
  const list = data.value || []
  return subStatusFilter.value === '' ? list : list.filter((s) => s.status === subStatusFilter.value)
})

// 当前上海日期（YYYY-MM-DD，用于判断原扣费日期是否已过）
function shanghaiTodayStr() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// 扣费日期文案：不编造日期；暂停 / 取消不提示「即将扣费」；生效但原扣费日期已过 → 待更新。
function dateText(s) {
  if (s.status === 'cancelled') return '已取消，不再扣费'
  if (s.status === 'paused') return '已暂停，不自动扣费'
  const d = s.next_billing_date ? formatShanghaiDate(s.next_billing_date) : ''
  if (!d || d < shanghaiTodayStr()) return '扣费日期待更新'
  return `下次扣费 ${d}`
}

const isEmptyAll = computed(() => !loading.value && !error.value && !(data.value && data.value.length))
const isEmptyFilter = computed(() => !loading.value && !error.value && !isEmptyAll.value && filteredSubs.value.length === 0)
const emptyText = computed(() => (isEmptyFilter.value ? '该状态下暂无订阅' : '暂无订阅'))

async function onAction(sub, action) {
  opError.value = ''
  creating.value = true
  try {
    op.value = await createSubscriptionOperation({ subscription_id: sub.id, action })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成操作单失败'
  } finally {
    creating.value = false
  }
}

function onDone() {
  op.value = null
  opError.value = ''
  sourceSub.value = null
  toAccountId.value = null
  load() // 立即回读订阅列表，展示最新状态
}

function dismiss() {
  op.value = null
  opError.value = ''
  sourceSub.value = null
  sourceError.value = ''
}

// —— 更换扣款账户面板（只准备操作单，不扣款、不改变订阅状态）——
const sourceSub = ref(null)
const sourceCards = ref([])
const sourceLoading = ref(false)
const sourceError = ref('')
const toAccountId = ref(null)
const sourceCreating = ref(false)

const selectedSource = computed(() => sourceCards.value.find((c) => c.account_id === toAccountId.value) || null)
const sourceAvailableCents = computed(() => {
  const c = selectedSource.value
  if (!c) return null
  return c.account_type === 'credit' ? c.available_credit_cents : c.balance_cents
})
const sourceRiskHint = computed(() => {
  if (!sourceSub.value || sourceAvailableCents.value === null) return ''
  return sourceAvailableCents.value < sourceSub.value.amount_cents
    ? '当前可用金额低于本期扣款金额，未来扣款可能失败；实际以扣款时余额 / 额度为准。'
    : ''
})

async function openSourcePanel(sub) {
  opError.value = ''
  op.value = null
  sourceSub.value = sub
  toAccountId.value = null
  sourceCards.value = []
  sourceError.value = ''
  sourceLoading.value = true
  try {
    const cards = await fetchCards()
    // 仅本人、卡与账户状态正常；排除当前来源（避免生成无意义操作单）
    sourceCards.value = (cards || []).filter(
      (c) => c.status === 'active' && c.account_status === 'active' && c.account_id !== sub.account_id,
    )
  } catch (e) {
    sourceError.value = e && e.message ? e.message : '加载可用扣款来源失败'
  } finally {
    sourceLoading.value = false
  }
}

function closeSourcePanel() {
  sourceSub.value = null
  toAccountId.value = null
  sourceError.value = ''
}

async function submitSourceChange() {
  if (!sourceSub.value || !toAccountId.value) return
  opError.value = ''
  sourceCreating.value = true
  try {
    op.value = await createSubscriptionOperation({
      subscription_id: sourceSub.value.id,
      action: 'change_source',
      to_account_id: toAccountId.value,
    })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成更换操作单失败'
  } finally {
    sourceCreating.value = false
  }
}

// 来源展示：账户名 + 卡种 + 脱敏尾号；缺失时明确「未设置扣款账户」，不回退到第一张卡
function sourceText(s) {
  if (!s.account_name) return '未设置扣款账户'
  const card = s.masked_card_number ? `${s.card_type || '银行卡'} ${s.masked_card_number}` : '无可用银行卡'
  return `${s.account_name} · ${card}`
}
function sourceFrozen(s) {
  return s.card_status === 'frozen' || s.account_status === 'frozen' || s.account_status === 'closed'
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">订阅与代扣</h2>
      <div class="filter">
        <label class="filter-label">状态</label>
        <select v-model="subStatusFilter" class="select" aria-label="订阅状态">
          <option v-for="o in SUB_STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
    </div>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="isEmptyAll || isEmptyFilter"
      :empty-text="emptyText"
      @retry="load"
    />

    <ul v-if="!loading && !error && filteredSubs.length" class="sub-list">
      <li v-for="s in filteredSubs" :key="s.id" class="sub-item">
        <div class="sub-main">
          <span class="sub-merchant">
            <MerchantLogo :merchant="s.merchant" :size="26" />
            <span>{{ s.merchant }}</span>
          </span>
          <span class="sub-meta">
            {{ formatCentsToYuan(s.amount_cents) }} 元 / {{ cycleLabel(s.billing_cycle) }}
          </span>
          <span class="sub-source" :class="{ 'is-warn': sourceFrozen(s) }">
            扣款账户：{{ sourceText(s) }}<template v-if="sourceFrozen(s)">（当前来源已冻结 / 失效，未来扣款可能失败）</template>
          </span>
        </div>
        <div class="sub-side">
          <span class="sub-date">{{ dateText(s) }}</span>
          <span class="status-badge" :class="statusTone(s.status)">
            {{ statusText[s.status] || '未知状态' }}
          </span>
          <div v-if="s.status !== 'cancelled'" class="sub-actions">
            <button
              v-if="s.status === 'active' || s.status === 'paused'"
              class="sub-btn sub-btn-ghost"
              :disabled="creating"
              @click="openSourcePanel(s)"
            >
              更换扣款账户
            </button>
            <button
              v-if="s.status === 'active'"
              class="sub-btn"
              :disabled="creating"
              @click="onAction(s, 'pause')"
            >
              暂停
            </button>
            <button
              v-else-if="s.status === 'paused'"
              class="sub-btn sub-btn-warn"
              :disabled="creating"
              @click="onAction(s, 'resume')"
            >
              恢复
            </button>
            <button
              class="sub-btn sub-btn-ghost"
              :disabled="creating"
              @click="onAction(s, 'cancel')"
            >
              取消
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 更换扣款账户面板：只准备操作单，不扣款、不改变订阅状态 -->
    <div v-if="sourceSub && !op" class="source-panel">
      <div class="source-head">
        <span class="source-title">更换扣款账户 · {{ sourceSub.merchant }}</span>
        <button class="btn-ghost btn-sm" @click="closeSourcePanel">关闭</button>
      </div>
      <p class="source-meta">
        每期 {{ formatCentsToYuan(sourceSub.amount_cents) }} 元 / {{ cycleLabel(sourceSub.billing_cycle) }}
      </p>
      <p class="source-current">当前来源：{{ sourceText(sourceSub) }}</p>
      <p v-if="sourceFrozen(sourceSub)" class="source-warn">
        当前扣款来源已冻结或失效。本操作只更新未来扣款的来源，不会自动换卡或恢复订阅。
      </p>

      <p v-if="sourceLoading" class="source-hint">正在加载可用来源…</p>
      <p v-else-if="sourceError" class="source-warn">{{ sourceError }}</p>
      <template v-else>
        <label class="source-field">
          <span class="source-label">新扣款账户</span>
          <select v-model="toAccountId" class="select" aria-label="新扣款账户">
            <option :value="null" disabled>请选择新的扣款账户</option>
            <option v-for="c in sourceCards" :key="c.id" :value="c.account_id">
              {{ c.account_name }}（{{ c.card_type }} {{ c.masked_card_number }}）·
              {{ c.account_type === 'credit'
                ? `可用额度 ${formatCentsToYuan(c.available_credit_cents)} 元 · 信用支付`
                : `可用余额 ${formatCentsToYuan(c.balance_cents)} 元` }}
            </option>
          </select>
        </label>
        <p v-if="!sourceCards.length" class="source-hint">没有其他可用的借记卡或信用卡来源。</p>
        <p v-if="sourceRiskHint" class="source-warn">{{ sourceRiskHint }}</p>
        <p class="source-note">
          更换仅更新未来模拟扣款的来源，不扣款、不改变订阅状态与历史流水；需交易密码 + 动态验证码确认。
        </p>
        <button class="btn" :disabled="!toAccountId || sourceCreating" @click="submitSourceChange">
          {{ sourceCreating ? '生成中…' : '生成更换操作单' }}
        </button>
      </template>
    </div>

    <!-- 共享确认卡（确认 / 强验证规则与聊天入口一致） -->
    <p v-if="opError" class="op-error">{{ opError }}</p>
    <SubscriptionOperationConfirmCard v-if="op" :op="op" @confirmed="onDone" @cancelled="onDone" />
    <button v-if="op" class="btn-ghost dismiss-btn" @click="dismiss">关闭</button>
  </section>
</template>

<style scoped>
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.section-head .section-title {
  margin: 0;
}
.filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 13px;
  color: var(--muted);
}
.sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sub-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.sub-item:last-child {
  border-bottom: none;
}
.sub-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sub-merchant {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text);
}
.sub-meta {
  font-size: 13px;
  color: var(--muted);
}
.sub-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}
.sub-date {
  font-size: 12px;
  color: var(--muted);
}
.sub-actions {
  display: flex;
  gap: 8px;
}
.sub-btn {
  border: 1px solid var(--blue);
  background: #fff;
  color: var(--blue);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.sub-btn:hover:not(:disabled) {
  background: var(--blue-light);
}
.sub-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.sub-btn-warn {
  border-color: #b45309;
  color: #b45309;
}
.sub-btn-warn:hover:not(:disabled) {
  background: #fef3c7;
}
.sub-btn-ghost {
  border-color: #b91c1c;
  color: #b91c1c;
}
.sub-btn-ghost:hover:not(:disabled) {
  background: #fee2e2;
}
.op-error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #b91c1c;
}
.dismiss-btn {
  margin-top: 12px;
}

.sub-source {
  font-size: 12px;
  color: var(--muted);
}
.sub-source.is-warn {
  color: #b45309;
}
.source-panel {
  margin-top: 16px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 520px;
}
.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.source-title {
  font-weight: 600;
  color: var(--text);
}
.source-meta,
.source-current {
  margin: 0;
  font-size: 13px;
  color: var(--text);
}
.source-current {
  color: var(--muted);
}
.source-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.source-label {
  font-size: 13px;
  color: var(--muted);
}
.source-hint {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.source-warn {
  margin: 0;
  padding: 8px 10px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  font-size: 12px;
  color: #b91c1c;
}
.source-note {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
