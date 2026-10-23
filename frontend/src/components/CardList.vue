<script setup>
// 银行卡：区分借记卡 / 信用卡。
// - 借记卡：展示关联活期账户余额（不套用信用语义），并提供「按该账户筛选」驱动总览 / 流水 / 月度按账户过滤。
// - 信用卡：展示额度 / 已入账未还 / 待入账占用 / 可用额度 + 账单 + 还款（不展示「存款余额」）。
// 冻结 / 解冻复用现有操作单流程；信用卡冻结期间禁止新增消费、仍可还款（见 CreditCardDetail）。
import { ref, computed, onMounted, watch } from 'vue'
import { fetchCards, fetchAccounts, createCardOperation } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useCardSelection } from '../composables/useCardSelection.js'
import { formatCentsToYuan } from '../utils/format.js'
import {
  accountsIndex, isFiniteCents, isDepositCard, resolveAccountName, resolveDebitBalance,
} from '../utils/cardBalance.js'
import SectionState from './SectionState.vue'
import CardOperationConfirmCard from './CardOperationConfirmCard.vue'
import CreditCardDetail from './CreditCardDetail.vue'

const { data, loading, error, load } = useAsyncData(fetchCards)
const { version } = useDataRefresh()
const { selectedCard, selectedCardId, select, clear } = useCardSelection()

// 旧接口兼容：仅当卡片接口缺少可用余额时，才按 account_id 关联账户接口（不重复请求）。
const accountsById = ref(new Map())
const accountsError = ref('')

async function ensureFallbackAccounts(list) {
  const need = (list || []).some((c) => !(c.account_type === 'credit') && !isFiniteCents(c.balance_cents))
  if (!need) return
  try {
    accountsById.value = accountsIndex(await fetchAccounts())
    accountsError.value = ''
  } catch (e) {
    accountsError.value = e && e.message ? e.message : '关联账户信息加载失败'
  }
}

// 借记卡余额：卡片接口字段优先，缺失 / 非法时按 account_id 关联账户余额；不可用则标记不可用。
const debitBalances = computed(() => {
  const map = new Map()
  for (const c of (data.value || []).filter((x) => x.account_type !== 'credit')) {
    map.set(c.id, resolveDebitBalance(c, accountsById.value))
  }
  return map
})

function balanceOf(card) {
  return debitBalances.value.get(card.id) || { available: false, cents: null }
}

function accountNameOf(card) {
  return resolveAccountName(card, accountsById.value)
}

// 信用卡可用额度（新接口字段；非法或缺值显示不可用，绝不用额度 / 余额冒充）
function creditAvailable(card) {
  return isFiniteCents(card.available_credit_cents)
    ? { available: true, cents: card.available_credit_cents }
    : { available: false, cents: null }
}

const op = ref(null) // 当前银行卡操作单初始视图（确认卡组件内部回读最新状态）
const creating = ref(false)
const opError = ref('')

onMounted(load)

// 卡片列表变化后按需补充关联账户（仅在缺少余额字段时请求一次）
watch(data, (list) => {
  ensureFallbackAccounts(list)
}, { immediate: true })

// 任何一处完成冻结 / 解冻 / 还款后，卡片列表自动回读最新状态
watch(version, () => {
  load()
})

