<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchTransactions } from '../api/index.js'
import { useMonthRange } from '../composables/useMonthRange.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'

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
const page = ref(1)

const isAll = computed(() => year.value === '')
const selectedYear = computed(() => (year.value === '' ? null : Number(year.value)))

// 当前选中年份可选月份
const monthOptions = computed(() => monthOptionsFor(selectedYear.value))

const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

// 竞态防护：每次加载自增序号，仅最新一次请求允许写回结果，旧请求一律丢弃。
let requestId = 0

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
      limit: PAGE_SIZE,
      offset,
    })
    if (id !== requestId) return // 过期请求，丢弃
    rows.value = res.rows
    total.value = res.total
  } catch (e) {
    if (id !== requestId) return
    error.value = e && e.message ? e.message : '加载失败'
  } finally {
    if (id === requestId) loading.value = false
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < totalPages.value)

function onYearChange() {
  // 切换年份后，把月份钳制到该年份可选范围内（默认取最大可选月份）
  const opts = monthOptions.value
  if (opts.length && !opts.includes(monthNum.value)) {
    monthNum.value = opts[opts.length - 1]
  }
  changeFilter()
}

function changeFilter() {
  page.value = 1 // 切换月份回到第一页
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
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">交易流水</h2>
      <div class="filter">
        <label class="filter-label">月份</label>
        <template v-if="!accountsLoading && !filterMessage">
          <select v-model="year" class="select" aria-label="年份" @change="onYearChange">
            <option value="">全部月份</option>
            <option v-for="y in yearOptions" :key="y" :value="String(y)">{{ y }} 年</option>
          </select>
          <select v-model="monthNum" class="select" aria-label="月份" :disabled="isAll" @change="changeFilter">
            <option v-for="m in monthOptions" :key="m" :value="m">{{ m }} 月</option>
          </select>
        </template>
        <span v-else-if="accountsLoading" class="filter-note">正在获取开户日期…</span>
        <span v-else class="filter-warn">{{ filterMessage }}</span>
      </div>
    </div>

    <p v-if="loading" class="state-loading">加载中…</p>
    <div v-else-if="error" class="state-error">
      <p class="state-error-text">{{ error }}</p>
      <button class="btn-ghost" @click="load">重试</button>
    </div>
    <template v-else>
      <p v-if="rows.length === 0" class="state-empty">该月份暂无交易</p>
      <ul v-else class="tx-list">
        <li v-for="t in rows" :key="t.id" class="tx-item">
          <div class="tx-main">
            <span class="tx-merchant">{{ t.merchant || '—' }}</span>
            <span class="tx-sub">
              {{ t.category }}<template v-if="t.description"> · {{ t.description }}</template>
            </span>
          </div>
          <div class="tx-side">
            <span class="tx-amount" :class="t.direction === 'income' ? 'is-income' : 'is-expense'">
              {{ amountPrefix(t.direction) }}{{ formatCentsToYuan(t.amount_cents) }}
            </span>
            <span class="status-badge" :class="statusTone(t.status)">
              {{ statusText[t.status] || '未知状态' }}
            </span>
            <span class="tx-time">{{ formatShanghaiDateTime(t.transaction_at) }}</span>
          </div>
        </li>
      </ul>

      <div class="pager">
        <span class="pager-total">共 {{ total }} 条</span>
        <div class="pager-controls">
          <button class="btn" :disabled="!hasPrev" @click="prevPage">上一页</button>
          <span class="pager-info">第 {{ page }} / {{ totalPages }} 页</span>
          <button class="btn" :disabled="!hasNext" @click="nextPage">下一页</button>
        </div>
      </div>
    </template>
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
.filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 13px;
  color: var(--muted);
}
.filter-note {
  font-size: 13px;
  color: var(--muted);
}
.filter-warn {
  font-size: 13px;
  color: #b45309;
}
.tx-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tx-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.tx-item:last-child {
  border-bottom: none;
}
.tx-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tx-merchant {
  font-weight: 600;
  color: var(--text);
}
.tx-sub {
  font-size: 12px;
  color: var(--muted);
}
.tx-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.tx-amount {
  font-weight: 600;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.is-income {
  color: #15803d;
}
.is-expense {
  color: #b91c1c;
}
.tx-time {
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

@media (max-width: 640px) {
  .tx-item {
    flex-direction: column;
    align-items: flex-start;
  }
  .tx-side {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>
