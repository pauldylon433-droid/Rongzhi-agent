<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchSubscriptions, createSubscriptionOperation } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import SectionState from './SectionState.vue'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'

const { data, loading, error, load } = useAsyncData(fetchSubscriptions)
const { version } = useDataRefresh()

const op = ref(null) // 当前订阅操作单初始视图（确认卡组件内部回读最新状态）
const creating = ref(false)
const opError = ref('')

onMounted(load)

// 任何一处完成暂停 / 恢复 / 取消后，订阅列表自动回读最新状态（保持当前筛选不变）
watch(version, () => {
  load()
})

const statusText = { active: '生效', paused: '暂停', cancelled: '已取消' }
const cycleText = { monthly: '按月', yearly: '按年' }
function statusTone(status) {
  return { active: 'is-ok', paused: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}
function cycleLabel(cycle) {
  return cycleText[cycle] || cycle || '—'
}

// —— 按状态筛选（仅前端完整列表过滤；接口返回完整列表、无分页）——
const subStatusFilter = ref('') // '' = 全部

// 状态枚举与后端一致（active / paused / cancelled），不按商户名、扣费日期或金额猜测
const SUB_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'active', label: '生效' },
  { value: 'paused', label: '暂停' },
  { value: 'cancelled', label: '已取消' },
]

// 按状态筛选，保持接口原有记录顺序；未知状态仅在「全部」中展示（statusText 兜底「未知状态」）
const filteredSubs = computed(() => {
  const list = data.value || []
  return subStatusFilter.value === '' ? list : list.filter((s) => s.status === subStatusFilter.value)
})

// 当前上海日期（YYYY-MM-DD，用于判断原扣费日期是否已过）
function shanghaiTodayStr() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// 扣费日期文案：不编造日期；暂停 / 取消不提示「即将扣费」；生效但原扣费日期已过 → 待更新。
function dateText(s) {
  if (s.status === 'cancelled') return '已取消，不再扣费'
  if (s.status === 'paused') return '已暂停，不自动扣费'
  const d = s.next_billing_date ? formatShanghaiDate(s.next_billing_date) : ''
  if (!d || d < shanghaiTodayStr()) return '扣费日期待更新'
  return `下次扣费 ${d}`
}

const isEmptyAll = computed(() => !loading.value && !error.value && !(data.value && data.value.length))
const isEmptyFilter = computed(() => !loading.value && !error.value && !isEmptyAll.value && filteredSubs.value.length === 0)
const emptyText = computed(() => (isEmptyFilter.value ? '该状态下暂无订阅' : '暂无订阅'))

async function onAction(sub, action) {
  opError.value = ''
  creating.value = true
  try {
    op.value = await createSubscriptionOperation({ subscription_id: sub.id, action })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成操作单失败'
  } finally {
    creating.value = false
  }
}

function onDone() {
  op.value = null
  opError.value = ''
  load() // 立即回读订阅列表，展示最新状态
}

function dismiss() {
  op.value = null
  opError.value = ''
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">订阅与代扣</h2>
      <div class="filter">
        <label class="filter-label">状态</label>
        <select v-model="subStatusFilter" class="select" aria-label="订阅状态">
          <option v-for="o in SUB_STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
    </div>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="isEmptyAll || isEmptyFilter"
      :empty-text="emptyText"
      @retry="load"
    />

    <ul v-if="!loading && !error && filteredSubs.length" class="sub-list">
      <li v-for="s in filteredSubs" :key="s.id" class="sub-item">
        <div class="sub-main">
          <span class="sub-merchant">{{ s.merchant }}</span>
          <span class="sub-meta">
            {{ formatCentsToYuan(s.amount_cents) }} 元 / {{ cycleLabel(s.billing_cycle) }}
          </span>
        </div>
        <div class="sub-side">
          <span class="sub-date">{{ dateText(s) }}</span>
          <span class="status-badge" :class="statusTone(s.status)">
            {{ statusText[s.status] || '未知状态' }}
          </span>
          <div v-if="s.status !== 'cancelled'" class="sub-actions">
            <button
              v-if="s.status === 'active'"
              class="sub-btn"
              :disabled="creating"
              @click="onAction(s, 'pause')"
            >
              暂停
            </button>
            <button
              v-else-if="s.status === 'paused'"
              class="sub-btn sub-btn-warn"
              :disabled="creating"
              @click="onAction(s, 'resume')"
            >
              恢复
            </button>
            <button
              class="sub-btn sub-btn-ghost"
              :disabled="creating"
              @click="onAction(s, 'cancel')"
            >
              取消
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 共享确认卡（确认 / 强验证规则与聊天入口一致） -->
    <p v-if="opError" class="op-error">{{ opError }}</p>
    <SubscriptionOperationConfirmCard v-if="op" :op="op" @confirmed="onDone" @cancelled="onDone" />
    <button v-if="op" class="btn-ghost dismiss-btn" @click="dismiss">关闭</button>
  </section>
</template>

<style scoped>
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.section-head .section-title {
  margin: 0;
}
.filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 13px;
  color: var(--muted);
}
.sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sub-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.sub-item:last-child {
  border-bottom: none;
}
.sub-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sub-merchant {
  font-weight: 600;
  color: var(--text);
}
.sub-meta {
  font-size: 13px;
  color: var(--muted);
}
.sub-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}
.sub-date {
  font-size: 12px;
  color: var(--muted);
}
.sub-actions {
  display: flex;
  gap: 8px;
}
.sub-btn {
  border: 1px solid var(--blue);
  background: #fff;
  color: var(--blue);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.sub-btn:hover:not(:disabled) {
  background: var(--blue-light);
}
.sub-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.sub-btn-warn {
  border-color: #b45309;
  color: #b45309;
}
.sub-btn-warn:hover:not(:disabled) {
  background: #fef3c7;
}
.sub-btn-ghost {
  border-color: #b91c1c;
  color: #b91c1c;
}
.sub-btn-ghost:hover:not(:disabled) {
  background: #fee2e2;
}
.op-error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #b91c1c;
}
.dismiss-btn {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .filter {
    flex-wrap: wrap;
  }
  .sub-item {
    flex-direction: column;
    align-items: flex-start;
  }
  .sub-side {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>
