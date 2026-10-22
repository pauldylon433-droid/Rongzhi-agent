<script setup>
import { ref, computed, onMounted } from 'vue'
import { fetchSubscriptions } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import SectionState from './SectionState.vue'

const { data, loading, error, load } = useAsyncData(fetchSubscriptions)
onMounted(load)

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

const isEmptyAll = computed(() => !loading.value && !error.value && !(data.value && data.value.length))
const isEmptyFilter = computed(() => !loading.value && !error.value && !isEmptyAll.value && filteredSubs.value.length === 0)
const emptyText = computed(() => (isEmptyFilter.value ? '该状态下暂无订阅' : '暂无订阅'))
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
          <span class="sub-date">
            {{ s.status === 'cancelled' ? '已取消，不再扣费' : `下次扣费 ${formatShanghaiDate(s.next_billing_date)}` }}
          </span>
          <span class="status-badge" :class="statusTone(s.status)">
            {{ statusText[s.status] || '未知状态' }}
          </span>
        </div>
      </li>
    </ul>
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
