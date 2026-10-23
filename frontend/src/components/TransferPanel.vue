<script setup>
import { ref, computed, onMounted } from 'vue'
import { fetchTransferRecipients, createTransfer, fetchCards, fetchAccounts } from '../api/index.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useCardSelection } from '../composables/useCardSelection.js'
import { yuanToCents, formatCentsToYuan } from '../utils/format.js'
import {
  accountsIndex, isActivePayerCard, isFiniteCents, resolveAccountName, resolveDebitBalance,
} from '../utils/cardBalance.js'
import TransferConfirmCard from './TransferConfirmCard.vue'

const { refresh } = useDataRefresh()
const { selectedCard } = useCardSelection()

const recipients = ref([])
const recipientsLoading = ref(false)
const recipientsError = ref('')

// 付款账户：仅现金存款类（account_type='deposit'、账户与卡片均 active）可对外转账。
// 初始值只取「当前全局选中的借记卡」；若当前选中信用卡或无选中，则不预选（不静默选第一张）。
const payerAccounts = ref([])
const payersLoading = ref(false)
const payersError = ref('')
const fromAccountId = ref(0) // 0 表示未选择
const selectedIsCredit = computed(() => !!selectedCard.value && selectedCard.value.account_type === 'credit')

const recipientId = ref(0) // 0 表示未选择
const amountText = ref('')
const remark = ref('')

const creating = ref(false)
const formError = ref('')

const op = ref(null) // 当前转账单初始视图（确认卡组件内部回读最新状态）

async function loadRecipients() {
  recipientsLoading.value = true
  recipientsError.value = ''
  try {
    recipients.value = await fetchTransferRecipients()
  } catch (e) {
    recipientsError.value = e && e.message ? e.message : '加载收款人失败'
  } finally {
    recipientsLoading.value = false
  }
}

async function loadPayerAccounts() {
  payersLoading.value = true
  payersError.value = ''
  try {
    const cards = await fetchCards()
    // 旧接口无 account_status / balance_cents：按 account_id 关联账户接口（只读，仅一次）
    let idx = new Map()
    const needAccounts = (cards || []).some((c) => !c.account_status || !isFiniteCents(c.balance_cents))
    if (needAccounts) {
      try {
        idx = accountsIndex(await fetchAccounts())
      } catch {
        // 账户接口不可用时仍按卡片自身字段判断；余额显示「暂无法获取」，不影响服务端余额校验
      }
    }
    const list = (cards || [])
      .filter((c) => isActivePayerCard(c, idx))
      .map((c) => ({
        ...c,
        resolvedName: resolveAccountName(c, idx) || c.account_name || '',
        resolvedBalance: resolveDebitBalance(c, idx),
      }))
    payerAccounts.value = list
    const cur = selectedCard.value
    if (cur && cur.account_type === 'deposit' && list.some((c) => c.account_id === cur.account_id)) {
      fromAccountId.value = cur.account_id
    }
  } catch (e) {
    payersError.value = e && e.message ? e.message : '加载付款账户失败'
  } finally {
    payersLoading.value = false
  }
}

async function onCreate() {
  formError.value = ''
  const cents = yuanToCents(amountText.value)
  if (cents === null) {
    formError.value = '请输入正确金额（非负，最多两位小数）'
    return
  }
  if (cents <= 0) {
    formError.value = '金额必须大于 0'
    return
  }
  if (!recipientId.value) {
    formError.value = '请选择收款人'
    return
  }
  if (!fromAccountId.value) {
    formError.value = '请选择付款账户（借记卡 / 活期账户）'
    return
  }
  creating.value = true
  try {
    op.value = await createTransfer({
      recipient_id: recipientId.value,
      amount_cents: cents,
      remark: remark.value,
      from_account_id: fromAccountId.value,
    })
  } catch (e) {
    formError.value = e && e.message ? e.message : '生成转账单失败'
  } finally {
    creating.value = false
  }
}

