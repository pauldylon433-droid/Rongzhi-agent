<script setup>
// AI 助手工作区（B 布局）：左侧导航 + 可收起对话历史栏（最近对话 + 最近业务记录）+ 中央对话 / 任务区 + 右侧业务信息栏。
import { ref, onMounted, watch } from 'vue'
import { useChatSession } from '../composables/useChatSession.js'
import { useNavigation } from '../composables/useNavigation.js'
import { useTasksSignal } from '../composables/useTasksSignal.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useTransferSignal } from '../composables/useTransferSignal.js'
import { useCardOpSignal } from '../composables/useCardOpSignal.js'
import { useSubscriptionOpSignal } from '../composables/useSubscriptionOpSignal.js'
import { useRepaymentSignal } from '../composables/useRepaymentSignal.js'
import { useActivityFocus } from '../composables/useActivityFocus.js'
import { fetchActivity } from '../api/index.js'
import { formatShanghaiDate, formatShanghaiDateTime } from '../utils/format.js'
import {
  activityStatusText,
  activityStatusTone,
  activitySummary,
} from '../utils/activity.js'
import ChatPanel from '../components/ChatPanel.vue'
import BotAvatar from '../components/BotAvatar.vue'
import AgentTasksSection from '../components/AgentTasksSection.vue'
import BusinessInfoPanel from '../components/BusinessInfoPanel.vue'

const { newChat, sessionId, conversations, conversationsLoading, openConversation, loadConversations } = useChatSession()
const { backToOverview, navigate } = useNavigation()
const { version: tasksVersion } = useTasksSignal()
const { focus: focusActivity } = useActivityFocus()

// 当前上海日期（工作区标题下方展示）
const today = formatShanghaiDate(new Date().toISOString())

// 历史栏（最近对话 / 最近业务记录）
const historyOpen = ref(true)
const recentActivity = ref([])
const activityLoading = ref(false)

// 最近对话主题：优先后端标题（首条用户消息），空则「新对话」，超 15 字截断（仅展示，不影响列表 / 键）
function conversationTitle(c) {
  const t = ((c && c.title) || '').replace(/\s+/g, ' ').trim()
  if (!t) return '新对话'
  return t.length > 15 ? t.slice(0, 14) + '…' : t
}

// 业务记录主题：与独立「最近任务」页共用同一套摘要文案（转账给某人 / 暂停某订阅 / 冻结尾号 / 订阅审查）
function activityTopic(r) {
  const base = activitySummary(r)
  return base.length > 15 ? base.slice(0, 14) + '…' : base
}

// 业务类型图标（本地 SVG；按类型区分，不用状态色，避免与右侧状态徽章混淆）
const KIND_ICONS = {
  transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  card_op: '<svg viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg>',
  subscription_op: '<svg viewBox="0 0 24 24" fill="none" stroke="#0891b2" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  repayment: '<svg viewBox="0 0 24 24" fill="none" stroke="#db2777" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M8 15h5"/></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="#0d9488" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/></svg>',
}
function kindIcon(r) {
  return KIND_ICONS[r.kind] || '<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>'
}

async function loadRecentActivity() {
  activityLoading.value = true
  try {
    const res = await fetchActivity({ limit: 8, offset: 0 })
    recentActivity.value = res.rows
  } catch {
    recentActivity.value = []
  } finally {
    activityLoading.value = false
  }
}

// 点击左侧某条业务记录：聚焦该记录并跳转到独立「最近任务」页展开详情
function openActivity(r) {
  if (!r) return
  focusActivity(r.key)
  navigate('tasks')
}

function toggleHistory() {
  historyOpen.value = !historyOpen.value
}

// 任务 / 转账 / 银行卡 / 订阅任一业务记录变化时同步历史栏
const { version: dataVersion } = useDataRefresh()
const { version: transferVersion } = useTransferSignal()
const { version: cardOpVersion } = useCardOpSignal()
const { version: subOpVersion } = useSubscriptionOpSignal()
const { version: repaymentVersion } = useRepaymentSignal()

onMounted(() => {
  loadRecentActivity()
  loadConversations()
})

watch([tasksVersion, dataVersion, transferVersion, cardOpVersion, subOpVersion, repaymentVersion], loadRecentActivity)
</script>

