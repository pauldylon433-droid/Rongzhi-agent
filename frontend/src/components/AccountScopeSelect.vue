<script setup>
// 账户查询范围选择器（交易流水 / 月度账单共用）。
// 唯一状态源是全局选卡单例（useCardSelection）：
//   「全部账户」= 清除全局选卡；选择具体账户 = 写入该账户（及其卡片）范围。
// 与银行卡页的选卡保持同步，不维护第二份过滤状态；当前范围始终以文字显示在控件旁。
import { computed, onMounted, ref } from 'vue'
import { useCardSelection } from '../composables/useCardSelection.js'

const {
  selectedAccountId,
  selectedCard,
  ensureAccounts,
  ensureCards,
  selectAccountById,
  cardForAccount,
} = useCardSelection()

const accounts = ref([])
const loadError = ref('')

const value = computed(() => (selectedAccountId.value === null ? 'all' : String(selectedAccountId.value)))

// 当前查询范围（始终展示；不依赖账户列表是否加载完成）
const scopeText = computed(() => {
  const c = selectedCard.value
  if (!c) return '全部账户'
  const type = c.account_type === 'credit' ? '信用卡' : '借记卡'
  return c.masked_card_number ? `${c.account_name}（${type} ${c.masked_card_number}）` : `${c.account_name}（${type}）`
})

function accountTypeText(type) {
  return type === 'credit' ? '信用卡' : '借记卡'
}
function optionLabel(acc) {
  const card = cardForAccount(acc.id)
  const masked = card && card.masked_card_number ? ` ${card.masked_card_number}` : ''
  return `${acc.account_name}（${accountTypeText(acc.account_type)}${masked}）`
}

async function refresh() {
  loadError.value = ''
  try {
    const [list] = await Promise.all([ensureAccounts(), ensureCards()])
    accounts.value = list || []
  } catch (e) {
    loadError.value = e && e.message ? e.message : '加载账户列表失败'
  }
}

function onChange(event) {
  const v = event.target.value
  selectAccountById(v === 'all' ? null : Number(v))
}

onMounted(refresh)
</script>

<template>
  <div class="account-scope">
    <span class="scope-current" data-testid="scope-current">查询范围：<strong>{{ scopeText }}</strong></span>
    <label class="scope-field">
      <span class="scope-label">账户</span>
      <select class="select" :value="value" aria-label="账户查询范围" @change="onChange">
        <option value="all">全部账户</option>
        <option v-for="acc in accounts" :key="acc.id" :value="String(acc.id)">
          {{ optionLabel(acc) }}
        </option>
      </select>
    </label>
    <span v-if="loadError" class="scope-warn">{{ loadError }}</span>
  </div>
</template>

<style scoped>
.account-scope {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.scope-current {
  font-size: 13px;
  color: var(--muted);
}
.scope-current strong {
  font-weight: 600;
  color: var(--text);
}
.scope-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.scope-label {
  font-size: 13px;
  color: var(--muted);
}
.scope-warn {
  font-size: 12px;
  color: #b45309;
}
</style>