function onConfirmed() {
  refresh() // 账户 / 流水 / 月度统计一致刷新
}

function dismiss() {
  op.value = null
  amountText.value = ''
  remark.value = ''
  recipientId.value = 0
  formError.value = ''
}

onMounted(() => {
  loadRecipients()
  loadPayerAccounts()
})
</script>

<template>
  <section class="section">
    <h2 class="section-title">模拟转账</h2>
    <p class="transfer-note">模拟银行环境 · 转账仅为演示，不涉及真实资金；收款人为虚构数据。</p>

    <!-- 生成转账单表单 -->
    <div class="transfer-form">
      <div class="field">
        <label class="field-label" for="transfer-payer">付款账户</label>
        <p v-if="payersLoading" class="field-hint">正在加载借记账户…</p>
        <p v-else-if="payersError" class="field-warn">{{ payersError }}</p>
        <template v-else>
          <select id="transfer-payer" v-model="fromAccountId" class="select" aria-label="付款账户">
            <option :value="0" disabled>请选择付款账户（借记卡）</option>
            <option v-for="c in payerAccounts" :key="c.id" :value="c.account_id">
              {{ c.resolvedName || '关联账户' }}（{{ c.masked_card_number }}）· 可用
              {{ c.resolvedBalance.available ? `${formatCentsToYuan(c.resolvedBalance.cents)} 元` : '暂无法获取' }}
            </option>
          </select>
          <p v-if="selectedIsCredit" class="field-warn">当前选中的是信用卡，不能作为对外付款账户，请选择借记账户。</p>
          <p v-else-if="payerAccounts.length === 0" class="field-warn">没有可用的借记付款账户。</p>
        </template>
      </div>

      <div class="field">
        <label class="field-label" for="transfer-recipient">收款人</label>
        <p v-if="recipientsLoading" class="field-hint">正在加载收款人…</p>
        <p v-else-if="recipientsError" class="field-warn">{{ recipientsError }}</p>
        <select v-else id="transfer-recipient" v-model="recipientId" class="select" aria-label="收款人">
          <option :value="0" disabled>请选择收款人</option>
          <option v-for="r in recipients" :key="r.id" :value="r.id">
            {{ r.name }}（{{ r.masked_account }}）
          </option>
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="transfer-amount">金额（元）</label>
        <input
          id="transfer-amount"
          v-model="amountText"
          class="input"
          type="text"
          inputmode="decimal"
          placeholder="例如 100.00"
        />
      </div>

      <div class="field">
        <label class="field-label" for="transfer-remark">备注（可选）</label>
        <input
          id="transfer-remark"
          v-model="remark"
          class="input"
          type="text"
          maxlength="200"
          placeholder="例如 周末聚餐"
        />
      </div>

      <p v-if="formError" class="form-error">{{ formError }}</p>

      <button class="btn" :disabled="creating || recipientsLoading" @click="onCreate">
        {{ creating ? '生成中…' : '生成转账单' }}
      </button>
    </div>

    <!-- 共享确认卡（确认 / 取消规则与聊天入口一致） -->
    <TransferConfirmCard v-if="op" :op="op" @confirmed="onConfirmed" />

    <button v-if="op" class="btn-ghost dismiss-btn" @click="dismiss">关闭 / 新转账</button>
  </section>
</template>

<style scoped>
.transfer-note {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--muted);
}
.transfer-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 480px;
  margin-bottom: 20px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.field-hint,
.field-warn {
  font-size: 13px;
  margin: 0;
}
.field-hint {
  color: var(--muted);
}
.field-warn {
  color: #b45309;
}
.input {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  color: var(--text);
  background: #fff;
}
.input:focus {
  outline: none;
  border-color: #2563eb;
}
.form-error {
  margin: 0;
  font-size: 13px;
  color: #b91c1c;
}
.dismiss-btn {
  margin-top: 12px;
}
</style>
