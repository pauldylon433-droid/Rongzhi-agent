<script setup>
// 总览（A 布局）中间业务区：标题 + 月份选择、三个概要卡、近期交易表、银行卡/订阅摘要、任务摘要。
// 右侧 AI 侧栏已上移为应用外壳第三栏，本视图只负责中间 56.5% 业务区。
import { ref, computed, onMounted, watch } from 'vue'
import {
  fetchAccounts, fetchMonthlyAnalytics, fetchTransactions, fetchCards, fetchSubscriptions,
} from '../api/index.js'
import { useMonthRange } from '../composables/useMonthRange.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useNavigation } from '../composables/useNavigation.js'
import { useAssistantState } from '../composables/useAssistantState.js'
import { useCardSelection } from '../composables/useCardSelection.js'
import { formatMoney, formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import AppIcon from '../components/AppIcon.vue'
import CategoryBadge from '../components/CategoryBadge.vue'
import MerchantLogo from '../components/MerchantLogo.vue'
import MonthPicker from '../components/MonthPicker.vue'
import AgentTasksSection from '../components/AgentTasksSection.vue'
import SectionState from '../components/SectionState.vue'

const { navigate } = useNavigation()
const { refresh } = useDataRefresh()
const { open: assistantOpen, expand: expandAssistant } = useAssistantState()
const { selectedAccountId, selectedCard } = useCardSelection()

// 月份筛选（开户月份 → 当前月份）
const {
  currentYear,
  currentMonth,
  accountsLoading,
  filterMessage,
  yearOptions,
  monthOptionsFor,
  loadAccounts,
} = useMonthRange()

const year = ref(String(currentYear))
const monthNum = ref(currentMonth)
const selectedMonth = computed(() => `${year.value}-${String(monthNum.value).padStart(2, '0')}`)
const isCurrentMonth = computed(() => selectedMonth.value === `${currentYear}-${String(currentMonth).padStart(2, '0')}`)

// 账户（余额始终当前）
const { data: accounts, loading: accountsLoadingState, error: accountsError, load: loadAccountsData } = useAsyncData(fetchAccounts)

// 概要「账户余额」：选中借记卡时展示其关联活期账户余额，否则回退到首个账户
const balanceAccount = computed(() => {
  if (selectedAccountId.value && accounts.value) {
    const a = accounts.value.find((x) => x.id === selectedAccountId.value)
    if (a) return a
  }
  return accounts.value && accounts.value[0] ? accounts.value[0] : null
})

// 月度统计
const analytics = ref(null)
const analyticsLoading = ref(false)
const analyticsError = ref('')
let analyticsRequestId = 0

// 近期交易（真实分页：页码 / 总数来自后端 meta.total，不写死条数）
const TX_PAGE_SIZE = 8
const recentTx = ref([])
const txTotal = ref(0)
const txPage = ref(1)
const recentTxLoading = ref(false)
const recentTxError = ref('')
let txRequestId = 0

const totalTxPages = computed(() => Math.max(1, Math.ceil(txTotal.value / TX_PAGE_SIZE)))

async function loadAnalytics() {
  const id = ++analyticsRequestId
  analyticsLoading.value = true
  analyticsError.value = ''
  try {
    const a = await fetchMonthlyAnalytics({ month: selectedMonth.value, accountId: selectedAccountId.value || undefined })
    if (id !== analyticsRequestId) return
    analytics.value = a
  } catch (e) {
    if (id !== analyticsRequestId) return
    analyticsError.value = e && e.message ? e.message : '加载账单统计失败'
  } finally {
    if (id === analyticsRequestId) analyticsLoading.value = false
  }
}

async function loadTransactions() {
  const id = ++txRequestId
  recentTxLoading.value = true
  recentTxError.value = ''
  try {
    const offset = (txPage.value - 1) * TX_PAGE_SIZE
    const t = await fetchTransactions({ month: selectedMonth.value, accountId: selectedAccountId.value || undefined, limit: TX_PAGE_SIZE, offset })
    if (id !== txRequestId) return
    recentTx.value = t.rows
    txTotal.value = t.total
  } catch (e) {
    if (id !== txRequestId) return
    recentTxError.value = e && e.message ? e.message : '加载交易失败'
  } finally {
    if (id === txRequestId) recentTxLoading.value = false
  }
}

function loadMonthData() {
  loadAnalytics()
  loadTransactions()
}

// 卡片 / 订阅摘要
const { data: cards, loading: cardsLoading, error: cardsError, load: loadCards } = useAsyncData(fetchCards)
const { data: subs, loading: subsLoading, error: subsError, load: loadSubs } = useAsyncData(fetchSubscriptions)

// 订阅摘要展示真实状态（生效 / 暂停 / 已取消），不擅自过滤成「仅生效」
const subList = computed(() => (subs.value || []).slice(0, 3))
const subStatusText = { active: '生效', paused: '暂停', cancelled: '已取消' }
const subCycleText = { monthly: '按月', yearly: '按年' }
function subStatusTone(status) {
  return { active: 'is-ok', paused: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}

// 交易「账户」列：按 account_id 映射到真实账户名（复用已拉取的账户列表），缺失显示「未提供」，不写死默认账户
const accountNameById = computed(() => {
  const m = {}
  for (const a of accounts.value || []) m[a.id] = a.account_name
  return m
})
function accountName(accountId) {
  return accountNameById.value[accountId] || '未提供'
}

function incomeLabel() {
  return isCurrentMonth.value ? '本月收入' : `${selectedMonth.value} 收入`
}
function expenseLabel() {
  return isCurrentMonth.value ? '本月支出' : `${selectedMonth.value} 支出`
}

function moneyWithSign(cents) {
  const sign = cents >= 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(cents), 'CNY')}`
}

function onMonthSelect({ year: y, month: m }) {
  year.value = y
  monthNum.value = m
  txPage.value = 1
  loadMonthData()
}

function prevTxPage() {
  if (txPage.value <= 1) return
  txPage.value -= 1
  loadTransactions()
}
function nextTxPage() {
  if (txPage.value >= totalTxPages.value) return
  txPage.value += 1
  loadTransactions()
}

function onTaskChanged() {
  refresh()
}

onMounted(() => {
  loadAccounts()
  loadAccountsData()
  loadCards()
  loadSubs()
  loadMonthData()
})

// 转账 / 冻结 / 订阅变更后刷新账户、统计与摘要
const { version } = useDataRefresh()
watch(version, () => {
  loadAccountsData()
  loadCards()
  loadSubs()
  loadMonthData()
})

// 切换选中卡（账户过滤）后：交易回到第一页并重新加载统计与流水
watch(selectedAccountId, () => {
  txPage.value = 1
  loadMonthData()
})
</script>

<template>
  <div class="overview-view">
    <header class="page-head">
      <h1 class="page-title">账户总览</h1>
      <div class="page-head-actions">
        <template v-if="!accountsLoading && !filterMessage">
          <MonthPicker
            :year="year"
            :month="monthNum"
            :year-options="yearOptions"
            :month-options-for="monthOptionsFor"
            @select="onMonthSelect"
          />
        </template>
        <span v-else-if="accountsLoading" class="filter-note">正在获取开户日期…</span>
        <span v-else class="filter-warn">{{ filterMessage }}</span>
        <button v-if="!assistantOpen" class="btn btn-sm" @click="expandAssistant">展开 AI 助手</button>
      </div>
    </header>

    <!-- 三个概要卡（带指标图标） -->
    <div class="summary-cards">
      <div class="summary-card">
        <div class="sc-head">
          <span class="sc-icon sc-icon-balance"><AppIcon name="balance" :size="18" /></span>
          <span class="sc-label">账户余额</span>
        </div>
        <span v-if="accountsLoadingState" class="sc-value">—</span>
        <span v-else-if="balanceAccount" class="sc-value">
          {{ formatMoney(balanceAccount.balance_cents, balanceAccount.currency) }}
        </span>
        <span v-else class="sc-value">—</span>
        <span class="sc-sub">当前余额 · {{ balanceAccount ? balanceAccount.currency : '—' }}<template v-if="selectedCard"> · {{ selectedCard.account_name }}</template></span>
      </div>
      <div class="summary-card">
        <div class="sc-head">
          <span class="sc-icon sc-icon-income"><AppIcon name="income" :size="18" /></span>
          <span class="sc-label">{{ incomeLabel() }}</span>
        </div>
        <span v-if="analyticsLoading" class="sc-value">—</span>
        <span v-else-if="analytics" class="sc-value is-income">{{ moneyWithSign(analytics.income_cents) }}</span>
        <span v-else class="sc-value">—</span>
        <span class="sc-sub">已入账收入</span>
      </div>
      <div class="summary-card">
        <div class="sc-head">
          <span class="sc-icon sc-icon-expense"><AppIcon name="expense" :size="18" /></span>
          <span class="sc-label">{{ expenseLabel() }}</span>
        </div>
        <span v-if="analyticsLoading" class="sc-value">—</span>
        <span v-else-if="analytics" class="sc-value is-expense">{{ moneyWithSign(-analytics.expense_cents) }}</span>
        <span v-else class="sc-value">—</span>
        <span class="sc-sub">已入账支出</span>
      </div>
    </div>

    <!-- 选中借记卡时提示：概览余额 / 收支 / 最近交易均按该账户过滤 -->
    <div v-if="selectedCard" class="selection-hint">
      已按账户筛选：<strong>{{ selectedCard.account_name }}</strong>（{{ selectedCard.masked_card_number }}）· 下方余额、收支与最近交易均按该账户过滤
    </div>

    <!-- 近期交易（紧凑表格 + 分类图标 + 真实分页） -->
    <section class="section overview-section">
      <div class="section-head">
        <h2 class="section-title">最近交易</h2>
        <button class="btn-ghost btn-sm" @click="navigate('accounts')">查看全部</button>
      </div>
      <p v-if="recentTxLoading" class="state-loading">加载中…</p>
      <div v-else-if="recentTxError" class="state-error">
        <p class="state-error-text">{{ recentTxError }}</p>
        <button class="btn-ghost" @click="loadTransactions">重试</button>
      </div>
      <p v-else-if="recentTx.length === 0" class="state-empty">该月暂无交易记录</p>
      <template v-else>
        <div class="tx-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>交易描述</th>
                <th>分类</th>
                <th class="num">收入（¥）</th>
                <th class="num">支出（¥）</th>
                <th>账户</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in recentTx" :key="t.id">
                <td class="tx-date">{{ formatShanghaiDate(t.transaction_at) }}</td>
                <td class="tx-desc"><span v-if="t.flow_kind === 'repayment'" class="repay-tag">还款</span>{{ t.merchant || '—' }}<template v-if="t.description"> · {{ t.description }}</template></td>
                <td><span class="cat-inline"><CategoryBadge :category="t.category" /><span>{{ t.category }}</span></span></td>
                <td class="num tx-amount" :class="t.direction === 'income' ? 'is-income' : 'tx-dash'">
                  {{ t.direction === 'income' ? formatCentsToYuan(t.amount_cents) : '—' }}
                </td>
                <td class="num tx-amount" :class="t.direction === 'expense' ? '' : 'tx-dash'">
                  {{ t.direction === 'expense' ? formatCentsToYuan(t.amount_cents) : '—' }}
                </td>
                <td class="tx-account">{{ accountName(t.account_id) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="txTotal > TX_PAGE_SIZE" class="tx-pager">
          <span class="pager-total">共 {{ txTotal }} 条</span>
          <div class="pager-controls">
            <button class="btn btn-sm" :disabled="txPage <= 1" @click="prevTxPage">上一页</button>
            <span class="pager-info">第 {{ txPage }} / {{ totalTxPages }} 页</span>
            <button class="btn btn-sm" :disabled="txPage >= totalTxPages" @click="nextTxPage">下一页</button>
          </div>
        </div>
      </template>
    </section>

    <!-- 银行卡 / 订阅摘要 -->
    <div class="summary-row">
      <section class="section overview-section">
        <div class="section-head">
          <h2 class="section-title">我的银行卡</h2>
          <button class="btn-ghost btn-sm" @click="navigate('cards')">管理银行卡</button>
        </div>
        <SectionState :loading="cardsLoading" :error="cardsError" :empty="!cardsLoading && !cardsError && !(cards && cards.length)" empty-text="暂无银行卡" @retry="loadCards" />
        <ul v-if="!cardsLoading && !cardsError && cards && cards.length" class="mini-list">
          <li v-for="c in cards.slice(0, 3)" :key="c.id" class="mini-item">
            <span class="mini-name">{{ c.masked_card_number }}</span>
            <span class="mini-meta">{{ c.card_type }}</span>
          </li>
        </ul>
      </section>

      <section class="section overview-section">
        <div class="section-head">
          <h2 class="section-title">订阅与代扣</h2>
          <button class="btn-ghost btn-sm" @click="navigate('subscriptions')">管理订阅</button>
        </div>
        <SectionState :loading="subsLoading" :error="subsError" :empty="!subsLoading && !subsError && !(subs && subs.length)" empty-text="暂无订阅" @retry="loadSubs" />
        <ul v-if="!subsLoading && !subsError && subList.length" class="mini-list">
          <li v-for="s in subList" :key="s.id" class="mini-item">
            <span class="mini-name">
              <MerchantLogo :merchant="s.merchant" :size="22" />
              <span>{{ s.merchant }}</span>
            </span>
            <span class="mini-side">
              <span class="mini-meta">{{ formatCentsToYuan(s.amount_cents) }} 元 / {{ subCycleText[s.billing_cycle] || s.billing_cycle }}</span>
              <span class="status-badge" :class="subStatusTone(s.status)">{{ subStatusText[s.status] || '未知状态' }}</span>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <!-- 最近任务摘要 -->
    <section class="section overview-section">
      <AgentTasksSection compact title="最近任务" view-all-label="查看结果" @changed="onTaskChanged" @view-all="navigate('tasks')" />
    </section>
  </div>
</template>

<style scoped>
.overview-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page-title {
  margin: 0;
  font-size: clamp(24px, 1.64vw, 28px);
  font-weight: 700;
  color: var(--navy);
  line-height: 1.2;
}
.page-head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.filter-note { font-size: 14px; color: var(--muted); }
.filter-warn { font-size: 14px; color: #b45309; }
.selection-hint {
  padding: 10px 14px;
  border: 1px solid var(--blue-light);
  background: #eff6ff;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
}
.selection-hint strong {
  font-weight: 600;
}
.btn-sm { padding: 6px 12px; font-size: 14px; }

.summary-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.summary-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sc-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sc-icon-balance { background: var(--blue-light); color: var(--blue); }
.sc-icon-income { background: #dcfce7; color: #15803d; }
.sc-icon-expense { background: #fee2e2; color: #b91c1c; }
.sc-label {
  font-size: 14px;
  color: var(--muted);
}
.sc-value {
  font-size: 27px;
  font-weight: 700;
  color: var(--navy);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.sc-sub {
  font-size: 13px;
  color: var(--muted);
}
.is-income { color: #15803d; }
.is-expense { color: #b91c1c; }

.overview-section {
  margin-bottom: 0;
  padding: 18px 20px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.section-head .section-title {
  margin: 0;
  font-size: 18px;
}

.tx-table-wrap {
  overflow-x: auto;
}
.tx-table-wrap .data-table {
  min-width: 600px;
}
.tx-date {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.tx-desc {
  color: var(--text);
  font-weight: 500;
}
.repay-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #ede9fe;
  color: #6d28d9;
  font-size: 11px;
  font-weight: 600;
  vertical-align: 1px;
}
.tx-amount {
  font-weight: 600;
  white-space: nowrap;
}
.tx-dash {
  color: #cbd5e1;
}
.tx-account {
  color: var(--muted);
  white-space: nowrap;
}
.tx-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 14px;
  margin-top: 4px;
  border-top: 1px solid var(--border);
}
.pager-total {
  font-size: 13px;
  color: var(--muted);
}
.pager-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pager-info {
  font-size: 13px;
  color: var(--text);
}

.summary-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.mini-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mini-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.mini-item:last-child {
  border-bottom: none;
}
.mini-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text);
  font-size: 15px;
}
.mini-name > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-side {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mini-meta { color: var(--muted); font-size: 13px; }

@media (max-width: 767px) {
  .overview-view { padding: 16px; }
  .page-title { font-size: 22px; }
  .summary-cards { grid-template-columns: 1fr; }
  .summary-row { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; align-items: flex-start; }
}
</style>
