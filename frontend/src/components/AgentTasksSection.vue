<script setup>
// 跨场景任务区：展示当前活动任务进度卡（可折叠，折叠后仅一行）+ 简洁的最近任务入口。
// 展开状态按 task_no 记录于内存：新任务首次进入「等待选择 / 等待确认」自动展开一次；
// 用户手动折叠后，普通刷新与状态轮询不反复展开；完成 / 取消 / 历史任务默认折叠。
// 折叠 / 展开仅切换本地展示，不重新创建任务、不重复请求、不丢失卡片状态、不调用模型。
import { ref, computed, onMounted, watch, reactive } from 'vue'
import { fetchRecentAgentTasks, fetchAgentTask } from '../api/index.js'
import { useTasksSignal } from '../composables/useTasksSignal.js'
import { useChatSession } from '../composables/useChatSession.js'
import { deriveCurrentTaskNo } from '../utils/businessEvents.js'
import AgentTaskCard from './AgentTaskCard.vue'

const props = defineProps({
  compact: { type: Boolean, default: false },
  // minimal：仅渲染活动任务进度卡本身，隐藏「标题 / 刷新 / 查看全部」头部与「最近任务」重复列表，
  // 无任务时整体不渲染（不留空容器），供 AI 工作区顶部紧凑任务区使用。
  minimal: { type: Boolean, default: false },
  title: { type: String, default: '跨场景任务' },
  viewAllLabel: { type: String, default: '查看全部' },
})
const emit = defineEmits(['changed', 'view-all'])

const tasks = ref([])
const activeTaskNo = ref(null)
const loading = ref(true)
const error = ref('')

// 当前会话「当前业务」是否为跨场景任务（与右侧业务信息栏共用 deriveCurrentTaskNo 推导）。
// 顶部紧凑任务区仅展示当前业务为任务时的该真实任务，不默认把「最近一个任务」当作当前进度。
const { messages } = useChatSession()
const currentTaskNo = computed(() => deriveCurrentTaskNo(messages.value))

const statusText = {
  waiting_selection: '等待选择',
  waiting_confirmation: '等待确认',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
  manual: '手动处理',
}
function statusOf(t) {
  return statusText[t.status] || t.status
}

const activeTask = computed(() => tasks.value.find((t) => t.task_no === activeTaskNo.value) || null)
const restTasks = computed(() => {
  const list = tasks.value.filter((t) => t.task_no !== activeTaskNo.value)
  return props.compact ? list.slice(0, 3) : list
})

// 每任务展开状态：open（当前是否展开）、settled（是否已初始化；已初始化后刷新 / 轮询不再自动改动）
const expandState = reactive({})
function initExpand(t) {
  if (!t || expandState[t.task_no]) return
  const waiting = t.status === 'waiting_selection' || t.status === 'waiting_confirmation'
  expandState[t.task_no] = { open: waiting, settled: true }
}
function isOpen(t) {
  return !!(t && expandState[t.task_no] && expandState[t.task_no].open)
}
function toggle(t) {
  if (!t) return
  const st = expandState[t.task_no] || { open: false, settled: false }
  st.open = !st.open
  st.settled = true
}

async function load() {
  error.value = ''
  try {
    if (props.minimal) {
      // 顶部紧凑任务区：仅当「当前业务」是跨场景任务时，展示该真实后台任务；
      // 当前业务为独立订阅恢复 / 转账 / 银行卡操作等时，不挂出任何旧任务。
      const taskNo = currentTaskNo.value
      tasks.value = []
      activeTaskNo.value = null
      if (taskNo) {
        const t = await fetchAgentTask(taskNo)
        // 等待期间当前业务已切换（切换会话 / 新操作）→ 丢弃旧任务响应，不覆盖新状态
        if (currentTaskNo.value !== taskNo) return
        if (t) tasks.value = [t]
      }
      for (const t of tasks.value) initExpand(t)
      activeTaskNo.value = tasks.value.length ? tasks.value[0].task_no : null
    } else {
      tasks.value = await fetchRecentAgentTasks()
      for (const t of tasks.value) initExpand(t)
      // 保持当前正在查看的任务（若仍存在）；否则选第一条进行中，再否则最近一条。
      // 避免刷新 / 轮询把用户正在查看的（含历史）任务切走。
      if (!tasks.value.some((t) => t.task_no === activeTaskNo.value)) {
        const active = tasks.value.find((t) => !['completed', 'cancelled', 'manual'].includes(t.status))
        activeTaskNo.value = (active || tasks.value[0] || {}).task_no || null
      }
    }
  } catch (e) {
    error.value = e && e.message ? e.message : '加载任务失败'
  } finally {
    loading.value = false
  }
}

