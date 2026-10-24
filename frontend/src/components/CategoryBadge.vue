<script setup>
import { computed } from 'vue'

// 交易分类图标：按真实分类名精确匹配到本地 SVG 图标与配色（彩色图形，非系统 Emoji）。
// 不修改分类名称、不改变归类规则；未知分类使用统一兜底图标（灰色标签），不硬编码金额/日期/对象。
const props = defineProps({
  category: { type: String, default: '' },
  size: { type: Number, default: 22 },
})

const CATEGORY_ICONS = {
  '餐饮': {
    paths: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3z"/><path d="M21 15v7"/>',
    color: '#e0533d', bg: '#fdebe7',
  },
  '收入': {
    paths: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="m9.5 9.5 2.5-2.5 2.5 2.5"/><path d="m9.5 14.5 2.5 2.5 2.5-2.5"/>',
    color: '#16a34a', bg: '#dcfce7',
  },
  '购物': {
    paths: '<path d="M6 7h12l1.5 13.5a1 1 0 0 1-1 1.5H5.5a1 1 0 0 1-1-1.5L6 7z"/><path d="M9 7V6a3 3 0 0 1 6 0v1"/>',
    color: '#dc2626', bg: '#fee2e2',
  },
  '交通': {
    paths: '<rect x="4" y="3" width="16" height="13" rx="3"/><path d="M4 10h16"/><path d="M9 19l-2 3m8-3 2 3"/><path d="M8 14h.01M16 14h.01"/>',
    color: '#2563eb', bg: '#dbeafe',
  },
  '住房': {
    paths: '<path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    color: '#4f46e5', bg: '#e0e7ff',
  },
  '娱乐': {
    paths: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/>',
    color: '#d97706', bg: '#fef3c7',
  },
  '订阅扣费': {
    paths: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    color: '#7c3aed', bg: '#ede9fe',
  },
  '订阅': {
    paths: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    color: '#7c3aed', bg: '#ede9fe',
  },
}

const FALLBACK = {
  paths: '<path d="M3 7a2 2 0 0 1 2-2h8l6 6v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><circle cx="8.5" cy="11.5" r="1"/>',
  color: '#64748b', bg: '#f1f5f9',
}

const meta = computed(() => CATEGORY_ICONS[props.category] || FALLBACK)
const iconSize = computed(() => Math.round(props.size * 0.68))
</script>

<template>
  <span
    class="cat-icon"
    :style="{ width: size + 'px', height: size + 'px', background: meta.bg, color: meta.color }"
  >
    <svg
      :width="iconSize"
      :height="iconSize"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      v-html="meta.paths"
    ></svg>
  </span>
</template>

<style scoped>
.cat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  flex-shrink: 0;
}
</style>
