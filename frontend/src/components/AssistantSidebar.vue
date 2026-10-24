<script setup>
// 总览右侧 AI 助手侧栏：作为应用外壳的第三栏（占整页约 29.5%）。
// 顶部标题 + 收起 / 展开工作区；下方复用 ChatPanel（紧凑模式）。
import { useNavigation } from '../composables/useNavigation.js'
import ChatPanel from './ChatPanel.vue'
import BotAvatar from './BotAvatar.vue'

defineProps({
  open: { type: Boolean, default: true },
})
const emit = defineEmits(['collapse'])

const { openAssistant } = useNavigation()
</script>

<template>
  <aside class="assistant-sidebar" :class="{ 'is-open': open }">
    <div class="assistant-sidebar-head">
      <h2 class="assistant-sidebar-title">
        <BotAvatar :size="22" />
        <span>AI 助手</span>
      </h2>
      <div class="assistant-sidebar-actions">
        <button class="btn-ghost btn-sm" title="收起助手" @click="emit('collapse')">收起</button>
        <button class="btn btn-sm" @click="openAssistant">展开工作区</button>
      </div>
    </div>
    <ChatPanel compact />
  </aside>
</template>

<style scoped>
.assistant-sidebar {
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid var(--border);
  padding: 16px;
  gap: 12px;
  overflow: hidden;
}
.assistant-sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-shrink: 0;
}
.assistant-sidebar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--navy);
}
.assistant-sidebar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}

/* 手机（<768px）：右侧抽屉 */
@media (max-width: 767px) {
  .assistant-sidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: min(86vw, 400px);
    z-index: 70;
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform 0.2s ease;
  }
  .assistant-sidebar.is-open {
    transform: translateX(0);
  }
}
</style>
