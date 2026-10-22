<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { chatAssistant, fetchCurrentChat, newConversation } from '../api/index.js'
import { formatMoney, formatCentsToYuan, formatShanghaiDateTime } from '../utils/format.js'
import { useDataRefresh } from '../composables/useDataRefresh.js'
import { useTransferSignal } from '../composables/useTransferSignal.js'
import { useCardOpSignal } from '../composables/useCardOpSignal.js'
import { useSubscriptionOpSignal } from '../composables/useSubscriptionOpSignal.js'
import TransferConfirmCard from './TransferConfirmCard.vue'
import CardOperationConfirmCard from './CardOperationConfirmCard.vue'
import SubscriptionOperationConfirmCard from './SubscriptionOperationConfirmCard.vue'
import AgentTasksSection from './AgentTasksSection.vue'
import MarkdownContent from './MarkdownContent.vue'

const examples = [
  '我的账户余额是多少？',
  '这个月支出最多的是哪一类？',
  '我有哪些银行卡？',
]

const { refresh } = useDataRefresh()
const { notifyChange } = useTransferSignal()
const { notifyChange: notifyCardOpChange } = useCardOpSignal()
const { notifyChange: notifySubscriptionOpChange } = useSubscriptionOpSignal()

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
function onTransferConfirmed() {
  refresh() // 确认后刷新账户 / 流水 / 月度统计
}
function onCardOpConfirmed() {
  refresh() // 冻结 / 解冻后刷新卡片列表等
}
function onSubscriptionOpConfirmed() {
  refresh() // 暂停 / 恢复 / 取消后刷新订阅列表等
}

const messages = ref([])
const input = ref('')
const sending = ref(false)
const sessionId = ref(null)
const listEl = ref(null)
const inputEl = ref(null)
const composing = ref(false)
const loading = ref(true)
const loadError = ref('')
const sessionExpired = ref(false)
const tasksRef = ref(null)

// 任务区业务变更（如暂停订阅确认）后刷新相关分区
function onTaskChanged() {
  refresh()
}

let seq = 0
function nextId() {
  seq += 1
  return seq
}

// 带正负号金额（整数分 → +¥1,500.00）
function moneyWithSign(cents) {
  const sign = cents >= 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(cents), 'CNY')}`
}

// 经过校验的工具参数 → 简短展示
function renderArgs(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return '无参数'
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${v}`)
    .join('，')
}

// 仅取「成功且含数据」的工具记录用于渲染结果卡片（权威数值来自工具结果）
function okRecords(m) {
  if (!m.toolRecords) return []
  return m.toolRecords
    .map((r, i) => ({ ...r, __i: i }))
    .filter((r) => r.status === 'ok' && r.data != null)
}

