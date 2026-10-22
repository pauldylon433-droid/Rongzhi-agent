<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../utils/markdown.js'

// 可复用的助手回答展示组件：把 Markdown 文本渲染为净化后的 HTML。
// 用户消息、工具结果卡、操作确认按钮、服务端状态说明均不经过此组件，
// 因此不会从模型生成的 HTML 创建任何业务操作入口。
const props = defineProps({
  text: { type: String, default: '' },
})

const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <!-- v-html 只接收 renderMarkdown 的最终净化结果 -->
  <div class="md-content" v-html="html"></div>
</template>

<style scoped>
.md-content {
  font-size: inherit;
  line-height: 1.6;
  word-break: break-word;
}
.md-content :deep(p) {
  margin: 0 0 6px;
}
.md-content :deep(p:last-child) {
  margin-bottom: 0;
}
.md-content :deep(ul),
.md-content :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.md-content :deep(li) {
  margin: 2px 0;
}
.md-content :deep(strong) {
  font-weight: 600;
}
.md-content :deep(h1),
.md-content :deep(h2),
.md-content :deep(h3),
.md-content :deep(h4),
.md-content :deep(h5),
.md-content :deep(h6) {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
.md-content :deep(code) {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  background: #f1f5f9;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.9em;
}
.md-content :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: #0b2545;
  color: #e2e8f0;
  border-radius: 8px;
  overflow-x: auto;
}
.md-content :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 0;
}
.md-content :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid #cbd5e1;
  color: #64748b;
}
.md-content :deep(hr) {
  border: none;
  border-top: 1px solid #e2e8f0;
  margin: 10px 0;
}
.md-content :deep(a) {
  color: #2563eb;
  text-decoration: none;
}
.md-content :deep(a:hover) {
  text-decoration: underline;
}

/* 表格：边框 / 内边距清晰，表头与数据列按列对齐 */
.md-content :deep(.md-table-scroll) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 8px 0;
}
.md-content :deep(.md-table) {
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.md-content :deep(.md-table th),
.md-content :deep(.md-table td) {
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  text-align: left;
  white-space: normal;
}
.md-content :deep(.md-table th) {
  background: #f8fafc;
  font-weight: 600;
  white-space: nowrap; /* 表头不换行，避免「卡号（掩码）」等被拆断 */
}
.md-content :deep(.md-align-right) {
  text-align: right !important;
}
.md-content :deep(.md-align-center) {
  text-align: center !important;
}
.md-content :deep(.md-align-left) {
  text-align: left !important;
}
</style>
