<script setup>
// 信用卡详情：额度 / 已入账未还 / 待入账占用 / 可用额度 + 账单列表 + 还款入口。
// 信用语义：不展示「存款余额」；未出账账单不显示为应还；冻结期间禁止新增消费但仍可还款（还款入口照常开放）。
// 还款仅支持「已出账账单剩余应还」的全额还款，恒为红色强验证，复用 RepaymentConfirmCard。
import { ref, computed, onMounted, watch } from 'vue'
import { fetchAccounts, fetchCreditAccount, createRepayment } from '../api/index.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import SectionState from './SectionState.vue'
import RepaymentConfirmCard from './RepaymentConfirmCard.vue'

const props = defineProps({
  card: { type: Object, required: true }, // 信用卡对象（含 credit_account_id 等）
})

const detail = ref(null)
const loading = ref(false)
const error = ref('')
const { refresh } = useDataRefresh()

// —— 还款表单状态 ——
const depositAccounts = ref([])
const repayingStatement = ref(null) // 正在还款的账单
const fromAccountId = ref(null)
const creating = ref(false)
const opError = ref('')
const op = ref(null) // 创建的还款单（交 RepaymentConfirmCard 回读最新状态）

const statementStatusText = { open: '已出账待还', overdue: '已逾期未还', paid: '已结清', unissued: '未出账' }
function statementStatusTone(s) {
  return { open: 'is-warn', overdue: 'is-danger', paid: 'is-ok', unissued: 'is-muted' }[s] || 'is-muted'
}

const statements = computed(() => (detail.value ? detail.value.statements || [] : []))
const summary = computed(() => detail.value || null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await fetchCreditAccount(props.card.credit_account_id)
  } catch (e) {
    error.value = e && e.message ? e.message : '加载信用卡详情失败'
  } finally {
    loading.value = false
  }
}

// 还款入口：拉取活期付款账户列表（仅活期可作还款来源）
async function startRepay(stmt) {
  opError.value = ''
  repayingStatement.value = stmt
  fromAccountId.value = null
  op.value = null
  try {
    const accts = await fetchAccounts()
    depositAccounts.value = (accts || []).filter((a) => a.account_type === 'deposit' && a.status === 'active')
    if (depositAccounts.value.length === 1) fromAccountId.value = depositAccounts.value[0].id
  } catch (e) {
    opError.value = e && e.message ? e.message : '加载付款账户失败'
  }
}

function cancelRepay() {
  repayingStatement.value = null
  fromAccountId.value = null
  opError.value = ''
}

async function submitRepay() {
  if (!repayingStatement.value) return
  opError.value = ''
  creating.value = true
  try {
    op.value = await createRepayment({
      statement_id: repayingStatement.value.id,
      from_account_id: fromAccountId.value,
    })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成还款单失败'
  } finally {
    creating.value = false
  }
}

// 还款完成 / 取消后：回读信用卡详情（额度 / 已还 / 剩余应还均已变化），并通知全局刷新（流水 / 余额 / 月度统计）。
function onRepaymentDone() {
  op.value = null
  repayingStatement.value = null
  fromAccountId.value = null
  refresh()
  load()
}

onMounted(load)

// 卡状态 / 数据变更后回读最新详情（冻结不影响还款入口，但额度快照需保持一致）
const { version } = useDataRefresh()
watch(version, load)
</script>

