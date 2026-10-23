<script setup>
// 账户与流水：账户概览 + 模拟转账 + 交易流水。
import AccountOverview from '../components/AccountOverview.vue'
import TransferPanel from '../components/TransferPanel.vue'
import TransactionList from '../components/TransactionList.vue'
</script>

<template>
  <div class="view-page">
    <header class="view-page-head">
      <h1 class="view-page-title">账户与流水</h1>
    </header>

    <AccountOverview />
    <TransferPanel />
    <TransactionList />
  </div>
</template>
