<script setup>
import { onMounted } from 'vue'
import { fetchCards } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { formatCentsToYuan } from '../utils/format.js'
import SectionState from './SectionState.vue'

const { data, loading, error, load } = useAsyncData(fetchCards)
onMounted(load)

const statusText = { active: '正常', frozen: '冻结', cancelled: '已注销' }
function statusTone(status) {
  return { active: 'is-ok', frozen: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}
</script>

<template>
  <section class="section">
    <h2 class="section-title">银行卡</h2>

    <SectionState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && (!data || data.length === 0)"
      empty-text="暂无银行卡"
      @retry="load"
    />

    <div v-if="!loading && !error && data && data.length" class="card-grid">
      <div v-for="c in data" :key="c.id" class="bank-card">
        <div class="bank-card-head">
          <span class="bank-card-type">{{ c.card_type }}</span>
          <span class="status-badge" :class="statusTone(c.status)">
            {{ statusText[c.status] || '未知状态' }}
          </span>
        </div>
        <div class="bank-card-number">{{ c.masked_card_number }}</div>
        <div class="bank-card-limit">单日限额 {{ formatCentsToYuan(c.daily_limit_cents) }} 元</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.bank-card {
  border-radius: 12px;
  padding: 18px;
  background: linear-gradient(135deg, #0b2545 0%, #1e3a8a 100%);
  color: #fff;
}
.bank-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bank-card-type {
  font-size: 13px;
  color: #bfdbfe;
}
.bank-card-number {
  font-size: 18px;
  letter-spacing: 2px;
  margin-top: 14px;
  font-variant-numeric: tabular-nums;
}
.bank-card-limit {
  font-size: 12px;
  color: #cbd5e1;
  margin-top: 14px;
}
</style>