<template>
  <div class="ccd">
    <SectionState :loading="loading" :error="error" :empty="!loading && !error && !summary" empty-text="暂无信用卡信息" @retry="load" />

    <template v-if="summary">
      <!-- 信用额度汇总（不含「存款余额」语义） -->
      <div class="credit-summary">
        <div class="cs-item">
          <span class="cs-label">信用额度</span>
          <span class="cs-value">{{ formatCentsToYuan(summary.credit_limit_cents) }} 元</span>
        </div>
        <div class="cs-item">
          <span class="cs-label">已入账未还</span>
          <span class="cs-value">{{ formatCentsToYuan(summary.posted_outstanding_cents) }} 元</span>
        </div>
        <div class="cs-item">
          <span class="cs-label">待入账占用</span>
          <span class="cs-value">{{ formatCentsToYuan(summary.pending_occupied_cents) }} 元</span>
        </div>
        <div class="cs-item">
          <span class="cs-label">可用额度</span>
          <span class="cs-value is-avail">{{ formatCentsToYuan(summary.available_credit_cents) }} 元</span>
        </div>
      </div>

      <p v-if="props.card.status === 'frozen'" class="frozen-note">该卡已冻结：暂停新增消费，仍可正常还款。</p>

      <!-- 账单列表 -->
      <div class="stmt-head"><span class="stmt-title">账单</span></div>
      <p v-if="statements.length === 0" class="stmt-empty">暂无账单</p>
      <div v-else class="stmt-list">
        <div v-for="s in statements" :key="s.id" class="stmt-row">
          <div class="stmt-main">
            <span class="stmt-month">{{ s.statement_month }}</span>
            <span class="status-badge" :class="statementStatusTone(s.status)">{{ statementStatusText[s.status] || s.status }}</span>
            <span v-if="s.issued && s.due_on" class="stmt-due">到期 {{ formatShanghaiDate(s.due_on) }}</span>
          </div>
          <div class="stmt-meta">
            <span v-if="s.issued">新增 {{ formatCentsToYuan(s.new_charges_cents) }} 元 · 已还 {{ formatCentsToYuan(s.paid_cents) }} 元 · 剩余 {{ formatCentsToYuan(s.remaining_due_cents) }} 元</span>
            <span v-else>未出账消费不计入应还（待出账后生成账单）</span>
          </div>
          <div v-if="s.issued && s.remaining_due_cents > 0" class="stmt-actions">
            <button
              class="card-btn"
              :disabled="repayingStatement && repayingStatement.id === s.id"
              @click="startRepay(s)"
            >
              还款
            </button>
          </div>
        </div>
      </div>

      <!-- 还款表单：选付款活期账户 → 生成还款单 -->
      <div v-if="repayingStatement" class="repay-form">
        <div class="repay-form-head">
          <span class="repay-form-title">还款 · {{ repayingStatement.statement_month }}</span>
          <button class="btn-ghost btn-sm" @click="cancelRepay">取消</button>
        </div>
        <p class="repay-note">还款为全额（等于该账单剩余应还 {{ formatCentsToYuan(repayingStatement.remaining_due_cents) }} 元），恒需交易密码 + 动态验证码强验证。</p>

        <template v-if="!op">
          <label class="repay-field">
            <span class="repay-label">付款账户（活期）</span>
            <select v-if="depositAccounts.length > 1" v-model="fromAccountId" class="select" aria-label="付款账户">
              <option v-for="a in depositAccounts" :key="a.id" :value="a.id">{{ a.account_name }}（{{ formatCentsToYuan(a.balance_cents) }} 元）</option>
            </select>
            <span v-else-if="depositAccounts.length === 1" class="repay-value">{{ depositAccounts[0].account_name }}（{{ formatCentsToYuan(depositAccounts[0].balance_cents) }} 元）</span>
            <span v-else class="repay-value is-muted">无可用的活期付款账户</span>
          </label>
          <p v-if="opError" class="form-error">{{ opError }}</p>
          <div class="repay-actions">
            <button
              class="btn"
              :disabled="creating || !fromAccountId"
              @click="submitRepay"
            >
              {{ creating ? '生成中…' : '生成还款单' }}
            </button>
          </div>
        </template>

        <!-- 已生成还款单：交共享确认卡回读最新状态 -->
        <RepaymentConfirmCard v-if="op" :op="op" @confirmed="onRepaymentDone" @cancelled="onRepaymentDone" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.ccd {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.credit-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.cs-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cs-label {
  font-size: 12px;
  color: var(--muted);
}
.cs-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--navy);
  font-variant-numeric: tabular-nums;
}
.cs-value.is-avail {
  color: #15803d;
}
.frozen-note {
  margin: 0;
  padding: 8px 12px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  font-size: 13px;
  color: #9a3412;
}
.stmt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.stmt-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.stmt-empty {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.stmt-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stmt-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.stmt-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.stmt-month {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stmt-due {
  font-size: 12px;
  color: var(--muted);
}
.stmt-meta {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--muted);
}
.stmt-actions {
  flex-shrink: 0;
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
.repay-form {
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.repay-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.repay-form-title {
  font-weight: 600;
  color: var(--text);
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.repay-note {
  margin: 0;
  font-size: 13px;
  color: #854d0e;
}
.repay-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.repay-label {
  font-size: 13px;
  color: var(--muted);
}
.repay-value {
  font-size: 14px;
  color: var(--text);
}
.repay-value.is-muted {
  color: var(--muted);
}
.repay-actions {
  display: flex;
  gap: 10px;
}
.form-error {
  margin: 0;
  font-size: 13px;
  color: #b91c1c;
}
</style>
