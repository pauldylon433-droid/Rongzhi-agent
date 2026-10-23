<script setup>
// 可复用聊天面板：消息列表 + 底部输入框。会话状态来自 useChatSession（模块级单例），
// 总览右侧助手与「AI 助手」工作区共用同一份会话，切换视图不丢失消息与草稿、不重复请求。
import { ref, reactive, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useChatSession } from '../composables/useChatSession.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { formatMoney, formatCentsToYuan, formatShanghaiDateTime, formatShanghaiDate } from '../utils/format.js'
import TransferConfirmCard from './TransferConfirmCard.vue'
import CardOperationConfirmCard from './CardOperationConfirmCard.vue'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'
import RepaymentConfirmCard from './RepaymentConfirmCard.vue'
import MarkdownContent from './MarkdownContent.vue'
import BotAvatar from './BotAvatar.vue'
import UserAvatar from './UserAvatar.vue'

defineProps({
  compact: { type: Boolean, default: false }, // 窄侧栏模式下隐藏示例、收紧间距
})

const examples = [
  '我的账户余额是多少？',
  '这个月支出最多的是哪一类？',
  '我有哪些银行卡？',
]

const { refresh } = useDataRefresh()

const {
  messages, input, sending, sendingSessionId, sessionId, composing, loading, loadError,
  send, newChat, loadCurrent, ensureLoaded, registerHooks,
} = useChatSession()

const opStatusText = {
  pending: '待确认',
  needs_verification: '需要强验证',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  failed: '失败',
}
function statusText(s) {
  return opStatusText[s] || s
}
const cardStatusText = { active: '正常', frozen: '冻结', cancelled: '已注销' }
function cardStatus(s) {
  return cardStatusText[s] || s
}
const subStatusText = { active: '生效', paused: '暂停', cancelled: '已取消' }
function subStatus(s) {
  return subStatusText[s] || s
}
const subCycleText = { monthly: '按月', yearly: '按年' }
function subCycle(c) {
  return subCycleText[c] || c || '—'
}
const subActionText = { pause: '暂停', resume: '恢复', cancel: '取消' }
function subAction(a) {
  return subActionText[a] || a
}
const stmtStatusText = { open: '已出账待还', overdue: '已逾期未还', paid: '已结清', unissued: '未出账' }
function stmtStatus(s) {
  return stmtStatusText[s] || s || '—'
}

function onTransferConfirmed() {
  refresh()
}
function onCardOpConfirmed() {
  refresh()
}
function onSubscriptionOpConfirmed() {
  refresh()
}
function onRepaymentConfirmed() {
  refresh()
}

