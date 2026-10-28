<script setup>
// 最近任务：统一业务记录列表（转账 / 银行卡 / 订阅 / 跨场景任务）。
// 事实来源为后端 /api/activity 只读聚合（原业务表），不含聊天 toolRecords；详情紧贴对应记录行内展开、
// 每次仅展开一条，继续处理请在对应业务页面或 AI 工作区进行，本页不提供快速执行入口。
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { fetchActivity } from '../api/index.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useTasksSignal } from '../composables/useTasksSignal.js'
import { useTransferSignal } from '../composables/useTransferSignal.js'
import { useCardOpSignal } from '../composables/useCardOpSignal.js'
import { useSubscriptionOpSignal } from '../composables/useSubscriptionOpSignal.js'
import { useRepaymentSignal } from '../composables/useRepaymentSignal.js'
import { useActivityFocus } from '../composables/useActivityFocus.js'
import { formatShanghaiDateTime } from '../utils/format.js'
import {
  ACTIVITY_KIND_LABEL,
  activityStatusText,
  activityStatusTone,
  activitySummary,
  activityAmountText,
} from '../utils/activity.js'

const PAGE_SIZE = 20
const DETAIL_COLSPAN = 6

const rows = ref([])
const total = ref(0)
const page = ref(1)        // 1 起始
const type = ref('')       // '' = 全部类型
const status = ref('')     // '' = 全部状态
const loading = ref(true)
const error = ref('')
const selectedKey = ref(null)

const { focusKey, clear: clearFocus } = useActivityFocus()

const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'transfer', label: '转账' },
  { value: 'card_op', label: '银行卡' },
  { value: 'subscription_op', label: '订阅' },
  { value: 'repayment', label: '信用卡还款' },
  { value: 'task', label: '跨场景任务' },
]

// 状态选项：展示层统一为「待确认」（见 STATUS_QUERY），其余保持独立。
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待确认' },
  { value: 'needs_verification', label: '待强验证' },
  { value: 'waiting_selection', label: '等待选择' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' },
  { value: 'failed', label: '已失效' },
  { value: 'paused', label: '已暂停' },
  { value: 'manual', label: '手动处理' },
]

// 「待确认」合并筛选映射：一个语义选项对应多个底层状态
// （独立操作单 pending + 跨场景任务 waiting_confirmation，语义均为等待界面确认）。
const STATUS_QUERY = {
  pending: 'pending,waiting_confirmation',
}
function statusQuery() {
  if (!status.value) return undefined
  return STATUS_QUERY[status.value] || status.value
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < totalPages.value)

// 竞态防护：每次加载自增序号，仅最新一次请求允许写回结果，旧请求一律丢弃。
let requestId = 0

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const res = await fetchActivity({
      type: type.value || undefined,
      status: statusQuery(),
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    })
    if (id !== requestId) return
    rows.value = res.rows
    total.value = res.total

    // 来自左侧「最近任务」的聚焦：目标为最近记录，落在第 1 页；命中则展开并滚动到该记录，而非列表底部。
    let scrollKey = null
    if (focusKey.value) {
      const hit = res.rows.find((r) => r.key === focusKey.value)
      if (hit) {
        selectedKey.value = hit.key
        scrollKey = hit.key
      }
      clearFocus()
    }

    // 翻页 / 筛选后，展开记录已不在当前列表 → 清除展开状态
    if (selectedKey.value && !res.rows.some((r) => r.key === selectedKey.value)) {
      selectedKey.value = null
    }

    if (scrollKey) await scrollToSelected(scrollKey)
  } catch (e) {
    if (id !== requestId) return
    error.value = e && e.message ? e.message : '加载业务记录失败'
  } finally {
    if (id === requestId) loading.value = false
  }
}

// 滚动到展开记录行（详情行内展开后定位到记录本身，居中显示）
async function scrollToSelected(key) {
  await nextTick()
  try {
    const el = document.querySelector(`[data-act-key="${key}"]`)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    /* 忽略滚动失败 */
  }
}

function applyFilters() {
  page.value = 1
  selectedKey.value = null
  load()
}

function prevPage() {
  if (!hasPrev.value) return
  page.value -= 1
  load()
}

function nextPage() {
  if (!hasNext.value) return
  page.value += 1
  load()
}

function toggleDetail(row) {
  // 同一记录再次点击收起；点击另一条则关闭原详情，在新记录下方展开
  selectedKey.value = selectedKey.value === row.key ? null : row.key
}

// 业务数据变化（转账 / 银行卡 / 订阅 / 任务）后刷新当前页，保持列表与状态一致
const { version: dataVersion } = useDataRefresh()
const { version: tasksVersion } = useTasksSignal()
const { version: transferVersion } = useTransferSignal()
const { version: cardOpVersion } = useCardOpSignal()
const { version: subOpVersion } = useSubscriptionOpSignal()
const { version: repaymentVersion } = useRepaymentSignal()
watch([dataVersion, tasksVersion, transferVersion, cardOpVersion, subOpVersion, repaymentVersion], load)

onMounted(load)
</script>

