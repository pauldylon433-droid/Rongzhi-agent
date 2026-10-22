<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchMonthlyAnalytics } from '../api/index.js'
import { useMonthRange } from '../composables/useMonthRange.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatMoney, formatShanghaiDateTime } from '../utils/format.js'

// 月份筛选范围（开户月份 → 当前月份），与交易流水复用同一套生成逻辑。
// 本区域只分析具体月份，不提供「全部月份」。
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

const monthOptions = computed(() => monthOptionsFor(Number(year.value)))

const data = ref(null)
const loading = ref(false)
const error = ref('')

// 竞态防护：仅最新一次请求允许写回，旧请求丢弃
let requestId = 0

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const month = `${year.value}-${String(monthNum.value).padStart(2, '0')}`
    const res = await fetchMonthlyAnalytics({ month })
    if (id !== requestId) return
    data.value = res
  } catch (e) {
    if (id !== requestId) return
    error.value = e && e.message ? e.message : '加载失败'
  } finally {
    if (id === requestId) loading.value = false
  }
}

function onYearChange() {
  // 切换年份后把月份钳制到可选范围（默认取最大可选月份）
  const opts = monthOptions.value
  if (opts.length && !opts.includes(monthNum.value)) {
    monthNum.value = opts[opts.length - 1]
  }
  load()
}

function changeFilter() {
  load()
}

onMounted(() => {
  loadAccounts()
  load()
})

// 转账成功后刷新当前月份统计，与账户余额、交易流水保持一致
const { version } = useDataRefresh()
watch(version, load)

// 无记录：既无已入账也无待入账
const isEmpty = computed(() => {
  const d = data.value
  return !!d && d.posted_count === 0 && d.pending.count === 0
})

const monthLabel = computed(() => (data.value ? data.value.month : ''))
const asOfText = computed(() => (data.value ? formatShanghaiDateTime(data.value.as_of) : ''))
const categoryRows = computed(() => (data.value ? data.value.expense_by_category : []))
const netTone = computed(() =>
  data.value && data.value.net_cents >= 0 ? 'is-income' : 'is-expense',
)

// 分类占比以已入账支出总额为分母；总支出为 0 时避免除零
function ratioPct(amountCents) {
  const total = data.value ? data.value.expense_cents : 0
  if (!total) return '0.0'
  return ((amountCents / total) * 100).toFixed(1)
}

// 带正负号金额（整数分 → +¥1,500.00）
function moneyWithSign(cents) {
  const sign = cents >= 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(cents), 'CNY')}`
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">月度账单分析</h2>
      <div class="filter">
        <label class="filter-label">月份</label>
        <template v-if="!accountsLoading && !filterMessage">
          <select v-model="year" class="select" aria-label="年份" @change="onYearChange">
            <option v-for="y in yearOptions" :key="y" :value="String(y)">{{ y }} 年</option>
          </select>
          <select v-model="monthNum" class="select" aria-label="月份" @change="changeFilter">
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
    <p v-else-if="isEmpty" class="state-empty">该月份暂无记录</p>

    <div v-else-if="data" class="analytics-body">
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-label">已入账收入</span>
          <span class="stat-value is-income">{{ moneyWithSign(data.income_cents) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">已入账支出</span>
          <span class="stat-value is-expense">{{ moneyWithSign(-data.expense_cents) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">净收支</span>
          <span class="stat-value" :class="netTone">{{ moneyWithSign(data.net_cents) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">已入账笔数</span>
          <span class="stat-value">{{ data.posted_count }} 笔</span>
        </div>
      </div>

      <p v-if="data.pending.count > 0" class="pending-note">
        另有 <strong>{{ data.pending.count }}</strong> 笔待入账，共
        <strong>{{ formatMoney(data.pending.amount_cents, 'CNY') }}</strong>（不计入上述已入账统计）
      </p>

      <div class="cat-block">
        <h3 class="cat-title">支出分类</h3>
        <table v-if="categoryRows.length" class="cat-table">
          <thead>
            <tr>
              <th>类别</th>
              <th class="num">笔数</th>
              <th class="num">金额</th>
              <th class="num">占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in categoryRows" :key="c.category">
              <td>{{ c.category }}</td>
              <td class="num">{{ c.count }}</td>
              <td class="num">{{ formatMoney(c.amount_cents, 'CNY') }}</td>
              <td class="num">{{ ratioPct(c.amount_cents) }}%</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="state-empty">暂无已入账支出</p>
      </div>

      <p class="analytics-meta">统计月份 {{ monthLabel }} · 统计截至 {{ asOfText }}（Asia/Shanghai）</p>
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
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
}
.stat-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stat-label {
  font-size: 13px;
  color: var(--muted);
}
.stat-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.is-income {
  color: #15803d;
}
.is-expense {
  color: #b91c1c;
}
.pending-note {
  margin: 16px 0 0;
  padding: 10px 14px;
  background: #fefce8;
  border: 1px solid #fef08a;
  border-radius: 8px;
  font-size: 13px;
  color: #854d0e;
}
.cat-block {
  margin-top: 20px;
}
.cat-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 10px;
}
.cat-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.cat-table th,
.cat-table td {
  text-align: left;
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
}
.cat-table th {
  color: var(--muted);
  font-weight: 500;
  font-size: 13px;
}
.cat-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cat-table tbody tr:last-child td {
  border-bottom: none;
}
.analytics-meta {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