async function scrollToBottom() {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

function focusInput() {
  if (inputEl.value) inputEl.value.focus()
}

// 组合输入（中文输入法选字 / 组字）标记，避免回车误发送
function onCompositionStart() {
  composing.value = true
}
function onCompositionEnd() {
  composing.value = false
}

function onKeydown(e) {
  // 仅处理「回车发送」；Shift+Enter 走默认换行（textarea 原生行为）
  if (e.key !== 'Enter' || e.shiftKey) return
  // 组合输入中 / Safari keyCode 229 时回车不发送
  if (composing.value || e.isComposing || e.keyCode === 229) {
    e.preventDefault()
    return
  }
  e.preventDefault()
  send(input.value)
}

async function send(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value || sending.value) return

  messages.value.push({ id: nextId(), role: 'user', text: value, toolRecords: [], incomplete: false, error: '' })
  input.value = ''
  sending.value = true
  await nextTick()
  focusInput() // 发送后立即聚焦，便于边等待边继续输入
  await scrollToBottom()

  try {
    const data = await chatAssistant({ message: value, sessionId: sessionId.value })
    sessionId.value = data.sessionId || sessionId.value
    sessionExpired.value = false
    messages.value.push({
      id: nextId(),
      role: 'assistant',
      text: data.reply || '',
      toolRecords: data.toolRecords || [],
      incomplete: !!data.incomplete,
      error: '',
    })
    // 改单：通知旧待确认单的已显示卡片回读最新状态（无需手动刷新即显示「已取消」）
    for (const rec of data.toolRecords || []) {
      if (rec.name === 'prepare_transfer' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
        notifyChange(rec.data.previous.ref_no)
      }
      if (rec.name === 'prepare_card_operation' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
        notifyCardOpChange(rec.data.previous.ref_no)
      }
      if (rec.name === 'prepare_subscription_operation' && rec.data && rec.data.previous && rec.data.previous.ref_no) {
        notifySubscriptionOpChange(rec.data.previous.ref_no)
      }
      if (rec.name === 'start_subscription_review') {
        // 模型启动了跨场景任务：刷新任务区，展示任务进度卡
        if (tasksRef.value) tasksRef.value.refresh()
      }
    }
  } catch (e) {
    messages.value.push({
      id: nextId(),
      role: 'assistant',
      text: '',
      toolRecords: [],
      incomplete: false,
      error: e && e.message ? e.message : '请求失败',
    })
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

async function newChat() {
  if (sending.value) return
  messages.value = []
  sessionId.value = null
  input.value = ''
  sessionExpired.value = false
  loadError.value = ''
  loading.value = false
  try {
    await newConversation()
  } catch {
    // 服务端切换失败不阻塞本地清空；下次发送会新建会话
  }
  await nextTick()
  focusInput()
}

async function loadCurrent() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchCurrentChat()
    sessionId.value = data.sessionId || null
    sessionExpired.value = !!data.expired
    messages.value = (data.messages || []).map((m) => ({
      id: nextId(),
      role: m.role,
      text: m.text || '',
      toolRecords: m.toolRecords || [],
      incomplete: !!m.incomplete,
      error: m.error || '',
    }))
  } catch (e) {
    loadError.value = e && e.message ? e.message : '加载聊天记录失败'
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

onMounted(loadCurrent)
</script>

<template>
  <section class="section assistant">
    <div class="assistant-head">
      <h2 class="section-title">AI 助手</h2>
      <button class="btn-ghost" :disabled="sending" @click="newChat">新建对话</button>
    </div>

    <AgentTasksSection ref="tasksRef" @changed="onTaskChanged" />

    <div ref="listEl" class="chat-list">
      <p v-if="loading" class="chat-empty">正在加载聊天记录…</p>

      <div v-if="!loading && loadError" class="chat-load-error">
        <p class="chat-error">{{ loadError }}</p>
        <button class="btn-ghost" @click="loadCurrent">重试</button>
      </div>

      <p v-if="!loading && !loadError && sessionExpired" class="chat-expired">
        会话已过期：历史记录仍可查看，但后续对话将从全新上下文开始，不会「记得」之前的细节。
      </p>

      <p v-if="!loading && !loadError && messages.length === 0" class="chat-empty">
        我是融智 AI 助手，可以查询账户余额、账单统计、银行卡与订阅代扣，也能帮你生成待确认转账单、银行卡冻结 / 解冻操作单或订阅暂停 / 恢复 / 取消操作单。例如「我有哪些订阅？」。
      </p>

      <div v-for="m in messages" :key="m.id" class="chat-row" :class="m.role">
        <div class="chat-bubble">
          <!-- 用户消息 -->
          <p v-if="m.role === 'user'" class="chat-text">{{ m.text }}</p>

          <!-- 助手消息 -->
          <template v-else>
            <p v-if="m.error" class="chat-error">{{ m.error }}</p>
            <template v-else>
              <MarkdownContent v-if="m.text" :text="m.text" />
              <p v-if="m.incomplete" class="chat-incomplete">（本轮回答未完成，请稍后重试）</p>

              <!-- 结果卡片：账户余额 / 月度账单（数值来自工具结果，权威） -->
              <div v-for="rec in okRecords(m)" :key="rec.__i" class="result-cards">
                <template v-if="rec.name === 'get_accounts'">
                  <div v-for="acc in rec.data" :key="acc.id" class="result-card">
                    <span class="rc-label">账户 · {{ acc.account_name }}（{{ acc.currency }}）</span>
                    <span class="rc-value">{{ formatMoney(acc.balance_cents, acc.currency) }}</span>
                  </div>
                </template>

                <template v-else-if="rec.name === 'get_monthly_analytics'">
                  <div class="result-card monthly">
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
                  </div>
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

                <template v-else-if="rec.name === 'prepare_transfer'">
                  <p v-if="rec.data && rec.data.notice" class="transfer-notice">{{ rec.data.notice }}</p>
                  <TransferConfirmCard :op="rec.data" @confirmed="onTransferConfirmed" />
                </template>

                <template v-else-if="rec.name === 'get_transfer_status'">
                  <div class="result-card status">
                    <span class="rc-label">转账单 · {{ rec.data.ref_no }}</span>
                    <span class="rc-value">{{ statusText(rec.data.status) }}</span>
                    <span v-if="rec.data.amount_cents" class="rc-note">¥{{ formatCentsToYuan(rec.data.amount_cents) }}</span>
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
                  <p v-if="rec.data && rec.data.notice" class="transfer-notice">{{ rec.data.notice }}</p>
                  <CardOperationConfirmCard :op="rec.data" @confirmed="onCardOpConfirmed" />
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
                  <p v-if="rec.data && rec.data.notice" class="transfer-notice">{{ rec.data.notice }}</p>
                  <SubscriptionOperationConfirmCard :op="rec.data" @confirmed="onSubscriptionOpConfirmed" />
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
              </div>

              <!-- 工具执行记录（由后端生成） -->
              <div v-if="m.toolRecords && m.toolRecords.length" class="tool-log">
                <div v-for="(r, i) in m.toolRecords" :key="i" class="tool-item">
                  <span class="tool-name">{{ r.name }}</span>
                  <span class="tool-args">{{ renderArgs(r.args) }}</span>
                  <span class="tool-status" :class="r.status === 'ok' ? 'is-ok' : 'is-error'">
                    {{ r.status === 'ok' ? '成功' : '失败' }}
                  </span>
                  <span class="tool-time">{{ formatShanghaiDateTime(r.queryTime) }}</span>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>

      <div v-if="sending" class="chat-row assistant">
        <div class="chat-bubble"><p class="chat-text chat-waiting">正在思考…</p></div>
      </div>
    </div>

    <div class="chat-input-row">
      <textarea
        ref="inputEl"
        v-model="input"
        class="chat-input"
        rows="1"
        placeholder="例如：我的账户余额是多少？（Enter 发送，Shift+Enter 换行）"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      ></textarea>
      <button class="btn" :disabled="sending || !input.trim()" @click="send(input)">发送</button>
    </div>

    <div class="chat-examples">
      <span class="chat-examples-label">示例：</span>
      <button v-for="q in examples" :key="q" class="chip" :disabled="sending" @click="send(q)">{{ q }}</button>
    </div>

    <p class="chat-disclaimer">AI 助手可查询账户 / 账单 / 银行卡 / 订阅代扣，并可生成待确认转账单、银行卡冻结 / 解冻操作单与订阅暂停 / 恢复 / 取消操作单，但不执行扣款或直接改变任何状态；暂停 / 取消需你在确认卡上确认，解冻 / 恢复需交易密码 + 动态验证码强验证。数据均为模拟，仅供演示。</p>
  </section>
</template>

<style scoped>
.assistant-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.assistant-head .section-title {
  margin: 0;
}

.chat-list {
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}
.chat-empty {
  color: var(--muted);
  font-size: 14px;
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
.chat-expired {
  margin: 0 0 4px;
  padding: 8px 12px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  font-size: 13px;
  color: #92400e;
}
.chat-row {
  display: flex;
}
.chat-row.user {
  justify-content: flex-end;
}
.chat-row.assistant {
  justify-content: flex-start;
}
.chat-bubble {
  max-width: 86%;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 14px;
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
.chat-error {
  margin: 0;
  color: #b91c1c;
}
.chat-incomplete {
  margin: 6px 0 0;
  color: #b45309;
  font-size: 13px;
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
.result-card.task-started {
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
  font-size: 13px;
  color: var(--muted);
}
.rc-value {
  font-size: 20px;
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

.tool-log {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
}
.tool-name {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-weight: 600;
  color: #475569;
}
.tool-args {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.tool-status {
  padding: 1px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.tool-status.is-ok {
  background: #dcfce7;
  color: #15803d;
}
.tool-status.is-error {
  background: #fee2e2;
  color: #b91c1c;
}
.tool-time {
  font-variant-numeric: tabular-nums;
}

.chat-input-row {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.chat-input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
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
  font-size: 13px;
  color: var(--muted);
}
.chip {
  border: 1px solid var(--border);
  background: #fff;
  color: var(--blue);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 13px;
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
  font-size: 12px;
  color: var(--muted);
}
</style>