<template>
  <div class="view-page">
    <header class="view-page-head">
      <div>
        <h1 class="view-page-title">最近任务</h1>
        <p class="view-page-subtitle">转账、银行卡、订阅、信用卡还款与跨场景任务</p>
      </div>
      <button class="btn-ghost" @click="load">刷新</button>
    </header>

    <section class="section">
      <div class="filter-toolbar act-filter">
        <label class="filter-label">业务类型</label>
        <select v-model="type" class="select" aria-label="业务类型" @change="applyFilters">
          <option v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <label class="filter-label">状态</label>
        <select v-model="status" class="select" aria-label="状态" @change="applyFilters">
          <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>

      <p v-if="loading" class="state-loading">加载中…</p>
      <div v-else-if="error" class="state-error">
        <p class="state-error-text">{{ error }}</p>
        <button class="btn-ghost" @click="load">重试</button>
      </div>
      <p v-else-if="rows.length === 0" class="state-empty">当前筛选条件下暂无业务记录</p>

      <div v-else class="act-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>业务类型</th>
              <th>对象 / 摘要</th>
              <th class="num">金额或周期</th>
              <th>状态</th>
              <th class="num">查看详情</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.key">
              <tr
                class="act-row"
                :class="{ 'is-selected': r.key === selectedKey }"
                :data-act-key="r.key"
                @click="toggleDetail(r)"
              >
                <td class="act-time">{{ formatShanghaiDateTime(r.created_at) }}</td>
                <td><span class="kind-tag">{{ ACTIVITY_KIND_LABEL[r.kind] || r.kind }}</span></td>
                <td class="act-summary">{{ activitySummary(r) }}</td>
                <td class="num act-amount">{{ activityAmountText(r) }}</td>
                <td><span class="status-badge" :class="activityStatusTone(r)">{{ activityStatusText(r) }}</span></td>
                <td class="num">
                  <span class="act-toggle">{{ r.key === selectedKey ? '收起' : '详情' }}</span>
                </td>
              </tr>
              <!-- 详情行：紧贴对应记录下方，colspan 跨全表，保持 HTML 结构有效 -->
              <tr v-if="r.key === selectedKey" class="act-detail-row">
                <td :colspan="DETAIL_COLSPAN">
                  <div class="act-detail">
                    <div class="act-detail-head">
                      <h3 class="act-detail-title">{{ activitySummary(r) }}</h3>
                      <span class="status-badge" :class="activityStatusTone(r)">{{ activityStatusText(r) }}</span>
                    </div>
                    <dl class="act-detail-grid">
                      <div class="act-detail-item">
                        <dt>业务类型</dt>
                        <dd>{{ ACTIVITY_KIND_LABEL[r.kind] || r.kind }}</dd>
                      </div>
                      <div class="act-detail-item">
                        <dt>对象</dt>
                        <dd>{{ r.object || '—' }}</dd>
                      </div>
                      <div class="act-detail-item">
                        <dt>金额或周期</dt>
                        <dd>{{ activityAmountText(r) }}</dd>
                      </div>
                      <div class="act-detail-item">
                        <dt>{{ r.kind === 'task' ? '任务编号' : '操作编号' }}</dt>
                        <dd class="act-ref">{{ r.kind === 'task' ? r.task_no : r.ref_no }}</dd>
                      </div>
                      <div v-if="r.month" class="act-detail-item">
                        <dt>账单月份</dt>
                        <dd>{{ r.month }}</dd>
                      </div>
                      <div class="act-detail-item">
                        <dt>创建时间</dt>
                        <dd>{{ formatShanghaiDateTime(r.created_at) }}</dd>
                      </div>
                      <div class="act-detail-item">
                        <dt>完成 / 更新时间</dt>
                        <dd>{{ formatShanghaiDateTime(r.completed_at || r.updated_at) }}</dd>
                      </div>
                      <div v-if="r.op_ref" class="act-detail-item">
                        <dt>关联操作单</dt>
                        <dd class="act-ref">{{ r.op_ref }}</dd>
                      </div>
                    </dl>
                    <p class="act-detail-note">记录为只读。如需继续处理，请在对应业务页面或 AI 工作区操作。</p>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="total > 0" class="pager">
        <span class="pager-total">共 {{ total }} 条</span>
        <div class="pager-controls">
          <button class="btn" :disabled="loading || !hasPrev" @click="prevPage">上一页</button>
          <span class="pager-info">第 {{ page }} / {{ totalPages }} 页</span>
          <button class="btn" :disabled="loading || !hasNext" @click="nextPage">下一页</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.act-filter {
  margin-bottom: 16px;
}
.act-table-wrap {
  overflow-x: auto;
}
.act-row {
  cursor: pointer;
}
.act-row:hover td {
  background: #f8fafc;
}
.act-row.is-selected td {
  background: var(--blue-light);
}
.act-time {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.kind-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 12px;
  background: #eef2ff;
  color: #4338ca;
  white-space: nowrap;
}
.act-summary {
  font-weight: 500;
}
.act-amount {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.act-toggle {
  color: var(--blue);
  font-weight: 500;
  white-space: nowrap;
}
/* 详情行：紧贴记录下方，背景与记录区分，仅作只读展开 */
.act-detail-row td {
  background: #f8fafc;
  padding: 0;
}
.act-detail {
  padding: 14px 16px;
  border-top: 1px solid var(--border);
}
.act-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.act-detail-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.act-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin: 0;
}
.act-detail-item {
  margin: 0;
}
.act-detail-item dt {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.act-detail-item dd {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}
.act-ref {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
}
.act-detail-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 16px;
  margin-top: 16px;
  border-top: 1px solid var(--border);
}
.pager-total {
  font-size: 13px;
  color: var(--muted);
}
.pager-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pager-info {
  font-size: 13px;
  color: var(--text);
}
</style>