<template>
  <div class="assistant-view">
    <!-- 对话历史栏（可收起） -->
    <aside class="history-bar" :class="{ 'is-collapsed': !historyOpen }">
      <div class="history-head">
        <span class="history-title">对话历史</span>
        <button class="history-toggle" :title="historyOpen ? '收起历史' : '展开历史'" @click="toggleHistory">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="historyOpen" d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
            <path v-else d="M13 5l7 7-7 7M6 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <button class="history-new" @click="newChat">＋ 新对话</button>

      <div class="history-block">
        <span class="history-block-label">最近对话</span>
        <p v-if="conversationsLoading" class="history-empty">加载中…</p>
        <p v-else-if="conversations.length === 0" class="history-empty">暂无对话</p>
        <button
          v-for="c in conversations"
          :key="c.id"
          class="history-item"
          :class="{ 'is-current': c.id === sessionId }"
          :title="c.title"
          @click="openConversation(c.id)"
        >
          <span class="history-conv-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-8 8H4l2.2-3.2A8 8 0 1 1 21 12Z" />
            </svg>
          </span>
          <span class="history-item-title">{{ conversationTitle(c) }}</span>
          <span class="history-item-time">{{ formatShanghaiDateTime(c.lastActiveAt) }}</span>
        </button>
      </div>

      <div class="history-block">
        <span class="history-block-label">最近任务</span>
        <p v-if="activityLoading" class="history-empty">加载中…</p>
        <p v-else-if="recentActivity.length === 0" class="history-empty">暂无业务记录</p>
        <button
          v-for="r in recentActivity"
          :key="r.key"
          class="history-item act-item"
          :title="`${activitySummary(r)} · ${activityStatusText(r)}`"
          @click="openActivity(r)"
        >
          <span class="task-status-icon" v-html="kindIcon(r)"></span>
          <span class="act-item-main">
            <span class="history-item-title">{{ activityTopic(r) }}</span>
            <span class="act-item-meta">
              <span class="status-badge" :class="activityStatusTone(r)">{{ activityStatusText(r) }}</span>
              <span class="history-item-time">{{ formatShanghaiDateTime(r.created_at) }}</span>
            </span>
          </span>
        </button>
        <button v-if="recentActivity.length" class="history-view-all" @click="navigate('tasks')">查看全部 →</button>
      </div>
    </aside>

    <!-- 中央对话 / 任务区 -->
    <div class="assistant-central">
      <header class="central-head">
        <div class="central-title-wrap">
          <h1 class="central-title">
            <BotAvatar :size="30" />
            <span>AI 助手</span>
          </h1>
          <p class="central-subtitle">今天 · {{ today }}</p>
        </div>
        <button class="btn-ghost btn-sm" @click="backToOverview">返回总览</button>
      </header>

      <div class="central-body">
        <div class="task-progress">
          <AgentTasksSection minimal />
        </div>
        <div class="chat-wrap">
          <ChatPanel />
        </div>
      </div>
    </div>

    <!-- 右侧业务信息栏 -->
    <aside class="biz-bar">
      <div class="biz-bar-head">
        <span class="biz-bar-title">业务信息</span>
      </div>
      <BusinessInfoPanel />
    </aside>
  </div>
</template>

<style scoped>
.assistant-view {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-height: 0;
}
.history-bar {
  width: 250px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow-y: auto;
  transition: width 0.2s ease;
}
.history-bar.is-collapsed {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  border-right: none;
  overflow: hidden;
}
.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.history-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--navy);
  white-space: nowrap;
}
.history-toggle {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  flex-shrink: 0;
}
.history-toggle svg {
  width: 15px;
  height: 15px;
}
.history-new {
  background: var(--blue);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
}
.history-new:hover {
  background: var(--blue-dark);
}
.history-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.history-block-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  color: var(--text);
}
.history-item:hover {
  border-color: var(--blue);
}
.history-item.is-current {
  cursor: default;
  background: var(--blue-light);
  border-color: #bfdbfe;
}
.history-item-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.history-conv-icon {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: #dbeafe;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.history-conv-icon svg {
  width: 15px;
  height: 15px;
}
.task-status-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: block;
}
.task-status-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.history-empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.act-item {
  align-items: flex-start;
}
.act-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.act-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.act-item-meta .status-badge {
  font-size: 10px;
  padding: 1px 7px;
}
.act-item-meta .history-item-time {
  font-size: 11px;
}
.history-view-all {
  margin-top: 2px;
  align-self: flex-start;
  background: transparent;
  border: none;
  color: var(--blue);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 2px;
}
.history-view-all:hover {
  color: var(--blue-dark);
}

.assistant-central {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  gap: 12px;
  min-height: 0;
}
.central-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.central-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.central-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--navy);
  line-height: 1.2;
}
.central-subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
}
.btn-sm {
  padding: 5px 12px;
  font-size: 13px;
  flex-shrink: 0;
}
.central-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.task-progress {
  /* 紧凑顶部任务区：仅容纳活动任务卡（卡片自带边框），无任务时高度为 0，不占空间。
     展开的任务卡受 max-height 限制并可滚动；折叠卡保持单行，不额外撑高顶部区域。 */
  flex-shrink: 0;
  max-height: 42%;
  overflow-y: auto;
}
.chat-wrap {
  flex: 1;
  min-height: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
}

.biz-bar {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: #fff;
  display: flex;
  flex-direction: column;
}
.biz-bar-head {
  padding: 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.biz-bar-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--navy);
}
.biz-bar :deep(.biz-info) {
  flex: 1;
  min-height: 0;
}

/* 平板（768—1279）：收起右侧业务信息栏，历史栏收窄 */
@media (max-width: 1279px) and (min-width: 768px) {
  .history-bar {
    width: 200px;
  }
  .biz-bar {
    display: none;
  }
}

/* 手机（<768）：隐藏历史栏与业务信息栏，仅保留中央对话 */
@media (max-width: 767px) {
  .history-bar,
  .biz-bar {
    display: none;
  }
  .assistant-central {
    padding: 12px;
  }
  .task-progress {
    max-height: 36%;
  }
}
</style>
