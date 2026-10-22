<script setup>
import { onMounted, watch } from 'vue'
import { fetchAccounts } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatMoney } from '../utils/format.js'
import SectionState from './SectionState.vue'

const { data, loading, error, load } = useAsyncData(fetchAccounts)
onMounted(load)

// 转账成功后刷新余额，与交易流水、月度统计保持一致
const { version } = useDataRefresh()
watch(version, load)

const statusText = { active: '正常', frozen: '冻结', closed: '已销户' }
function statusTone(status) {
  return { active: 'is-ok', frozen: 'is-warn', closed: 'is-muted' }[status] || 'is-muted'
}
</script>

<template>
  <section class="section">
    <h2 class="section-title">账户概览</h2>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && (!data || data.length === 0)"
      empty-text="暂无账户"
      @retry="load"
    />

    <div v-if="!loading && !error && data && data.length" class="account-grid">
      <div v-for="acc in data" :key="acc.id" class="account-card">
        <div class="account-head">
          <span class="account-name">{{ acc.account_name }}</span>
          <span class="status-badge" :class="statusTone(acc.status)">
            {{ statusText[acc.status] || '未知状态' }}
          </span>
        </div>
        <div class="account-balance">{{ formatMoney(acc.balance_cents, acc.currency) }}</div>
        <div class="account-meta">当前余额 · {{ acc.currency }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.account-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px;
  background: linear-gradient(135deg, #f8fafc 0%, #ffffff 100%);
}
.account-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.account-name {
  font-weight: 600;
  color: var(--text);
  font-size: 15px;
}
.account-balance {
  font-size: 28px;
  font-weight: 700;
  color: var(--navy);
  margin-top: 12px;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
}
.account-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
</style>
