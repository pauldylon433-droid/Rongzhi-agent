<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { fetchCards, createCardOperation } from '../api/index.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan } from '../utils/format.js'
import SectionState from './SectionState.vue'
import CardOperationConfirmCard from './CardOperationConfirmCard.vue'

const { data, loading, error, load } = useAsyncData(fetchCards)
const { version } = useDataRefresh()

const op = ref(null) // 当前银行卡操作单初始视图（确认卡组件内部回读最新状态）
const creating = ref(false)
const opError = ref('')

onMounted(load)

// 任何一处完成冻结 / 解冻后，卡片列表自动回读最新状态
watch(version, () => {
  load()
})

const statusText = { active: '正常', frozen: '冻结', cancelled: '已注销' }
function statusTone(status) {
  return { active: 'is-ok', frozen: 'is-warn', cancelled: 'is-muted' }[status] || 'is-muted'
}

// —— 按卡种筛选（仅前端完整列表过滤；接口返回完整列表、无分页）——
const cardTypeFilter = ref('') // '' = 全部

// 固定提供 借记卡 / 信用卡；数据中出现的其它卡种按实际字段补充为可选项
const KNOWN_CARD_TYPES = ['借记卡', '信用卡']
const cardTypeOptions = computed(() => {
  const extras = [...new Set(
    (data.value || []).map((c) => c.card_type).filter((t) => t && !KNOWN_CARD_TYPES.includes(t)),
  )]
  return [...KNOWN_CARD_TYPES, ...extras]
})

// 卡种展示：空值兜底为「其他卡种」，不把未知卡种擅自归为借记卡 / 信用卡
function cardTypeLabel(type) {
  return type || '其他卡种'
}

// 按卡种筛选，保持接口原有记录顺序；冻结 / 解冻后 cardTypeFilter 不变、数据回读最新状态
const filteredCards = computed(() => {
  const list = data.value || []
  return cardTypeFilter.value === '' ? list : list.filter((c) => c.card_type === cardTypeFilter.value)
})

const isEmptyAll = computed(() => !loading.value && !error.value && !(data.value && data.value.length))
const isEmptyFilter = computed(() => !loading.value && !error.value && !isEmptyAll.value && filteredCards.value.length === 0)
const emptyText = computed(() => (isEmptyFilter.value ? '该卡种暂无银行卡' : '暂无银行卡'))

async function onAction(card, action) {
  opError.value = ''
  creating.value = true
  try {
    op.value = await createCardOperation({ card_id: card.id, action })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成操作单失败'
  } finally {
    creating.value = false
  }
}

function onDone() {
  op.value = null
  opError.value = ''
  load() // 立即回读卡片列表，展示最新状态
}

function dismiss() {
  op.value = null
  opError.value = ''
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">银行卡</h2>
      <div class="filter">
        <label class="filter-label">卡种</label>
        <select v-model="cardTypeFilter" class="select" aria-label="卡种">
          <option value="">全部</option>
          <option v-for="t in cardTypeOptions" :key="t" :value="t">{{ t }}</option>
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

    <div v-if="!loading && !error && filteredCards.length" class="card-grid">
      <div v-for="c in filteredCards" :key="c.id" class="bank-card">
        <div class="bank-card-head">
          <span class="bank-card-type">{{ cardTypeLabel(c.card_type) }}</span>
          <span class="status-badge" :class="statusTone(c.status)">
            {{ statusText[c.status] || '未知状态' }}
          </span>
        </div>
        <div class="bank-card-number">{{ c.masked_card_number }}</div>
        <div class="bank-card-limit">单日限额 {{ formatCentsToYuan(c.daily_limit_cents) }} 元</div>
        <div v-if="c.status !== 'cancelled'" class="bank-card-actions">
          <button
            v-if="c.status === 'active'"
            class="card-btn"
            :disabled="creating"
            @click="onAction(c, 'freeze')"
          >
            冻结
          </button>
          <button
            v-else-if="c.status === 'frozen'"
            class="card-btn card-btn-warn"
            :disabled="creating"
            @click="onAction(c, 'unfreeze')"
          >
            解冻
          </button>
        </div>
      </div>
    </div>

    <!-- 共享确认卡（确认 / 强验证规则与聊天入口一致） -->
    <p v-if="opError" class="op-error">{{ opError }}</p>
    <CardOperationConfirmCard v-if="op" :op="op" @confirmed="onDone" @cancelled="onDone" />
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
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
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
.bank-card-actions {
  margin-top: 14px;
}
.card-btn {
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.card-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.card-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.card-btn-warn {
  background: #b45309;
}
.card-btn-warn:hover:not(:disabled) {
  background: #92400e;
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
}
</style>
