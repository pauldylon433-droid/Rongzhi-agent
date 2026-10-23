<script setup>
// 订阅与代扣：订阅列表 + 暂停 / 恢复 / 取消。
import SubscriptionList from '../components/SubscriptionList.vue'
</script>

<template>
  <div class="view-page">
    <header class="view-page-head">
      <h1 class="view-page-title">订阅与代扣</h1>
    </header>

    <SubscriptionList />
  </div>
</template>