// get_credit_accounts 返回值：指定卡时为单个对象，未指定时为数组，统一归一化为数组渲染。
function creditList(data) {
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

const listEl = ref(null)
const contentEl = ref(null)
const inputEl = ref(null)

// —— 滚动定位：吸附底部 / 上翻阅读 / 回到最新 ——
// stickToBottom：是否跟随新消息与异步结果卡高度变化吸附到底部（用户主动上翻时置 false）。
// showBackToLatest：上翻离开底部后显示「回到最新」入口；点击回到底部并恢复吸附。
const stickToBottom = ref(true)
const showBackToLatest = ref(false)
let resizeObserver = null

// 带正负号金额（整数分 → +¥1,500.00）
function moneyWithSign(cents) {
  const sign = cents >= 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(cents), 'CNY')}`
}

function okRecords(m) {
  if (!m.toolRecords) return []
  return m.toolRecords
    .map((r, i) => ({ ...r, __i: i }))
    .filter((r) => r.status === 'ok' && r.data != null)
}

// —— 操作单状态跟踪（Part 三）：确认卡上报最新状态，据此隐藏过期的「创建时说明」提示、标注旧 AI 文本 ——
const opStatusMap = reactive({})
function onOpStatus(refNo, status) {
  if (refNo && status) opStatusMap[refNo] = status
}
function isTerminalStatus(s) {
  return ['completed', 'cancelled', 'expired', 'failed'].includes(s)
}
function opStatusOf(rec) {
  const refNo = rec && rec.data && rec.data.ref_no
  return (refNo && opStatusMap[refNo]) || (rec && rec.data && rec.data.status) || ''
}
function messageHasTerminalOp(m) {
  return (m.toolRecords || []).some((r) =>
    (r.name === 'prepare_transfer' || r.name === 'prepare_card_operation' || r.name === 'prepare_subscription_operation' || r.name === 'prepare_repayment')
    && isTerminalStatus(opStatusOf(r)),
  )
}

function scrollToBottomNow() {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// 统一滚动入口：useChatSession 在发送 / 加载 / 恢复 / 切换会话后调用。
// force=true：无条件定位到最后一条（初始加载、切换会话、面板重新显示）；
// 默认（follow）：仅在用户仍吸附底部时跟随，用户上翻阅读历史则不拉回。
async function scrollToBottom(options = {}) {
  const { force = false } = options || {}
  if (force) {
    stickToBottom.value = true
    showBackToLatest.value = false
  }
  await nextTick()
  if (stickToBottom.value) scrollToBottomNow()
}

// 监听用户滚动：接近底部则恢复吸附并隐藏入口；上翻则停止吸附并显示「回到最新」。
function onScroll() {
  const el = listEl.value
  if (!el) return
  const threshold = 48
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  if (atBottom) {
    stickToBottom.value = true
    showBackToLatest.value = false
  } else {
    stickToBottom.value = false
    showBackToLatest.value = true
  }
}

function jumpToLatest() {
  stickToBottom.value = true
  showBackToLatest.value = false
  scrollToBottomNow()
}

function focusInput() {
  if (inputEl.value) inputEl.value.focus()
}

function onCompositionStart() {
  composing.value = true
}
function onCompositionEnd() {
  composing.value = false
}

function onKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (composing.value || e.isComposing || e.keyCode === 229) {
    e.preventDefault()
    return
  }
  e.preventDefault()
  send(input.value)
}

onMounted(() => {
  registerHooks({ scrollToBottom, focusInput })

  // 观察内容高度变化（异步结果卡 / 确认卡回读后高度变化），吸附状态时保持底部。
  // 不用固定延时：ResizeObserver 在每次内容尺寸变化后回调，直到稳定。
  if (contentEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (stickToBottom.value) scrollToBottomNow()
    })
    resizeObserver.observe(contentEl.value)
  }

  // 会话状态为模块级单例：从总览展开工作区 / 页面重新显示时面板会重挂载，
  // 消息已加载则立即定位到最后一条；首次加载由 loadCurrent 完成后 force 定位。
  if (!loading.value && messages.value.length) {
    scrollToBottom({ force: true })
  }
  ensureLoaded()
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})
</script>

<template>
  <div class="chat-panel" :class="{ 'is-compact': compact }">
    <div ref="listEl" class="chat-list" @scroll="onScroll">
      <div ref="contentEl" class="chat-list-content">
      <p v-if="loading" class="chat-empty">正在加载聊天记录…</p>

      <div v-if="!loading && loadError" class="chat-load-error">
        <p class="chat-error">{{ loadError }}</p>
        <button class="btn-ghost" @click="loadCurrent">重试</button>
      </div>

      <p v-if="!loading && !loadError && messages.length === 0" class="chat-empty">
        我是融智 AI 助手，可以查询账户余额、账单统计、银行卡、订阅代扣、信用卡额度与账单，也能帮你生成待确认转账单、银行卡冻结 / 解冻操作单、订阅操作单或信用卡还款单。例如「我有哪些订阅？」。
      </p>

      <div v-for="m in messages" :key="m.id" class="chat-row" :class="m.role">
        <BotAvatar v-if="m.role === 'assistant'" class="chat-avatar" :size="34" />
        <div class="chat-bubble">
          <p v-if="m.role === 'user'" class="chat-text">{{ m.text }}</p>

          <template v-else>
            <p v-if="m.error" class="chat-error">{{ m.error }}</p>
            <template v-else>
              <MarkdownContent v-if="m.text" :text="m.text" />
              <p v-if="m.incomplete" class="chat-incomplete">（本轮回答未完成，请稍后重试）</p>
              <p v-if="messageHasTerminalOp(m)" class="chat-stale-note">以上回复为操作创建时说明，当前状态见下方回执。</p>

              <div v-for="rec in okRecords(m)" :key="rec.__i" class="result-cards">
                <template v-if="rec.name === 'get_accounts'">
                  <template v-if="rec.data && rec.data.length">
                    <div v-for="acc in rec.data" :key="acc.id" class="result-card">
                      <span class="rc-label">账户 · {{ acc.account_name }}（{{ acc.currency }}）</span>
                      <span class="rc-value">{{ formatMoney(acc.balance_cents, acc.currency) }}</span>
                    </div>
                  </template>
                  <div v-else class="result-card"><span class="rc-none">暂无账户</span></div>
                </template>

                <template v-else-if="rec.name === 'get_monthly_analytics'">
                  <div v-if="rec.data" class="result-card monthly">
                    <span class="rc-label">{{ rec.data.month }} 账单统计</span>
                    <div class="rc-grid">
                      <div class="rc-stat">
                        <span>收入</span>
                        <b class="is-income">{{ moneyWithSign(rec.data.income_cents) }}</b>
                      </div>
                      <div class="rc-stat">
                        <span>支出</span>
                        <b class="is-expense">{{ moneyWithSign(-rec.data.expense_cents) }}</b>
                      </div>
                      <div class="rc-stat">
                        <span>净收支</span>
                        <b :class="rec.data.net_cents >= 0 ? 'is-income' : 'is-expense'">{{ moneyWithSign(rec.data.net_cents) }}</b>
                      </div>
                      <div class="rc-stat">
                        <span>已入账</span>
                        <b>{{ rec.data.posted_count }} 笔</b>
                      </div>
                    </div>
                    <p v-if="rec.data.pending && rec.data.pending.count" class="rc-note">
                      另有 {{ rec.data.pending.count }} 笔待入账，共 {{ formatMoney(rec.data.pending.amount_cents, 'CNY') }}
                    </p>
                    <ul v-if="rec.data.expense_by_category && rec.data.expense_by_category.length" class="rc-cats">
                      <li v-for="c in rec.data.expense_by_category" :key="c.category">
                        <span>{{ c.category }}</span>
                        <span>{{ formatMoney(c.amount_cents, 'CNY') }}（{{ c.count }} 笔）</span>
                      </li>
                    </ul>
                    <p v-if="rec.data.as_of" class="rc-asof">快照于 {{ formatShanghaiDateTime(rec.data.as_of) }}</p>
                  </div>
                  <div v-else class="result-card"><span class="rc-none">暂无账单统计</span></div>
                </template>

                <template v-else-if="rec.name === 'search_transfer_recipients'">
                  <div class="result-card recipients">
                    <span class="rc-label">收款人匹配结果</span>
                    <div v-if="rec.data && rec.data.length" class="rc-recipients">
                      <div v-for="r in rec.data" :key="r.id" class="rc-recipient">
                        <span>{{ r.name }}</span>
                        <span class="rc-masked">{{ r.masked_account }}</span>
                      </div>
                    </div>
                    <span v-else class="rc-none">未找到匹配的收款人</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'list_transfer_recipients'">
                  <div class="result-card recipients">
                    <span class="rc-label">我的收款人</span>
                    <div v-if="rec.data && rec.data.length" class="rc-recipients">
                      <div v-for="r in rec.data" :key="r.id" class="rc-recipient">
                        <span>{{ r.name }}</span>
                        <span class="rc-masked">{{ r.masked_account }}</span>
                      </div>
                    </div>
                    <span v-else class="rc-none">暂无收款人</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'prepare_transfer'">
                  <p v-if="rec.data && rec.data.notice && !isTerminalStatus(opStatusOf(rec))" class="transfer-notice">{{ rec.data.notice }}</p>
                  <TransferConfirmCard :op="rec.data" @confirmed="onTransferConfirmed" @status="(s) => onOpStatus(rec.data.ref_no, s)" />
                </template>

                <template v-else-if="rec.name === 'get_transfer_status'">
                  <div class="result-card status">
                    <span class="rc-label">转账单 · {{ rec.data.ref_no }}</span>
                    <span class="rc-value">{{ statusText(rec.data.status) }}</span>
                    <span v-if="rec.data.amount_cents" class="rc-note">¥{{ formatCentsToYuan(rec.data.amount_cents) }}</span>
                    <span v-if="rec.queryTime" class="rc-asof">查询于 {{ formatShanghaiDateTime(rec.queryTime) }}</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'get_cards'">
                  <div class="result-card cards">
                    <span class="rc-label">我的银行卡</span>
                    <div v-if="rec.data && rec.data.length" class="rc-cards">
                      <div v-for="c in rec.data" :key="c.id" class="rc-card-row">
                        <span>{{ c.masked_card_number }}（{{ c.card_type }}）</span>
                        <span class="rc-card-status">{{ cardStatus(c.status) }}</span>
                      </div>
                    </div>
                    <span v-else class="rc-none">暂无银行卡</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'prepare_card_operation'">
                  <p v-if="rec.data && rec.data.notice && !isTerminalStatus(opStatusOf(rec))" class="transfer-notice">{{ rec.data.notice }}</p>
                  <CardOperationConfirmCard :op="rec.data" @confirmed="onCardOpConfirmed" @status="(s) => onOpStatus(rec.data.ref_no, s)" />
                </template>

                <template v-else-if="rec.name === 'get_card_operation_status'">
                  <div class="result-card status">
                    <span class="rc-label">银行卡操作单 · {{ rec.data.ref_no }}</span>
                    <span class="rc-value">{{ statusText(rec.data.status) }}</span>
                    <span v-if="rec.data.masked_card_number" class="rc-note">{{ rec.data.masked_card_number }}（{{ rec.data.action === 'freeze' ? '冻结' : '解冻' }}）</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'get_subscriptions'">
                  <div class="result-card subs">
                    <span class="rc-label">我的订阅与代扣</span>
                    <div v-if="rec.data && rec.data.length" class="rc-subs">
                      <div v-for="s in rec.data" :key="s.id" class="rc-sub-row">
                        <span>{{ s.merchant }}</span>
                        <span class="rc-sub-meta">{{ formatCentsToYuan(s.amount_cents) }} 元 / {{ subCycle(s.billing_cycle) }}</span>
                        <span class="rc-sub-status">{{ subStatus(s.status) }}</span>
                      </div>
                    </div>
                    <span v-else class="rc-none">暂无订阅</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'prepare_subscription_operation'">
                  <p v-if="rec.data && rec.data.notice && !isTerminalStatus(opStatusOf(rec))" class="transfer-notice">{{ rec.data.notice }}</p>
                  <SubscriptionOperationConfirmCard :op="rec.data" @confirmed="onSubscriptionOpConfirmed" @status="(s) => onOpStatus(rec.data.ref_no, s)" />
                </template>

                <template v-else-if="rec.name === 'get_subscription_operation_status'">
                  <div class="result-card status">
                    <span class="rc-label">订阅操作单 · {{ rec.data.ref_no }}</span>
                    <span class="rc-value">{{ statusText(rec.data.status) }}</span>
                    <span v-if="rec.data.merchant" class="rc-note">{{ rec.data.merchant }}（{{ subAction(rec.data.action) }}）</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'start_subscription_review'">
                  <div class="result-card task-started">
                    <span class="rc-label">已启动「订阅审查」跨场景任务</span>
                    <span class="rc-value">{{ rec.data.month }}</span>
                    <span class="rc-note">请在「跨场景任务」卡片中选择要暂停的生效订阅。</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'get_credit_accounts'">
                  <div class="result-card credit">
                    <span class="rc-label">信用卡（信用账户）</span>
                    <div v-if="creditList(rec.data).length" class="rc-credits">
                      <div v-for="ca in creditList(rec.data)" :key="ca.id" class="rc-credit">
                        <div class="rc-credit-head">
                          <span class="rc-credit-name">{{ ca.account_name }}</span>
                          <span v-if="ca.card" class="rc-card-status">{{ cardStatus(ca.card.status) }} · {{ ca.card.masked_card_number }}</span>
                        </div>
                        <div class="rc-grid">
                          <div class="rc-stat"><span>总额度</span><b>{{ formatCentsToYuan(ca.credit_limit_cents) }} 元</b></div>
                          <div class="rc-stat"><span>已入账未还</span><b class="is-expense">{{ formatCentsToYuan(ca.posted_outstanding_cents) }} 元</b></div>
                          <div class="rc-stat"><span>待入账占用</span><b>{{ formatCentsToYuan(ca.pending_occupied_cents) }} 元</b></div>
                          <div class="rc-stat"><span>可用额度</span><b class="is-income">{{ formatCentsToYuan(ca.available_credit_cents) }} 元</b></div>
                        </div>
                        <div v-if="ca.statements && ca.statements.length" class="rc-stmts">
                          <div v-for="s in ca.statements" :key="s.id" class="rc-stmt">
                            <span>{{ s.statement_month }} · {{ stmtStatus(s.status) }}</span>
                            <span v-if="s.issued && s.remaining_due_cents > 0" class="rc-stmt-due">剩余应还 {{ formatCentsToYuan(s.remaining_due_cents) }} 元 · 到期 {{ formatShanghaiDate(s.due_on) }}</span>
                            <span v-else-if="s.issued" class="rc-stmt-due">已结清</span>
                            <span v-else class="rc-stmt-due">未出账（不计入应还）</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <span v-else class="rc-none">暂无信用卡</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'get_statement'">
                  <div v-if="rec.data" class="result-card statement">
                    <span class="rc-label">账单 · {{ rec.data.statement_month }}（{{ stmtStatus(rec.data.status) }}）</span>
                    <div class="rc-grid">
                      <div class="rc-stat"><span>本期新增</span><b>{{ formatCentsToYuan(rec.data.new_charges_cents) }} 元</b></div>
                      <div class="rc-stat"><span>已还</span><b class="is-income">{{ formatCentsToYuan(rec.data.paid_cents) }} 元</b></div>
                      <div class="rc-stat"><span>剩余应还</span><b class="is-expense">{{ formatCentsToYuan(rec.data.remaining_due_cents) }} 元</b></div>
                    </div>
                    <span v-if="rec.data.due_on" class="rc-note">到期日 {{ formatShanghaiDate(rec.data.due_on) }}</span>
                    <span v-if="!rec.data.issued" class="rc-note">未出账：消费不计入应还，待出账后生成账单。</span>
                  </div>
                  <div v-else class="result-card"><span class="rc-none">暂无账单详情</span></div>
                </template>

                <template v-else-if="rec.name === 'prepare_repayment'">
                  <p v-if="rec.data && rec.data.notice && !isTerminalStatus(opStatusOf(rec))" class="transfer-notice">{{ rec.data.notice }}</p>
                  <RepaymentConfirmCard :op="rec.data" @confirmed="onRepaymentConfirmed" @status="(s) => onOpStatus(rec.data.ref_no, s)" />
                </template>

                <template v-else-if="rec.name === 'get_repayment_status'">
                  <div class="result-card status">
                    <span class="rc-label">还款单 · {{ rec.data.ref_no }}</span>
                    <span class="rc-value">{{ statusText(rec.data.status) }}</span>
                    <span v-if="rec.data.amount_cents" class="rc-note">¥{{ formatCentsToYuan(rec.data.amount_cents) }} · 账期 {{ rec.data.statement_month }}</span>
                    <span v-if="rec.queryTime" class="rc-asof">查询于 {{ formatShanghaiDateTime(rec.queryTime) }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </div>
        <UserAvatar v-if="m.role === 'user'" class="chat-avatar" :size="34" />
      </div>

      <div v-if="sending && sendingSessionId === sessionId" class="chat-row assistant">
        <BotAvatar class="chat-avatar" :size="34" />
        <div class="chat-bubble"><p class="chat-text chat-waiting">正在思考…</p></div>
      </div>

      <p v-if="sending && sendingSessionId !== sessionId" class="chat-other-busy">
        另一会话正在生成回复，请稍候…
      </p>
      </div>

      <button v-if="showBackToLatest" class="back-to-latest" type="button" @click="jumpToLatest">
        回到最新 ↓
      </button>
    </div>

    <div class="chat-input-row">
      <textarea
        ref="inputEl"
        v-model="input"
        class="chat-input"
        rows="1"
        placeholder="输入问题（Enter 发送，Shift+Enter 换行）"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      ></textarea>
      <button class="btn" :disabled="sending || !input.trim()" @click="send(input)">发送</button>
    </div>

    <div v-if="!compact" class="chat-examples">
      <span class="chat-examples-label">示例：</span>
      <button v-for="q in examples" :key="q" class="chip" :disabled="sending" @click="send(q)">{{ q }}</button>
    </div>

    <p v-if="!compact" class="chat-disclaimer">AI 助手可查询账户 / 账单 / 银行卡 / 订阅代扣 / 信用卡额度与账单，并可生成待确认转账单、银行卡冻结 / 解冻操作单、订阅操作单与信用卡还款单，但不执行扣款或直接改变任何状态；冻结 / 暂停 / 取消需你在确认卡上确认，解冻 / 恢复 / 信用卡还款需交易密码 + 动态验证码强验证。数据均为模拟，仅供演示。</p>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px;
  min-height: 0;
}
.chat-list-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.back-to-latest {
  position: sticky;
  bottom: 8px;
  display: block;
  width: fit-content;
  margin: 4px auto 0;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: #fff;
  color: var(--blue);
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
}
.back-to-latest:hover {
  background: var(--blue-light);
  border-color: #bfdbfe;
}
.chat-empty {
  color: var(--muted);
  font-size: 15px;
  margin: 8px 0;
}
.chat-load-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fef2f2;
}
.chat-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.chat-row.user {
  justify-content: flex-end;
}
.chat-row.assistant {
  justify-content: flex-start;
}
.chat-avatar {
  flex-shrink: 0;
}
.chat-bubble {
  max-width: calc(100% - 48px);
  min-width: 0;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 16px;
  line-height: 1.6;
}
.chat-row.user .chat-bubble {
  background: var(--blue);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.chat-row.assistant .chat-bubble {
  background: #f1f5f9;
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}
.chat-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-waiting {
  color: var(--muted);
}
.chat-other-busy {
  margin: 0;
  padding: 8px 12px;
  background: #f8fafc;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted);
  text-align: center;
}
.chat-error {
  margin: 0;
  color: #b91c1c;
}
.chat-incomplete {
  margin: 6px 0 0;
  color: #b45309;
  font-size: 13px;
}
.chat-stale-note {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.result-cards {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.result-card.monthly,
.result-card.recipients,
.result-card.status,
.result-card.subs,
.result-card.task-started,
.result-card.credit,
.result-card.statement {
  flex-direction: column;
  align-items: stretch;
}
.rc-recipients {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.rc-recipient {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.rc-masked {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.rc-none {
  font-size: 13px;
  color: var(--muted);
  margin-top: 6px;
}
.rc-cards {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.rc-card-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.rc-card-status {
  color: var(--muted);
}
.rc-subs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.rc-sub-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.rc-sub-meta {
  color: var(--muted);
}
.rc-sub-status {
  color: var(--muted);
  flex-shrink: 0;
}
.transfer-notice {
  margin: 0 0 8px;
  padding: 8px 10px;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-radius: 8px;
  font-size: 13px;
  color: #854d0e;
}
.rc-label {
  font-size: 14px;
  color: var(--muted);
}
.rc-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--navy);
  font-variant-numeric: tabular-nums;
}
.rc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  margin-top: 6px;
}
.rc-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rc-stat span {
  font-size: 12px;
  color: var(--muted);
}
.rc-stat b {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.rc-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #854d0e;
}
.rc-cats {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rc-cats li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.rc-cats li span:first-child {
  color: var(--muted);
}
.is-income {
  color: #15803d;
}
.is-expense {
  color: #b91c1c;
}

.rc-asof {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.rc-credits {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.rc-credit {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rc-credit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rc-credit-name {
  font-size: 14px;
  font-weight: 600;
}
.rc-card-status {
  color: var(--muted);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.rc-stmts {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 2px;
}
.rc-stmt {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}
.rc-stmt-due {
  color: var(--muted);
}

.chat-input-row {
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.chat-input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 16px;
  color: var(--text);
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  min-height: 40px;
  max-height: 120px;
}
.chat-input:focus {
  outline: none;
  border-color: var(--blue);
}

.chat-examples {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.chat-examples-label {
  font-size: 14px;
  color: var(--muted);
}
.chip {
  border: 1px solid var(--border);
  background: #fff;
  color: var(--blue);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}
.chip:hover:not(:disabled) {
  background: var(--blue-light);
}
.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-disclaimer {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--muted);
}

.is-compact .chat-bubble {
  max-width: calc(100% - 48px);
}
</style>
