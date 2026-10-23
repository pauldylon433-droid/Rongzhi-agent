<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchMonthlyAnalytics } from '../api/index.js'
import { useMonthRange } from '../composables/useMonthRange.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useCardSelection } from '../composables/useCardSelection.js'
import { formatMoney, formatShanghaiDateTime } from '../utils/format.js'
import { categoryColor } from '../utils/categoryColor.js'
import MonthPicker from './MonthPicker.vue'
import AppIcon from './AppIcon.vue'
import CategoryBadge from './CategoryBadge.vue'
import CategoryPieChart from './CategoryPieChart.vue'
import AccountScopeSelect from './AccountScopeSelect.vue'

// 全局账户范围（含「全部账户」）驱动月度分析；与交易流水、银行卡页共用同一状态
const { selectedAccountId, selectedAccountType } = useCardSelection()

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
    const res = await fetchMonthlyAnalytics({ month, accountId: selectedAccountId.value || undefined })
    if (id !== requestId) return
    data.value = res
  } catch (e) {
    if (id !== requestId) return
    error.value = e && e.message ? e.message : '加载失败'
  } finally {
    if (id === requestId) loading.value = false
  }
}

function onMonthSelect({ year: y, month: m }) {
  year.value = y
  monthNum.value = m
  load()
}

onMounted(() => {
  loadAccounts()
  load()
})

// 转账成功后刷新当前月份统计，与账户余额、交易流水保持一致
const { version } = useDataRefresh()
watch(version, load)

// 切换选中卡（账户过滤）后重新加载当前月份统计
watch(selectedAccountId, load)

// 无记录：既无已入账也无待入账、也无还款
const isEmpty = computed(() => {
  const d = data.value
  return !!d && d.posted_count === 0 && d.pending.count === 0 && d.repayment_cents === 0
})

// 已加载成功且非空，才展示两张分析卡（避免月份切换加载中仍显示上一月份旧数据）
const showAnalysis = computed(() => !!data.value && !loading.value && !error.value && !isEmpty.value)

// 明确选中信用账户时隐藏整个「收入分析」模块（标题 / 分类表 / 饼图 / 空态一并隐藏，不留占位）。
// 依据全局选择快照中的真实 account_type；「全部账户」或借记账户时保留。
const showIncomeAnalysis = computed(() => selectedAccountType.value !== 'credit')

const monthLabel = computed(() => (data.value ? data.value.month : ''))
const asOfText = computed(() => (data.value ? formatShanghaiDateTime(data.value.as_of) : ''))
// 收入分类 / 支出分类分别取后端对应分类汇总（同一已入账口径）
const incomeRows = computed(() => (data.value ? data.value.income_by_category : []))
const expenseRows = computed(() => (data.value ? data.value.expense_by_category : []))
const netTone = computed(() =>
  data.value && data.value.net_cents >= 0 ? 'is-income' : 'is-expense',
)

// 分类占比：分母为对应方向已入账总额；总额为 0 时避免除零
function ratioPct(amountCents, totalCents) {
  if (!totalCents) return '0.0'
  return ((amountCents / totalCents) * 100).toFixed(1)
}

