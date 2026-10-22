<script setup>
import { onMounted } from 'vue'
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
</script>

<template>
  <section class="section">
    <h2 class="section-title">订阅与代扣</h2>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && (!data || data.length === 0)"
      empty-text="暂无订阅"
      @retry="load"
    />

    <ul v-if="!loading && !error && data && data.length" class="sub-list">
      <li v-for="s in data" :key="s.id" class="sub-item">
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
