<script setup>
// 月度账单：收入 / 支出 / 净收支 / 分类统计。
import MonthlyAnalytics from '../components/MonthlyAnalytics.vue'
</script>

<template>
  <div class="view-page">
    <header class="view-page-head">
      <h1 class="view-page-title">月度账单</h1>
    </header>

    <MonthlyAnalytics />
  </div>
</template>
