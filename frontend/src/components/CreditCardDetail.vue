<script setup>
// 信用卡详情：额度 / 已入账未还 / 待入账占用 / 可用额度 + 信用卡还款账单 + 还款入口。
// 信用语义：不展示「存款余额」；未出账账单不显示为到期应还；冻结期间允许还款（还款入口照常开放）。
// 还款模式：指定账单全额 / 结清全部已入账欠款（含未出账已入账消费，待入账占用不计入），恒为红色强验证。
import { ref, computed, onMounted, watch } from 'vue'
import { fetchAccounts, fetchCreditAccount, createRepayment } from '../api/index.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatCentsToYuan, formatShanghaiDate } from '../utils/format.js'
import SectionState from './SectionState.vue'
import RepaymentConfirmCard from './RepaymentConfirmCard.vue'

const props = defineProps({
  card: { type: Object, required: true }, // 信用卡对象（含 credit_account_id 等）
  repaySignal: { type: Number, default: 0 }, // 由银行卡摘要「还款」按钮递增，打开还款面板
})

const detail = ref(null)
const loading = ref(false)
const error = ref('')
const { refresh } = useDataRefresh()

// —— 还款面板状态 ——
const depositAccounts = ref([])
const panelOpen = ref(false)
const repayMode = ref('statement') // statement=指定账单全额；all_posted=结清全部已入账欠款
const repayStatementId = ref(null)
const fromAccountId = ref(null)
const creating = ref(false)
const opError = ref('')
const op = ref(null) // 创建的还款单（交 RepaymentConfirmCard 回读最新状态）
let pendingOpen = false

const statementStatusText = { open: '已出账待还', overdue: '已逾期未还', paid: '已结清', unissued: '未出账' }
function statementStatusTone(s) {
  return { open: 'is-warn', overdue: 'is-danger', paid: 'is-ok', unissued: 'is-muted' }[s] || 'is-muted'
}

const statements = computed(() => (detail.value ? detail.value.statements || [] : []))
const summary = computed(() => detail.value || null)
// 当前未还 / 未出账优先展示；已结清进入历史区域
const issuedUnpaid = computed(() => statements.value.filter((s) => s.issued && s.remaining_due_cents > 0))
const unissuedWithCharges = computed(() => statements.value.filter((s) => !s.issued && s.new_charges_cents > 0))
const paidStatements = computed(() => statements.value.filter((s) => s.issued && s.remaining_due_cents <= 0).reverse())
const repayableTotal = computed(() => (summary.value ? summary.value.repayable_total_cents || 0 : 0))
const selectedStatement = computed(() => issuedUnpaid.value.find((s) => s.id === repayStatementId.value) || null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await fetchCreditAccount(props.card.credit_account_id)
    if (pendingOpen) {
      pendingOpen = false
      openRepayAll()
    }
  } catch (e) {
    error.value = e && e.message ? e.message : '加载信用卡详情失败'
  } finally {
    loading.value = false
  }
}

// 拉取活期付款账户（仅活期可作还款来源）
async function loadAccounts() {
  opError.value = ''
  fromAccountId.value = null
  try {
    const accts = await fetchAccounts()
    depositAccounts.value = (accts || []).filter((a) => a.account_type === 'deposit' && a.status === 'active')
    if (depositAccounts.value.length === 1) fromAccountId.value = depositAccounts.value[0].id
  } catch (e) {
    opError.value = e && e.message ? e.message : '加载付款账户失败'
  }
}

// 打开面板：指定账单模式
async function startRepay(stmt) {
  panelOpen.value = true
  repayMode.value = 'statement'
  repayStatementId.value = (stmt || issuedUnpaid.value[0] || {}).id || null
  op.value = null
  await loadAccounts()
}

// 打开面板：结清全部已入账欠款（不直接建单）
async function openRepayAll() {
  panelOpen.value = true
  repayMode.value = 'all_posted'
  repayStatementId.value = null
  op.value = null
  await loadAccounts()
}

function switchMode(mode) {
  repayMode.value = mode
  if (mode === 'statement' && !repayStatementId.value) repayStatementId.value = (issuedUnpaid.value[0] || {}).id || null
}

function cancelRepay() {
  panelOpen.value = false
  repayStatementId.value = null
  fromAccountId.value = null
  opError.value = ''
  op.value = null
}

const canSubmit = computed(() => {
  if (!fromAccountId.value || creating.value) return false
  if (repayMode.value === 'statement') return !!selectedStatement.value
  return repayableTotal.value > 0
})

async function submitRepay() {
  opError.value = ''
  if (!canSubmit.value) {
    if (repayMode.value === 'all_posted' && repayableTotal.value <= 0) opError.value = '暂无可还款项'
    return
  }
  creating.value = true
  try {
    op.value =
      repayMode.value === 'all_posted'
        ? await createRepayment({ from_account_id: fromAccountId.value, scope: 'all_posted', credit_account_id: summary.value.id })
        : await createRepayment({ statement_id: selectedStatement.value.id, from_account_id: fromAccountId.value, scope: 'statement' })
  } catch (e) {
    opError.value = e && e.message ? e.message : '生成还款单失败'
  } finally {
    creating.value = false
  }
}