function onTaskChanged() {
  bumpTasks() // 任务状态已变化：通知历史栏 / 右侧业务信息 / 自身（watch tasksVersion）刷新
  emit('changed') // 总览等父级刷新账户 / 卡片等业务数据
}

function view(t) {
  activeTaskNo.value = t.task_no
}

// AI 助手启动跨场景任务后，任务区自动刷新
const { version: tasksVersion, bump: bumpTasks } = useTasksSignal()
// 任务状态变化（tasksVersion）或当前业务任务变化（切换会话 / 新任务 / 独立操作）均重新加载。
watch([tasksVersion, currentTaskNo], load)

defineExpose({ refresh: load })
onMounted(load)
</script>

<template>
  <section v-if="!minimal || activeTask" class="ats" :class="{ 'is-minimal': minimal }">
    <div v-if="!minimal" class="ats-head">
      <h3 class="ats-title">{{ title }}</h3>
      <div class="ats-head-actions">
        <button class="btn-ghost btn-sm" @click="load">刷新</button>
        <button v-if="compact" class="btn-ghost btn-sm" @click="emit('view-all')">{{ viewAllLabel }}</button>
      </div>
    </div>

    <p v-if="!minimal && loading" class="ats-empty">正在加载任务…</p>
    <p v-else-if="!minimal && error" class="ats-error">{{ error }}</p>

    <template v-else>
      <AgentTaskCard
        v-if="activeTask"
        :task="activeTask"
        :expanded="isOpen(activeTask)"
        @changed="onTaskChanged"
        @toggle="toggle(activeTask)"
      />
      <p v-else-if="!minimal" class="ats-empty">暂无进行中的跨场景任务。</p>

      <div v-if="!minimal && tasks.length" class="ats-recent">
        <span class="ats-recent-label">最近任务</span>
        <button
          v-for="t in restTasks"
          :key="t.task_no"
          class="ats-recent-item"
          @click="view(t)"
        >
          <span class="ats-recent-month">{{ t.month || '—' }}</span>
          <span class="ats-recent-status">{{ statusOf(t) }}</span>
          <span class="ats-recent-view">查看</span>
        </button>
        <button v-if="activeTask && restTasks.length === 0 && tasks.length <= 1" class="ats-recent-item is-current">
          <span class="ats-recent-month">{{ activeTask.month || '—' }}</span>
          <span class="ats-recent-status">{{ statusOf(activeTask) }}</span>
          <span class="ats-recent-view">当前</span>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ats {
  margin-bottom: 14px;
}
.ats.is-minimal {
  margin-bottom: 0;
}
.ats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.ats-head-actions {
  display: flex;
  gap: 8px;
}
.ats-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.btn-sm {
  padding: 3px 10px;
  font-size: 12px;
}
.ats-empty { margin: 0; font-size: 13px; color: var(--muted); }
.ats-error { margin: 0; font-size: 13px; color: #b91c1c; }
.ats-recent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}
.ats-recent-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.ats-recent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  color: var(--text);
}
.ats-recent-item:hover { border-color: var(--blue); }
.ats-recent-item.is-current { cursor: default; background: #f8fafc; }
.ats-recent-month { font-variant-numeric: tabular-nums; color: var(--text); }
.ats-recent-status { color: var(--muted); flex: 1; }
.ats-recent-view { color: var(--blue); font-weight: 500; }
</style>
