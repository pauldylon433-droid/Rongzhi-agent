import { computed } from 'vue'
import { fetchAccounts } from '../api/index.js'
import { useAsyncData } from './useAsyncData.js'
import { currentShanghaiYearMonth } from '../utils/format.js'

// 月份筛选范围：账户开户月份 → 当前上海月份。
// 供「交易流水」与「月度账单分析」复用，避免复制筛选逻辑。
// 开户日期缺失或加载失败时给出明确提示，不回退到 created_at。
export function useMonthRange() {
  const { year: currentYear, month: currentMonth } = currentShanghaiYearMonth()

  const {
    data: accounts,
    loading: accountsLoading,
    error: accountsError,
    load: loadAccounts,
  } = useAsyncData(fetchAccounts)

  // 最早开户月份 "YYYY-MM"
  const earliestMonth = computed(() => {
    const arr = (accounts.value || [])
      .map((a) => (a.opened_on ? String(a.opened_on).slice(0, 7) : null))
      .filter(Boolean)
      .sort()
    return arr.length ? arr[0] : null
  })

  // 无法生成月份筛选时的明确提示（不擅自用 created_at 代替）
  const filterMessage = computed(() => {
    if (accountsError.value) return '无法获取账户开户日期，月份筛选不可用'
    if (!accountsLoading.value && !earliestMonth.value) return '账户开户日期缺失，月份筛选不可用'
    return ''
  })

  const earliestYear = computed(() =>
    earliestMonth.value ? Number(earliestMonth.value.slice(0, 4)) : null,
  )
  const earliestMonthNum = computed(() =>
    earliestMonth.value ? Number(earliestMonth.value.slice(5, 7)) : null,
  )

  // 年份范围：开户年份 .. 当前年份
  const yearOptions = computed(() => {
    if (earliestYear.value == null) return []
    const arr = []
    for (let y = currentYear; y >= earliestYear.value; y--) arr.push(y)
    return arr
  })

  // 某年份可选月份（1-12）：开户年从开户月到 12；当前年到当前月；中间年份 1-12
  function monthOptionsFor(year) {
    if (year == null || earliestYear.value == null) return []
    const min = year === earliestYear.value ? earliestMonthNum.value : 1
    const max = year === currentYear ? currentMonth : 12
    const arr = []
    for (let m = min; m <= max; m++) arr.push(m)
    return arr
  }

  return {
    currentYear,
    currentMonth,
    accountsLoading,
    accountsError,
    earliestMonth,
    filterMessage,
    yearOptions,
    monthOptionsFor,
    loadAccounts,
  }
}