const statusText = { active: '正常', frozen: '冻结', cancelled: '已注销' }
function statusTone(status) {
  return { active: 'is-ok', frozen: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}

function cardTypeLabel(type) {
  return type || '其他卡种'
}

// 借记卡 / 信用卡分列展示（按关联账户 account_type 判定，不依赖卡种文案）
const debitCards = computed(() => (data.value || []).filter((c) => c.account_type !== 'credit'))
const creditCards = computed(() => (data.value || []).filter((c) => c.account_type === 'credit'))

const isEmptyAll = computed(() => !loading.value && !error.value && !(data.value && data.value.length))
const emptyText = computed(() => (isEmptyAll.value ? '暂无银行卡' : ''))

function onSelectDebit(card) {
  // 已在筛选该卡则取消，否则切换为该卡（再次点击取消筛选，交互对称）
  if (selectedCardId.value === card.id) {
    clear()
    return
  }
  // 旧接口缺 account_name / account_type 时，用关联账户补齐；仅在明确为借记卡时补 deposit，不猜测
  select({
    ...card,
    account_name: accountNameOf(card) || card.account_name,
    account_type: card.account_type || (isDepositCard(card) ? 'deposit' : undefined),
  })
}

async function onAction(card, action) {
  opError.value = ''
  creating.value = true
  try {
    op.value = await createCardOperation({ card_id: card.id, action })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成操作单失败'
  } finally {
    creating.value = false
  }
}

function onDone() {
  op.value = null
  opError.value = ''
  load() // 立即回读卡片列表，展示最新状态
}

function dismiss() {
  op.value = null
  opError.value = ''
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">银行卡</h2>
    </div>

    <!-- 当前按账户筛选提示（选中借记卡后驱动总览 / 流水 / 月度按该账户过滤） -->
    <div v-if="selectedCard" class="selection-bar">
      <span class="selection-text">
        已按账户筛选：<strong>{{ selectedCard.account_name }}</strong>（{{ selectedCard.masked_card_number }}）
      </span>
      <button class="btn-ghost btn-sm" @click="clear">清除筛选</button>
    </div>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="isEmptyAll"
      :empty-text="emptyText"
      @retry="load"
    />

    <template v-if="!loading && !error && data && data.length">
      <!-- 借记卡 + 信用卡摘要：同一响应式网格，桌面足够宽时并排 -->
      <div class="card-section">
        <h3 class="card-section-title">银行卡</h3>
        <div class="card-grid">
          <!-- 借记卡 -->
          <div v-for="c in debitCards" :key="c.id" class="bank-card">
            <div class="bank-card-head">
              <span class="bank-card-type">{{ cardTypeLabel(c.card_type) }}</span>
              <span class="status-badge" :class="statusTone(c.status)">{{ statusText[c.status] || '未知状态' }}</span>
            </div>
            <div class="bank-card-number">{{ c.masked_card_number }}</div>
            <div class="bank-card-balance">
              <span class="bank-card-balance-label">关联账户余额</span>
              <span v-if="balanceOf(c).available" class="bank-card-balance-value">{{ formatCentsToYuan(balanceOf(c).cents) }} 元</span>
              <span v-else class="bank-card-balance-value is-unavailable">暂无法获取</span>
            </div>
            <div v-if="!balanceOf(c).available" class="bank-card-hint">
              {{ accountsError || '关联账户余额暂不可用，请稍后刷新' }}
            </div>
            <div class="bank-card-meta">
              {{ accountNameOf(c) || '关联账户暂无法获取' }} ·
              单日限额 {{ isFiniteCents(c.daily_limit_cents) ? `${formatCentsToYuan(c.daily_limit_cents)} 元` : '暂无法获取' }}
            </div>
            <div v-if="c.status !== 'cancelled'" class="bank-card-actions">
              <button
                class="card-btn card-btn-select"
                :class="{ 'is-selected': selectedCardId === c.id }"
                @click="onSelectDebit(c)"
              >
                {{ selectedCardId === c.id ? '已按此账户筛选' : '按该账户筛选' }}
              </button>
              <button
                v-if="c.status === 'active'"
                class="card-btn"
                :disabled="creating"
                @click="onAction(c, 'freeze')"
              >
                冻结
              </button>
              <button
                v-else-if="c.status === 'frozen'"
                class="card-btn card-btn-warn"
                :disabled="creating"
                @click="onAction(c, 'unfreeze')"
              >
                解冻
              </button>
            </div>
          </div>

          <!-- 信用卡摘要（与借记卡同尺寸；详情在下方独立区域） -->
          <div v-for="c in creditCards" :key="c.id" class="bank-card is-credit">
            <div class="bank-card-head">
              <span class="bank-card-type">{{ cardTypeLabel(c.card_type) }}</span>
              <span class="status-badge" :class="statusTone(c.status)">{{ statusText[c.status] || '未知状态' }}</span>
            </div>
            <div class="bank-card-number">{{ c.masked_card_number }}</div>
            <div class="bank-card-balance">
              <span class="bank-card-balance-label">可用额度</span>
              <span v-if="creditAvailable(c).available" class="bank-card-balance-value">{{ formatCentsToYuan(creditAvailable(c).cents) }} 元</span>
              <span v-else class="bank-card-balance-value is-unavailable">暂无法获取</span>
            </div>
            <div class="bank-card-meta">
              总额度 {{ formatCentsToYuan(c.credit_limit_cents) }} 元 ·
              已入账未还 {{ formatCentsToYuan(c.posted_outstanding_cents) }} 元
            </div>
            <div v-if="c.status !== 'cancelled'" class="bank-card-actions">
              <button
                v-if="c.status === 'active'"
                class="card-btn"
                :disabled="creating"
                @click="onAction(c, 'freeze')"
              >
                冻结
              </button>
              <button
                v-else-if="c.status === 'frozen'"
                class="card-btn card-btn-warn"
                :disabled="creating"
                @click="onAction(c, 'unfreeze')"
              >
                解冻
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 信用卡详情：额度明细 / 账单 / 还款，独立区域、不压缩摘要 -->
      <div v-if="creditCards.length" class="card-section credit-details">
        <h3 class="card-section-title">信用卡详情</h3>
        <div v-for="c in creditCards" :key="c.id" class="credit-detail-block">
          <CreditCardDetail :card="c" />
        </div>
      </div>
    </template>

    <!-- 共享确认卡（确认 / 强验证规则与聊天入口一致） -->
    <p v-if="opError" class="op-error">{{ opError }}</p>
    <CardOperationConfirmCard v-if="op" :op="op" @confirmed="onDone" @cancelled="onDone" />
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
.selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--blue-light);
  background: #eff6ff;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
}
.selection-text strong {
  font-weight: 600;
}
.card-section {
  margin-bottom: 24px;
}
.card-section:last-of-type {
  margin-bottom: 8px;
}
.card-section-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--muted);
}
.card-grid {
  display: grid;
  /* 单卡约 280–320px；桌面足够宽时三张并排，窄屏自动换行 */
  grid-template-columns: repeat(auto-fit, minmax(280px, 320px));
  justify-content: start;
  gap: 16px;
}
.bank-card {
  border-radius: 12px;
  padding: 18px;
  background: linear-gradient(135deg, #0b2545 0%, #1e3a8a 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
  height: 100%;
}
.bank-card.is-credit {
  background: linear-gradient(135deg, #1e1b4b 0%, #4c1d95 100%);
}
.bank-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bank-card-type {
  font-size: 13px;
  color: #bfdbfe;
}
.bank-card-number {
  font-size: 18px;
  letter-spacing: 2px;
  margin-top: 14px;
  font-variant-numeric: tabular-nums;
}
.bank-card-balance {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bank-card-balance-label {
  font-size: 12px;
  color: #cbd5e1;
}
.bank-card-balance-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
}
.bank-card-meta {
  font-size: 12px;
  color: #cbd5e1;
  margin-top: 12px;
}
.bank-card-balance-value.is-unavailable {
  font-size: 16px;
  color: #fde68a;
}
.bank-card-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #fca5a5;
}
.bank-card-actions {
  margin-top: auto; /* 同排卡片按钮底部对齐 */
  padding-top: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.card-btn {
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.card-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.card-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.card-btn-warn {
  background: #b45309;
}
.card-btn-warn:hover:not(:disabled) {
  background: #92400e;
}
.card-btn-select {
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.4);
}
.card-btn-select:hover {
  background: rgba(255, 255, 255, 0.28);
}
.card-btn-select.is-selected {
  background: #16a34a;
  border-color: #16a34a;
}
.credit-details {
  margin-top: 4px;
}
.credit-detail-block {
  margin-bottom: 20px;
}
.credit-detail-block:last-child {
  margin-bottom: 0;
}
.op-error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #b91c1c;
}
.dismiss-btn {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: 1fr;
  }
}
</style>