// 带正负号金额（整数分 → +¥1,500.00）
function moneyWithSign(cents) {
  const sign = cents >= 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(cents), 'CNY')}`
}
</script>

<template>
  <div class="monthly">
    <!-- 顶部：月份选择 + 指标卡 + 待入账提示（保留） -->
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">月度账单分析</h2>
        <div class="filter-toolbar">
          <AccountScopeSelect />
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
        </div>
      </div>

      <p v-if="loading" class="state-loading">加载中…</p>
      <div v-else-if="error" class="state-error">
        <p class="state-error-text">{{ error }}</p>
        <button class="btn-ghost" @click="load">重试</button>
      </div>
      <p v-else-if="isEmpty" class="state-empty">该月份暂无记录</p>

      <div v-else-if="data" class="top-body">
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-head">
              <span class="stat-icon stat-icon-income"><AppIcon name="income" :size="16" /></span>
              <span class="stat-label">已入账收入</span>
            </div>
            <span class="stat-value is-income">{{ moneyWithSign(data.income_cents) }}</span>
          </div>
          <div class="stat-card">
            <div class="stat-head">
              <span class="stat-icon stat-icon-expense"><AppIcon name="expense" :size="16" /></span>
              <span class="stat-label">已入账支出</span>
            </div>
            <span class="stat-value is-expense">{{ moneyWithSign(-data.expense_cents) }}</span>
          </div>
          <div class="stat-card">
            <div class="stat-head">
              <span class="stat-icon stat-icon-net"><AppIcon name="balance" :size="16" /></span>
              <span class="stat-label">净收支</span>
            </div>
            <span class="stat-value" :class="netTone">{{ moneyWithSign(data.net_cents) }}</span>
          </div>
          <div class="stat-card">
            <div class="stat-head">
              <span class="stat-icon stat-icon-posted"><AppIcon name="posted" :size="16" /></span>
              <span class="stat-label">已入账笔数</span>
            </div>
            <span class="stat-value">{{ data.posted_count }} 笔</span>
          </div>
        </div>

        <p v-if="data.pending.count > 0" class="pending-note">
          另有 <strong>{{ data.pending.count }}</strong> 笔待入账，共
          <strong>{{ formatMoney(data.pending.amount_cents, 'CNY') }}</strong>（不计入上述已入账统计）
        </p>

        <p v-if="data.repayment_cents > 0" class="repay-note">
          信用卡还款 <strong>{{ formatMoney(data.repayment_cents, 'CNY') }}</strong>（内部冲账，单列展示，不计入收入 / 支出 / 净收支）
        </p>

        <p class="caliber-note">
          口径说明：本页按「交易发生时间 + 已入账」统计收支；信用卡账单按「入账时间」归账期，两口径因入账延迟可能不同。
        </p>
      </div>
    </section>

    <!-- 收入 / 支出各自独立卡片，与顶部卡片并列，不嵌套 -->
    <template v-if="showAnalysis">
      <section v-if="showIncomeAnalysis" class="ana-card">
        <h3 class="ana-title">收入分析</h3>
        <div class="ana-layout">
          <div class="ana-col">
            <h4 class="ana-subtitle">收入分类明细</h4>
            <table v-if="incomeRows.length" class="data-table ana-table">
              <thead>
                <tr>
                  <th>类别</th>
                  <th class="num">笔数</th>
                  <th class="num">金额</th>
                  <th class="num">占比</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in incomeRows" :key="c.category">
                  <td class="cat-cell">
                    <span class="cat-row">
                      <CategoryBadge :category="c.category" />
                      <span class="cat-dot" :style="{ background: categoryColor(c.category) }"></span>
                      <span class="cat-name">{{ c.category }}</span>
                    </span>
                  </td>
                  <td class="num">{{ c.count }}</td>
                  <td class="num is-income">{{ formatMoney(c.amount_cents, 'CNY') }}</td>
                  <td class="num">{{ ratioPct(c.amount_cents, data.income_cents) }}%</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="state-empty">暂无已入账收入</p>
          </div>
          <div class="ana-col">
            <h4 class="ana-subtitle">收入来源占比</h4>
            <CategoryPieChart
              v-if="incomeRows.length"
              :slices="incomeRows"
              :total-cents="data.income_cents"
              center-label="已入账收入"
            />
            <p v-else class="state-empty">暂无已入账收入</p>
          </div>
        </div>
      </section>

      <section class="ana-card">
        <h3 class="ana-title">支出分析</h3>
        <div class="ana-layout">
          <div class="ana-col">
            <h4 class="ana-subtitle">支出分类明细</h4>
            <table v-if="expenseRows.length" class="data-table ana-table">
              <thead>
                <tr>
                  <th>类别</th>
                  <th class="num">笔数</th>
                  <th class="num">金额</th>
                  <th class="num">占比</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in expenseRows" :key="c.category">
                  <td class="cat-cell">
                    <span class="cat-row">
                      <CategoryBadge :category="c.category" />
                      <span class="cat-dot" :style="{ background: categoryColor(c.category) }"></span>
                      <span class="cat-name">{{ c.category }}</span>
                    </span>
                  </td>
                  <td class="num">{{ c.count }}</td>
                  <td class="num">{{ formatMoney(c.amount_cents, 'CNY') }}</td>
                  <td class="num">{{ ratioPct(c.amount_cents, data.expense_cents) }}%</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="state-empty">暂无已入账支出</p>
          </div>
          <div class="ana-col">
            <h4 class="ana-subtitle">支出去向占比</h4>
            <CategoryPieChart
              v-if="expenseRows.length"
              :slices="expenseRows"
              :total-cents="data.expense_cents"
              center-label="已入账支出"
            />
            <p v-else class="state-empty">暂无已入账支出</p>
          </div>
        </div>
      </section>

      <p class="analytics-meta">统计月份 {{ monthLabel }} · 统计截至 {{ asOfText }}（Asia/Shanghai）</p>
    </template>
  </div>
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
.stat-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat-icon {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.stat-icon-income { background: #dcfce7; color: #15803d; }
.stat-icon-expense { background: #fee2e2; color: #b91c1c; }
.stat-icon-net { background: var(--blue-light); color: var(--blue); }
.stat-icon-posted { background: #ede9fe; color: #6d28d9; }
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
.repay-note {
  margin: 12px 0 0;
  padding: 10px 14px;
  background: #f5f3ff;
  border: 1px solid #ddd6fe;
  border-radius: 8px;
  font-size: 13px;
  color: #4c1d95;
}
.repay-note strong {
  font-weight: 600;
}
.caliber-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

/* 分析卡片：细边框 + 12px 圆角 + 20px 内边距，卡片间距 20px，独立适应内容高度 */
.ana-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}
.ana-title {
  margin: 0 0 16px;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--navy);
}
.ana-subtitle {
  margin: 0 0 10px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--muted);
}
/* 左表右图约 55% / 45%，顶部对齐 */
.ana-layout {
  display: grid;
  grid-template-columns: minmax(0, 11fr) minmax(0, 9fr);
  gap: 20px;
  align-items: start;
}
.ana-col {
  min-width: 0;
}
@media (max-width: 720px) {
  .ana-layout {
    grid-template-columns: 1fr;
  }
}

/* 表格：紧凑行高、浅灰蓝表头、贯穿整行的分隔线；类别列不破坏 table-cell 布局 */
.ana-table {
  width: 100%;
}
.ana-table th {
  background: #f1f5f9;
  color: var(--muted);
  font-weight: 500;
  font-size: var(--fs-xs);
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.ana-table th.num {
  text-align: right;
}
.ana-table td {
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  line-height: 1.4;
}
.ana-table tbody tr:last-child td {
  border-bottom: none;
}
.ana-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ana-table .is-income {
  color: #15803d;
}
.cat-cell {
  text-align: left;
}
/* 图标 / 色点 / 名称放在单元格内 flex 容器上，避免把 td 变成 flex 导致分隔线断裂 */
.cat-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.cat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.cat-name {
  font-weight: 500;
}

.analytics-meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
