<script setup>
import { computed, onMounted, watch } from 'vue'
import { fetchAccounts, fetchCreditAccounts } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatMoney, formatCentsToYuan } from '../utils/format.js'
import SectionState from './SectionState.vue'

const { data, loading, error, load } = useAsyncData(fetchAccounts)
const { data: creditAccounts, loading: creditLoading, load: loadCredit } = useAsyncData(fetchCreditAccounts)

function loadAll() {
  load()
  loadCredit()
}

onMounted(loadAll)

// 转账 / 还款成功后刷新余额与信用额度
const { version } = useDataRefresh()
watch(version, loadAll)

// 信用账户映射：account_id → 信用账户（额度 / 已入账未还 / 可用额度）
const creditByAccountId = computed(() => {
  const m = {}
  for (const ca of creditAccounts.value || []) m[ca.account_id] = ca
  return m
})

const statusText = { active: '正常', frozen: '冻结', closed: '已销户' }
function statusTone(status) {
  return { active: 'is-ok', frozen: 'is-warn', closed: 'is-muted' }[status] || 'is-muted'
}
</script>

<template>
  <section class="section">
    <h2 class="section-title">账户概览</h2>

    <SectionState
      :loading="loading || creditLoading"
      :error="error"
      :empty="!loading && !creditLoading && !error && (!data || data.length === 0)"
      empty-text="暂无账户"
      @retry="loadAll"
    />

    <div v-if="!loading && !creditLoading && !error && data && data.length" class="account-grid">
      <div v-for="acc in data" :key="acc.id" class="account-card" :class="{ 'is-credit': acc.account_type === 'credit' }">
        <div class="account-head">
          <span class="account-name">{{ acc.account_name }}</span>
          <span class="status-badge" :class="statusTone(acc.status)">
            {{ statusText[acc.status] || '未知状态' }}
          </span>
        </div>

        <!-- 活期：当前余额；信用：可用额度（不展示「存款余额」语义） -->
        <template v-if="acc.account_type === 'credit'">
          <div class="account-balance">{{ formatCentsToYuan(creditByAccountId[acc.id]?.available_credit_cents ?? 0) }} 元</div>
          <div class="account-meta">可用额度 · 信用账户</div>
          <div v-if="creditByAccountId[acc.id]" class="account-credit-sub">
            总额度 {{ formatCentsToYuan(creditByAccountId[acc.id].credit_limit_cents) }} 元 ·
            已入账未还 {{ formatCentsToYuan(creditByAccountId[acc.id].posted_outstanding_cents) }} 元 ·
            待入账占用 {{ formatCentsToYuan(creditByAccountId[acc.id].pending_occupied_cents) }} 元
          </div>
          <div v-if="creditByAccountId[acc.id]" class="account-credit-eq">
            可用额度 = 总额度 − 已入账未还 − 待入账占用
          </div>
        </template>
        <template v-else>
          <div class="account-balance">{{ formatMoney(acc.balance_cents, acc.currency) }}</div>
          <div class="account-meta">当前余额 · {{ acc.currency }}</div>
        </template>
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
.account-card.is-credit {
  background: linear-gradient(135deg, #faf5ff 0%, #ffffff 100%);
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
.account-card.is-credit .account-balance {
  color: #4c1d95;
}
.account-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.account-credit-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
  line-height: 1.5;
}
.account-credit-eq {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
  opacity: 0.85;
}
</style>
