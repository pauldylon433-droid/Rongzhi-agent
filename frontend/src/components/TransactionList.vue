<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { fetchTransactions } from '../api/index.js'
import { useMonthRange } from '../composables/useMonthRange.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useCardSelection } from '../composables/useCardSelection.js'
import { formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'
import MonthPicker from './MonthPicker.vue'
import CategoryBadge from './CategoryBadge.vue'
import AccountScopeSelect from './AccountScopeSelect.vue'

// 全局账户范围（含「全部账户」）驱动流水过滤；与银行卡页选卡共用同一状态
const { selectedAccountId, selectedAccountType } = useCardSelection()

// 结余列口径：具体借记账户 = 结余；具体信用账户 = 交易后可用额度；全部账户 = 两者并列
const balanceHeader = computed(() => {
  if (selectedAccountType.value === 'credit') return '交易后可用额度（元）'
  if (selectedAccountType.value === 'deposit') return '结余（元）'
  return '结余／可用额度（元）'
})
const showBalanceLegend = computed(
  () => !selectedAccountType.value && rows.value.some((r) => r.balance_kind === 'credit' && r.balance_state === 'value'),
)
const hasUntraceable = computed(() => rows.value.some((r) => r.balance_state === 'untraceable'))

const PAGE_SIZE = 10

// 月份筛选范围（开户月份 → 当前月份），与月度账单分析复用同一套生成逻辑
const {
  currentYear,
  currentMonth,
  accountsLoading,
  filterMessage,
  yearOptions,
  monthOptionsFor,
  loadAccounts,
} = useMonthRange()

const year = ref(String(currentYear)) // 选中的年份（字符串）；'' 表示「全部月份」
const monthNum = ref(currentMonth)    // 选中的月份（1-12）
const statusFilter = ref('')          // 入账状态：'' 全部 / 'posted' 已入账 / 'pending' 待入账
const page = ref(1)

const selectedYear = computed(() => (year.value === '' ? null : Number(year.value)))

const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

// 竞态防护：每次加载自增序号，仅最新一次请求允许写回结果，旧请求一律丢弃。
let requestId = 0

// 分页稳定性：翻页加载时保留上一页列表高度，避免整段塌陷导致视口上跳。
const bodyEl = ref(null)
const reserveHeight = ref(0)
const reserveStyle = computed(() =>
  reserveHeight.value > 0 ? { minHeight: reserveHeight.value + 'px' } : {},
)

function measureBody() {
  if (!bodyEl.value) return
  const h = bodyEl.value.offsetHeight
  if (h > reserveHeight.value) reserveHeight.value = h
}

function resetReserve() {
  reserveHeight.value = 0
}

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const offset = (page.value - 1) * PAGE_SIZE
    const monthValue = selectedYear.value === null
      ? undefined
      : `${year.value}-${String(monthNum.value).padStart(2, '0')}`
    const res = await fetchTransactions({
      month: monthValue,
      status: statusFilter.value === '' ? undefined : statusFilter.value,
      accountId: selectedAccountId.value || undefined,
      limit: PAGE_SIZE,
      offset,
    })
    if (id !== requestId) return // 过期请求，丢弃
    rows.value = res.rows
    total.value = res.total
    loading.value = false
    await nextTick()
    if (id === requestId) measureBody()
  } catch (e) {
    if (id !== requestId) return
    error.value = e && e.message ? e.message : '加载失败'
    loading.value = false
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < totalPages.value)

function onMonthSelect({ year: y, month: m }) {
  year.value = y
  if (y !== '') monthNum.value = m
  changeFilter()
}

function changeFilter() {
  resetReserve() // 换筛选条件后重新测量，避免沿用上一筛选的预留高度
  page.value = 1 // 任一筛选变化回到第一页
  load()
}

function prevPage() {
  if (!hasPrev.value) return
  page.value -= 1
  load()
}

function nextPage() {
  if (!hasNext.value) return
  page.value += 1
  load()
}

const statusText = { posted: '已入账', pending: '待入账' }
function statusTone(status) {
  return { posted: 'is-ok', pending: 'is-warn' }[status] || 'is-muted'
}
function amountPrefix(direction) {
  return direction === 'income' ? '+' : '-'
}

onMounted(() => {
  loadAccounts()
  load()
})

// 转账成功后刷新当前月份流水，与账户余额、月度统计保持一致
const { version } = useDataRefresh()
watch(version, load)

