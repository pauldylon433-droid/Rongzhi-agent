<script setup>
import { computed } from 'vue'

// 本地图标方案：以 name 为键的内联 SVG（24×24 描边风格，颜色继承 currentColor）。
// 导航 / 指标 / 状态 / 任务等结构性图标统一在此维护，避免各组件重复粘贴路径。
// 分类图标由 CategoryBadge 处理（按分类名确定性着色，不硬编码具体分类）。
const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 20 },
})

const ICONS = {
  // 导航
  overview: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/>',
  assistant: '<path d="M21 12a8 8 0 0 1-8 8H4l2.2-3.2A8 8 0 1 1 21 12Z"/>',
  accounts: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
  bill: '<path d="M3 3v18h18"/><path d="M8 17V9m5 8V5m5 12v-5"/>',
  cards: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  subscriptions: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',

  // 指标
  balance: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M16 12h.01M8 12h.01M12 16h.01"/>',
  income: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  expense: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  posted: '<path d="m20 6-11 11-5-5"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',

  // 通用
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4m8-4v4"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  subscription: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7M3 21l7-7"/>',
  collapse: '<path d="M3 3h6v6"/><path d="M21 21h-6v-6"/><path d="m3 3 6 6m12 12-6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  select: '<path d="M4 4l7 18 2.5-7L20 12z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  receipt: '<path d="M5 3h14v18l-2-1.5L15 21l-2-1.5L11 21l-2-1.5L7 21l-2-1.5z"/><path d="M9 8h6m-6 4h6"/>',
  fallback: '<circle cx="12" cy="12" r="9"/>',
}

const path = computed(() => ICONS[props.name] || ICONS.fallback)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="path"
  ></svg>
</template>
