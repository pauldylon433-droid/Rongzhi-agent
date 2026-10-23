<script setup>
// 共享信用卡还款确认卡：手动入口与 AI 聊天入口复用同一套确认 / 取消 / 强验证规则。
// 还款恒为红色强验证（交易密码 + TOTP），无普通黄色确认，不能跳过验证。
// 仅从后端结构化操作数据（op 视图，含 ref_no）渲染，绝不从 AI 文字提取金额或操作编号。
// 挂载时回读最新状态（以数据库为准）；强验证按钮直接调用现有接口，不经过模型。
// 强验证凭据（交易密码 + 动态验证码）仅发往专用验证接口，不进入 AI 请求 / 聊天历史 / 本地存储 / URL / 日志。
import { ref, computed, onMounted, watch } from 'vue'
import { fetchRepayment, cancelRepayment, verifyRepayment, fetchVerificationStatus } from '../api/index.js'
import { formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'
import { useRepaymentSignal } from '../composables/useRepaymentSignal.js'

const props = defineProps({
  op: { type: Object, required: true }, // 初始操作视图（至少含 ref_no）
})
const emit = defineEmits(['confirmed', 'cancelled', 'status'])

const op = ref(props.op)
const opError = ref('')
const cancelling = ref(false)

// —— 强验证状态 ——
const password = ref('')
const totpCode = ref('')
const verifying = ref(false)
const vStatus = ref(null) // { bound, locked, locked_until, remaining_attempts }
const vLoading = ref(false)

const { notifyChange, isChanged, version } = useRepaymentSignal()

const isNeedsVerification = computed(() => !!op.value && op.value.status === 'needs_verification')
const isCompleted = computed(() => !!op.value && op.value.status === 'completed')
const isTerminal = computed(() => !!op.value && ['completed', 'cancelled', 'expired', 'failed'].includes(op.value.status))

// 还款模式：statement=指定账单全额；all_posted=结清全部已入账欠款（含未出账已入账）
const isAllPosted = computed(() => !!op.value && op.value.scope === 'all_posted')
const modeText = computed(() => (isAllPosted.value ? '结清全部已入账欠款' : `指定账单 ${op.value ? op.value.statement_month : ''}`))
const allocations = computed(() => (op.value && Array.isArray(op.value.allocations) ? op.value.allocations : []))

const opStatusText = {
  needs_verification: '需要强验证还款',
  completed: '还款成功',
  cancelled: '已取消',
  expired: '已过期',
  failed: '已失效',
}
const opTitle = computed(() => (op.value ? opStatusText[op.value.status] || '还款单' : ''))

// 以数据库为准：挂载时回读最新状态，避免过期 / 取消 / 已完成卡片被当作新操作再次执行
async function load() {
  try {
    const fresh = await fetchRepayment(props.op.ref_no)
    if (fresh) op.value = fresh
  } catch {
    // 回读失败则保留初始视图
  }
  if (isNeedsVerification.value) await loadVerificationStatus()
}

// 读取验证器绑定 / 锁定状态（供红色表单渲染；不请求任何秘密）
async function loadVerificationStatus() {
  vLoading.value = true
  try {
    vStatus.value = await fetchVerificationStatus()
  } catch {
    vStatus.value = { bound: false }
  } finally {
    vLoading.value = false
  }
}

async function onCancel() {
  if (!op.value) return
  opError.value = ''
  cancelling.value = true
  try {
    op.value = await cancelRepayment(op.value.ref_no)
    notifyChange(op.value.ref_no)
    emit('cancelled')
  } catch (e) {
    opError.value = e && e.message ? e.message : '取消失败'
    try {
      const fresh = await fetchRepayment(op.value.ref_no)
      if (fresh) op.value = fresh
    } catch { /* 保留原状 */ }
  } finally {
    cancelling.value = false
    password.value = ''
    totpCode.value = ''
  }
}

async function onVerify() {
  if (!op.value || verifying.value) return
  opError.value = ''
  verifying.value = true
  try {
    op.value = await verifyRepayment(op.value.ref_no, { password: password.value, totp: totpCode.value })
    notifyChange(op.value.ref_no)
    emit('confirmed')
  } catch (e) {
    opError.value = e && e.message ? e.message : '强验证失败'
    // 失败可能已锁定 / 过期 / 取消 / 金额变化失效，回读最新状态
    try {
      const fresh = await fetchRepayment(op.value.ref_no)
      if (fresh) op.value = fresh
    } catch { /* 保留原状 */ }
    await loadVerificationStatus()
  } finally {
    verifying.value = false
    password.value = ''
    totpCode.value = ''
  }
}

onMounted(load)

// 改单 / 验证 / 取消等状态变更后，自动回读本卡对应还款单的最新状态（无需手动刷新）
watch(version, () => {
  if (props.op && props.op.ref_no && isChanged(props.op.ref_no)) {
    load()
  }
})

// 状态变化（挂载回读 / 验证 / 取消 / 改单回读）时，把最新状态上报父级。
watch(op, () => emit('status', op.value && op.value.status), { deep: true })
</script>

<template>
  <div v-if="op" class="rpc">
    <!-- 成功回执（可追溯：以服务端真实返回为准） -->
    <div v-if="isCompleted" class="receipt">
      <p class="receipt-title">还款成功</p>
      <p class="env-badge">模拟银行环境 · 数据仅供演示</p>
      <p class="receipt-ref">操作编号：{{ op.ref_no }}</p>
      <dl class="detail-list">
        <div class="detail-row"><dt>付款账户</dt><dd>{{ op.from_account_name }}</dd></div>
        <div class="detail-row"><dt>信用卡</dt><dd>{{ op.credit_account_name }}</dd></div>
        <div class="detail-row"><dt>还款模式</dt><dd>{{ modeText }}</dd></div>
        <div class="detail-row"><dt>还款金额</dt><dd>¥{{ formatCentsToYuan(op.amount_cents) }}</dd></div>
        <div v-if="op.confirmed_at" class="detail-row"><dt>确认时间</dt><dd>{{ formatShanghaiDateTime(op.confirmed_at) }}</dd></div>
      </dl>
    </div>

    <!-- 待强验证 / 其他状态卡 -->
    <div v-else class="confirm-card is-red">
      <div class="card-head">
        <span class="card-title">{{ opTitle }}</span>
        <span class="risk-badge is-red">高风险（红色）· 需强验证</span>
      </div>

      <p class="env-badge">模拟银行环境 · 数据仅供演示</p>

      <dl class="detail-list">
        <div class="detail-row"><dt>付款账户</dt><dd>{{ op.from_account_name }}</dd></div>
        <div class="detail-row"><dt>信用卡</dt><dd>{{ op.credit_account_name }}</dd></div>
        <div class="detail-row"><dt>还款模式</dt><dd>{{ modeText }}</dd></div>
        <div class="detail-row">
          <dt>还款构成</dt>
          <dd class="alloc-list">
            <span v-for="a in allocations" :key="a.statement_id" class="alloc-item">
              {{ a.statement_month || '账单' }} · {{ a.issued ? '已出账' : '未出账已入账' }} ·
              ¥{{ formatCentsToYuan(a.amount_cents) }}
            </span>
            <span v-if="!allocations.length">—</span>
          </dd>
        </div>
        <div class="detail-row"><dt>还款金额</dt><dd>¥{{ formatCentsToYuan(op.amount_cents) }}（合计，服务端计算）</dd></div>
        <div class="detail-row"><dt>操作编号</dt><dd class="mono">{{ op.ref_no }}</dd></div>
        <div class="detail-row"><dt>确认有效期</dt><dd>{{ formatShanghaiDateTime(op.expires_at) }}</dd></div>
      </dl>

      <!-- 红色待验证单：强验证表单（交易密码 + 动态验证码） -->
      <div v-if="isNeedsVerification" class="verify-section">
        <p class="red-note">信用卡还款为全额（等于账单剩余应还），需用交易密码与手机验证器动态码二次确认，验证通过后从付款账户扣款并冲抵账单。</p>

        <p v-if="vLoading" class="verify-hint">正在读取验证器状态…</p>
        <p v-else-if="!vStatus || vStatus.bound === false" class="verify-blocked">尚未绑定验证器，无法执行强验证还款。</p>
        <p v-else-if="vStatus.locked" class="verify-blocked">
          强验证已锁定，{{ formatShanghaiDateTime(vStatus.locked_until) }} 后可重试。
        </p>
        <template v-else>
          <label class="verify-field">
            <span class="verify-label">交易密码</span>
            <input
              v-model="password"
              type="password"
              class="verify-input"
              autocomplete="off"
              placeholder="请输入交易密码"
            />
          </label>
          <label class="verify-field">
            <span class="verify-label">动态验证码</span>
            <input
              v-model="totpCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              class="verify-input"
              autocomplete="off"
              placeholder="6 位验证码"
            />
          </label>
          <p v-if="vStatus.remaining_attempts < 5" class="verify-hint">剩余尝试次数：{{ vStatus.remaining_attempts }}</p>
          <p v-if="opError" class="form-error">{{ opError }}</p>
          <div class="card-actions">
            <button class="btn" :disabled="verifying || cancelling || !password || !totpCode" @click="onVerify">
              {{ verifying ? '验证中…' : '验证并确认还款' }}
            </button>
            <button class="btn-ghost" :disabled="verifying || cancelling" @click="onCancel">
              {{ cancelling ? '取消中…' : '取消本次还款' }}
            </button>
          </div>
        </template>
      </div>

      <!-- 其它终态（取消 / 过期 / 失败）：仅展示状态，不提供操作 -->
      <p v-if="isTerminal && !isNeedsVerification" class="impact-note">该还款单已{{ opStatusText[op.status] || '结束' }}，未扣款。</p>
      <p v-if="opError && !isNeedsVerification" class="form-error">{{ opError }}</p>
    </div>
  </div>
</template>

<style scoped>
.rpc {
  max-width: 480px;
}
.env-badge {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--muted);
}
.receipt {
  border: 1px solid #bbf7d0;
  background: #f0fdf4;
  border-radius: 10px;
  padding: 16px;
}
.receipt-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: #15803d;
}
.receipt-ref {
  margin: 0 0 12px;
  font-size: 13px;
  color: #166534;
  word-break: break-all;
}
.confirm-card {
  border: 1px solid #fecaca;
  border-radius: 10px;
  padding: 16px;
  background: #fef2f2;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.risk-badge {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 500;
}
.risk-badge.is-red {
  background: #fee2e2;
  color: #b91c1c;
  border: 1px solid #fecaca;
}
.detail-list {
  margin: 0;
}
.detail-row {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 14px;
}
.detail-row dt {
  flex-shrink: 0;
  width: 88px;
  color: var(--muted);
}
.detail-row dd {
  margin: 0;
  color: var(--text);
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.alloc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.alloc-item {
  font-variant-numeric: tabular-nums;
}
.red-note {
  margin: 10px 0 0;
  padding: 10px 12px;
  background: #fee2e2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  font-size: 13px;
  color: #b91c1c;
}
.impact-note {
  margin: 10px 0 0;
  padding: 10px 12px;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-radius: 8px;
  font-size: 13px;
  color: #854d0e;
}
.verify-section {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.verify-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.verify-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.verify-input {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  color: var(--text);
  background: #fff;
}
.verify-input:focus {
  outline: none;
  border-color: #2563eb;
}
.verify-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.verify-blocked {
  margin: 0;
  padding: 10px 12px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  font-size: 13px;
  color: #9a3412;
}
.form-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: #b91c1c;
}
.card-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
</style>