// 切换选中卡（账户过滤）后回到第一页重新加载
watch(selectedAccountId, () => {
  changeFilter()
})
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">交易流水</h2>
      <div class="filter-toolbar">
        <AccountScopeSelect />
        <template v-if="!accountsLoading && !filterMessage">
          <MonthPicker
            :year="year"
            :month="monthNum"
            :year-options="yearOptions"
            :month-options-for="monthOptionsFor"
            allow-all
            @select="onMonthSelect"
          />
        </template>
        <span v-else-if="accountsLoading" class="filter-note">正在获取开户日期…</span>
        <span v-else class="filter-warn">{{ filterMessage }}</span>
        <label class="filter-label">状态</label>
        <select v-model="statusFilter" class="select" aria-label="入账状态" @change="changeFilter">
          <option value="">全部</option>
          <option value="posted">已入账</option>
          <option value="pending">待入账</option>
        </select>
      </div>
    </div>

    <div class="tx-body-reserve" :style="reserveStyle">
      <div ref="bodyEl" class="tx-body">
        <p v-if="loading" class="state-loading">加载中…</p>
        <div v-else-if="error" class="state-error">
          <p class="state-error-text">{{ error }}</p>
          <button class="btn-ghost" @click="load">重试</button>
        </div>
        <p v-else-if="rows.length === 0" class="state-empty">当前筛选条件下暂无交易记录</p>
        <template v-else>
          <p v-if="showBalanceLegend" class="balance-note">现金行为借记账户结余；标「额度」的行为信用卡交易后可用额度。</p>
          <p v-if="hasUntraceable" class="balance-note">部分历史交易的结余暂不可追溯，已显示「—」。</p>
          <div class="tx-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>交易描述</th>
                  <th>分类</th>
                  <th>状态</th>
                  <th class="num">金额</th>
                  <th class="num">{{ balanceHeader }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in rows" :key="t.id">
                  <td class="tx-time">{{ formatShanghaiDateTime(t.transaction_at) }}</td>
                  <td>
                    <div class="tx-desc-cell">
                      <span class="tx-merchant">
                        <span v-if="t.flow_kind === 'repayment'" class="repay-tag">还款</span>{{ t.merchant || '—' }}
                      </span>
                      <span v-if="t.description" class="tx-sub">{{ t.description }}</span>
                    </div>
                  </td>
                  <td><span class="cat-inline"><CategoryBadge :category="t.category" /><span>{{ t.category }}</span></span></td>
                  <td>
                    <span class="status-badge" :class="statusTone(t.status)">
                      {{ statusText[t.status] || '未知状态' }}
                    </span>
                  </td>
                  <td class="num tx-amount" :class="t.direction === 'income' ? 'is-income' : 'is-expense'">
                    {{ amountPrefix(t.direction) }}{{ formatCentsToYuan(t.amount_cents) }}
                  </td>
                  <td class="num tx-balance">
                    <template v-if="t.balance_state === 'value'">
                      {{ formatCentsToYuan(t.balance_after_cents) }}<span
                        v-if="t.balance_kind === 'credit' && !selectedAccountType"
                        class="balance-tag"
                      >额度</span>
                    </template>
                    <template v-else>—</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <div v-if="total > 0" class="pager">
      <span class="pager-total">共 {{ total }} 条</span>
      <div class="pager-controls">
        <button class="btn" :disabled="loading || !hasPrev" @click="prevPage">上一页</button>
        <span class="pager-info">第 {{ page }} / {{ totalPages }} 页</span>
        <button class="btn" :disabled="loading || !hasNext" @click="nextPage">下一页</button>
      </div>
    </div>
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
.section-title {
  margin: 0;
}
.filter-note {
  font-size: 13px;
  color: var(--muted);
}
.filter-warn {
  font-size: 13px;
  color: #b45309;
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
.tx-table-wrap {
  overflow-x: auto;
}
.tx-desc-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tx-merchant {
  font-weight: 600;
  color: var(--text);
}
.tx-sub {
  font-size: 12px;
  color: var(--muted);
}
.tx-time {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.tx-amount {
  font-weight: 600;
  white-space: nowrap;
}
.tx-balance {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--muted);
}
.balance-tag {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: #ede9fe;
  color: #6d28d9;
  font-size: 11px;
  font-weight: 600;
  vertical-align: 1px;
}
.balance-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 16px;
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
</style>
