<script setup>
// 品牌「R」图形 Logo：渐变圆角方块 + 描边 R，随颜色上下文使用（导航深色底 / 移动端顶栏）。
// 渐变 id 需在每个实例内唯一，避免多个 Logo 同时挂载时 defs 冲突。
const gradId = `brand-grad-${Math.random().toString(36).slice(2, 9)}`
defineProps({
  size: { type: Number, default: 34 },
})
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3b82f6" />
        <stop offset="1" stop-color="#0b2545" />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="10" :fill="`url(#${gradId})`" />
    <path
      d="M14 29V12h7.5a4.6 4.6 0 0 1 0 9.2H18.4L25 29"
      fill="none"
      stroke="#ffffff"
      stroke-width="2.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