// 还款完成 / 取消后：回读信用卡详情，并通知全局刷新（流水 / 余额 / 月度统计 / 账单）
function onRepaymentDone() {
  op.value = null
  panelOpen.value = false
  repayStatementId.value = null
  fromAccountId.value = null
  refresh()
  load()
}

onMounted(() => {
  load()
  if (props.repaySignal > 0) pendingOpen = true
})

watch(() => props.repaySignal, (v, old) => {
  if (!v || v === old) return
  if (summary.value) openRepayAll()
  else pendingOpen = true
})

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

      <!-- 信用卡还款账单（区别于月度消费统计） -->
      <div class="stmt-head">
        <span class="stmt-title">信用卡还款账单</span>
      </div>
      <p class="stmt-explainer">
        月度消费统计按消费发生时间统计，<strong>不等于本期应还</strong>；未出账消费可能已经入账（入账时间与交易时间不同）。
      </p>

      <!-- 待还账单（已出账） -->
      <div v-if="issuedUnpaid.length" class="stmt-group">
        <h4 class="stmt-group-title">待还账单</h4>
        <div v-for="s in issuedUnpaid" :key="s.id" class="stmt-row">
          <div class="stmt-main">
            <span class="stmt-month">{{ s.statement_month }}</span>
            <span class="status-badge" :class="statementStatusTone(s.status)">{{ statementStatusText[s.status] || s.status }}</span>
          </div>
          <dl class="stmt-fields">
            <div><dt>账期</dt><dd>{{ s.statement_month }}</dd></div>
            <div><dt>出账日</dt><dd>{{ formatShanghaiDate(s.issued_on) }}</dd></div>
            <div><dt>最后还款日</dt><dd>{{ formatShanghaiDate(s.due_on) }}</dd></div>
            <div><dt>账单金额</dt><dd>{{ formatCentsToYuan(s.new_charges_cents) }} 元</dd></div>
            <div><dt>已还金额</dt><dd>{{ formatCentsToYuan(s.paid_cents) }} 元</dd></div>
            <div><dt>剩余应还</dt><dd class="is-due">{{ formatCentsToYuan(s.remaining_due_cents) }} 元</dd></div>
          </dl>
          <div class="stmt-actions">
            <button class="card-btn" @click="startRepay(s)">还款</button>
          </div>
        </div>
      </div>

      <!-- 未出账（不是正式账单，也不是到期应还） -->
      <div v-if="unissuedWithCharges.length" class="stmt-group">
        <h4 class="stmt-group-title">未出账（不是正式账单 / 到期应还）</h4>
        <div v-for="s in unissuedWithCharges" :key="s.id" class="stmt-row is-unissued">
          <div class="stmt-main">
            <span class="stmt-month">{{ s.statement_month }}</span>
            <span class="status-badge is-muted">未出账</span>
          </div>
          <dl class="stmt-fields">
            <div><dt>账期</dt><dd>{{ s.statement_month }}</dd></div>
            <div><dt>预计出账日</dt><dd>{{ formatShanghaiDate(s.issued_on) }}</dd></div>
            <div><dt>预计最后还款日</dt><dd>{{ formatShanghaiDate(s.due_on) }}</dd></div>
            <div><dt>消费金额</dt><dd>{{ formatCentsToYuan(s.new_charges_cents) }} 元</dd></div>
            <div><dt>已提前还款</dt><dd>{{ formatCentsToYuan(s.paid_cents) }} 元</dd></div>
            <div><dt>未出账剩余</dt><dd>{{ formatCentsToYuan(s.remaining_due_cents) }} 元</dd></div>
          </dl>
          <p class="stmt-note">未出账消费可能已经入账；可点「还款」选择「结清全部已入账欠款」提前偿还。</p>
        </div>
      </div>

      <p v-if="!issuedUnpaid.length && !unissuedWithCharges.length" class="stmt-empty">暂无还款账单</p>

      <!-- 历史已结清账单（可展开） -->
      <details v-if="paidStatements.length" class="stmt-history">
        <summary>历史已结清账单（{{ paidStatements.length }} 期）</summary>
        <div v-for="s in paidStatements" :key="s.id" class="stmt-row is-paid">
          <div class="stmt-main">
            <span class="stmt-month">{{ s.statement_month }}</span>
            <span class="status-badge is-ok">已结清</span>
          </div>
          <dl class="stmt-fields">
            <div><dt>账期</dt><dd>{{ s.statement_month }}</dd></div>
            <div><dt>出账日</dt><dd>{{ formatShanghaiDate(s.issued_on) }}</dd></div>
            <div><dt>最后还款日</dt><dd>{{ formatShanghaiDate(s.due_on) }}</dd></div>
            <div><dt>账单金额</dt><dd>{{ formatCentsToYuan(s.new_charges_cents) }} 元</dd></div>
            <div><dt>已还金额</dt><dd>{{ formatCentsToYuan(s.paid_cents) }} 元</dd></div>
            <div><dt>剩余应还</dt><dd>{{ formatCentsToYuan(s.remaining_due_cents) }} 元</dd></div>
          </dl>
        </div>
      </details>

      <!-- 还款面板：选择模式与付款账户 → 生成还款单（不直接建单 / 扣款） -->
      <div v-if="panelOpen" class="repay-form">
        <div class="repay-form-head">
          <span class="repay-form-title">信用卡还款 · {{ card.masked_card_number }}</span>
          <button class="btn-ghost btn-sm" @click="cancelRepay">关闭</button>
        </div>

        <template v-if="!op">
          <label class="repay-field">
            <span class="repay-label">付款账户（活期）</span>
            <select v-if="depositAccounts.length > 1" v-model="fromAccountId" class="select" aria-label="付款账户">
              <option v-for="a in depositAccounts" :key="a.id" :value="a.id">{{ a.account_name }}（{{ formatCentsToYuan(a.balance_cents) }} 元）</option>
            </select>
            <span v-else-if="depositAccounts.length === 1" class="repay-value">{{ depositAccounts[0].account_name }}（{{ formatCentsToYuan(depositAccounts[0].balance_cents) }} 元）</span>
            <span v-else class="repay-value is-muted">无可用的活期付款账户</span>
          </label>

          <div class="repay-field">
            <span class="repay-label">还款模式</span>
            <div class="mode-switch">
              <button class="mode-btn" :class="{ 'is-active': repayMode === 'statement' }" @click="switchMode('statement')">指定账单全额</button>
              <button class="mode-btn" :class="{ 'is-active': repayMode === 'all_posted' }" @click="switchMode('all_posted')">结清全部已入账欠款</button>
            </div>
          </div>

          <template v-if="repayMode === 'statement'">
            <label v-if="issuedUnpaid.length" class="repay-field">
              <span class="repay-label">账单</span>
              <select v-model="repayStatementId" class="select" aria-label="账单">
                <option v-for="s in issuedUnpaid" :key="s.id" :value="s.id">
                  {{ s.statement_month }} · 剩余 {{ formatCentsToYuan(s.remaining_due_cents) }} 元
                </option>
              </select>
            </label>
            <p v-else class="repay-note">暂无可还款项（无已出账未还账单）。</p>
          </template>

          <template v-else>
            <div class="repay-breakdown">
              <div><span>已出账未还</span><b>{{ formatCentsToYuan(summary.issued_unpaid_cents) }} 元</b></div>
              <div><span>未出账已入账</span><b>{{ formatCentsToYuan(summary.unissued_posted_cents) }} 元</b></div>
              <div class="is-total"><span>合计（服务端计算）</span><b>{{ formatCentsToYuan(summary.repayable_total_cents) }} 元</b></div>
            </div>
            <p class="repay-note">
              待入账占用 {{ formatCentsToYuan(summary.pending_occupied_cents) }} 元不计入可还金额；未出账消费可提前偿还，
              出账后保留已还金额，不会重复计债。
            </p>
          </template>

          <p v-if="repayMode === 'all_posted' && repayableTotal <= 0" class="repay-empty">暂无可还款项</p>
          <p v-if="opError" class="form-error">{{ opError }}</p>
          <div class="repay-actions">
            <button class="btn" :disabled="!canSubmit" @click="submitRepay">
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

/* —— 还款账单 / 还款面板 —— */
.stmt-explainer {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.stmt-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stmt-group-title {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.stmt-row {
  align-items: flex-start;
}
.stmt-fields {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px 14px;
  flex: 1 1 100%;
}
.stmt-fields > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stmt-fields dt {
  font-size: 12px;
  color: var(--muted);
}
.stmt-fields dd {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stmt-fields dd.is-due {
  font-weight: 700;
  color: #b91c1c;
}
.stmt-row.is-unissued {
  background: #f8fafc;
}
.stmt-row.is-paid {
  background: #f0fdf4;
}
.stmt-note {
  flex: 1 1 100%;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.stmt-history {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.stmt-history summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--muted);
}
.stmt-history .stmt-row {
  margin-top: 8px;
}
.mode-switch {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.mode-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text);
}
.mode-btn.is-active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 600;
}
.repay-breakdown {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.repay-breakdown > div {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}
.repay-breakdown .is-total {
  border-top: 1px solid var(--border);
  padding-top: 4px;
  font-weight: 600;
}
.repay-empty {
  margin: 0;
  font-size: 13px;
  color: #b45309;
}
</style>
