<script setup>
// 跨场景任务区：展示当前活动任务进度卡 + 简洁的最近任务入口（便于新对话后继续查看）。
// 刷新 / 后端重启后重新拉取即可恢复任务；不自动重发模型请求或业务操作。
import { ref, computed, onMounted } from 'vue'
import { fetchRecentAgentTasks } from '../api/index.js'
import AgentTaskCard from './AgentTaskCard.vue'

const emit = defineEmits(['changed'])

const tasks = ref([])
const activeTaskNo = ref(null)
const loading = ref(true)
const error = ref('')

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
const restTasks = computed(() => tasks.value.filter((t) => t.task_no !== activeTaskNo.value))

async function load() {
  error.value = ''
  try {
    tasks.value = await fetchRecentAgentTasks()
    const active = tasks.value.find((t) => !['completed', 'cancelled', 'manual'].includes(t.status))
    activeTaskNo.value = (active || tasks.value[0] || {}).task_no || null
  } catch (e) {
    error.value = e && e.message ? e.message : '加载任务失败'
  } finally {
    loading.value = false
  }
}

function onTaskChanged() {
  emit('changed') // 业务状态可能已变化（如订阅已暂停），通知上层刷新相关分区
  load()
}

function view(t) {
  activeTaskNo.value = t.task_no
}

defineExpose({ refresh: load })
onMounted(load)
</script>

<template>
  <section class="ats">
    <div class="ats-head">
      <h3 class="ats-title">跨场景任务</h3>
      <button class="btn-ghost btn-sm" @click="load">刷新</button>
    </div>

    <p v-if="loading" class="ats-empty">正在加载任务…</p>
    <p v-else-if="error" class="ats-error">{{ error }}</p>

    <template v-else>
      <AgentTaskCard v-if="activeTask" :task="activeTask" @changed="onTaskChanged" />

      <div v-if="tasks.length" class="ats-recent">
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
.ats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.ats-title {
  margin: 0;
  font-size: 14px;
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
