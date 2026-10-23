<script setup>
// AI 机器人头像：蓝色圆底 + 白色圆润机器人头 + 顶部天线。总览侧栏标题、工作区标题与 AI 消息共用。
defineProps({
  size: { type: Number, default: 34 },
})
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#2563eb" />
    <path d="M12 7.6V5.4" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" />
    <circle cx="12" cy="4.2" r="1.1" fill="#ffffff" />
    <rect x="7.2" y="8" width="9.6" height="6.8" rx="3" fill="#ffffff" />
    <circle cx="10" cy="11.4" r="1" fill="#2563eb" />
    <circle cx="14" cy="11.4" r="1" fill="#2563eb" />
    <path d="M10.6 13.6h2.8" stroke="#2563eb" stroke-width="1" stroke-linecap="round" />
  </svg>
</template>
