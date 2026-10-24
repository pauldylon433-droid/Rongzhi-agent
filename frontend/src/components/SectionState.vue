<script setup>
// 各分区共用的「加载 / 空 / 错误 + 重试」状态展示。
defineProps({
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  emptyText: { type: String, default: '暂无数据' },
})

defineEmits(['retry'])
</script>

<template>
  <p v-if="loading" class="state-loading">加载中…</p>
  <div v-else-if="error" class="state-error">
    <p class="state-error-text">{{ error }}</p>
    <button class="btn-ghost" @click="$emit('retry')">重试</button>
  </div>
  <p v-else-if="empty" class="state-empty">{{ emptyText }}</p>
</template>
