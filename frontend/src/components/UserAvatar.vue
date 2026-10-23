<script setup>
// 用户头像：浅蓝圆底 + 深蓝人物头肩轮廓，用于对话中的用户消息气泡外侧。
defineProps({
  size: { type: Number, default: 34 },
})
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#dbeafe" />
    <circle cx="12" cy="9" r="3.2" fill="#0b2545" />
    <path d="M5.2 19.2c0-3.4 3-5.4 6.8-5.4s6.8 2 6.8 5.4" fill="#0b2545" />
  </svg>
</template>
