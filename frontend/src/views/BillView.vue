<script setup>
// 月度账单：收入 / 支出 / 净收支 / 分类统计；选中信用账户时切换为信用卡消费分析。
import { computed } from 'vue'
import MonthlyAnalytics from '../components/MonthlyAnalytics.vue'
import { useCardSelection } from '../composables/useCardSelection.js'

const { selectedAccountType } = useCardSelection()
const pageTitle = computed(() => (selectedAccountType.value === 'credit' ? '信用卡月度消费分析' : '月度账单'))
</script>

<template>
  <div class="view-page">
    <header class="view-page-head">
      <h1 class="view-page-title">{{ pageTitle }}</h1>
    </header>

    <MonthlyAnalytics />
  </div>
</template>
