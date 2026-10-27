// CloudBase 持久库模式的 AI 助手：复用既有系统提示、19 个工具契约与白名单，
// 通过异步 CloudBase RPC 完成查询 / 准备操作单 / 任务启动；不确认、不扣款、不校验凭据、不执行 SQL。
import { randomUUID, createHash } from 'node:crypto'
import { chatCompletions, AiError } from '../lib/ai-client.js'
import { loadCloudStore } from './store.js'
import { CloudRpcError } from './rpc-client.js'
import {
  AssistantError, ToolError, TOOL_DEFS, buildSystemMessage, parseToolArgs,
  refTail, centsToYuan, buildTransferStatusText, buildRepaymentStatusText, buildCardStatusText, buildSubscriptionStatusText,
  buildTransferNotice, buildCardOpNotice, buildSubscriptionOpNotice, buildRepaymentNotice,
  factsFromStatusSnapshots, statusReplyRelevant,
  TRANSFER_STATUS_TEXT, REPAYMENT_STATUS_TEXT,
  MAX_MODEL_CALLS, MAX_TOOL_CALLS, MAX_TURNS, MAX_USER_MESSAGE_LEN, REPLY_MAX_TOKENS,
} from '../services/assistant.js'
import { yuanToCents } from '../lib/money.js'
import { parseMonth } from '../routes/helpers.js'
import { shanghaiMonthRange } from '../lib/shanghai.js'
import { runSandboxedAnalysis } from '../services/sandbox.js'
import { detectCredential, scrubMessagesForModel, CREDENTIAL_REJECTION_MESSAGE } from '../services/credential-guard.js'
import { createCloudAuditTrail, newRequestId } from '../services/audit-trail.js'
import { buildReplyBlocks, buildTrustedReply, refsFromToolRecords, refsFromMessages } from '../services/fact-guard.js'
import { createWorkflowService, createCloudWorkflowStore, createCloudWorkflowOps } from '../services/workflow-plans.js'

function trimHistory(messages) {
  const userIdx = []
  messages.forEach((m, i) => { if (m.role === 'user') userIdx.push(i) })
  if (userIdx.length <= MAX_TURNS) return messages
  return messages.slice(userIdx[userIdx.length - MAX_TURNS])
}

function sessionFromRow(row) {
  return {
    id: row.id,
    messages: Array.isArray(row.messages_json) ? row.messages_json : [],
    locked: false,
    pendingTransferRef: row.pending_transfer_ref || null,
    pendingCardOpRef: row.pending_card_op_ref || null,
    pendingSubscriptionOpRef: row.pending_subscription_op_ref || null,
    pendingRepaymentRef: row.pending_repayment_ref || null,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    version: Number(row.version) || 0,
  }
}

function resolveReferencedTransfer(store, sessionId, session) {
  const ops = store.snapshot.transfer_operations || []
  let op = ops.find((o) => o.session_id === sessionId)
  if (!op && session.pendingTransferRef) op = store.snapshot.transfer_operations.find((o) => o.ref_no === session.pendingTransferRef)
  if (!op) return null
  const view = store.transferOp(op.ref_no)
  return {
    ref_no: op.ref_no,
    status: view ? view.status : op.status,
    amount_cents: op.amount_cents,
    from_account_name: op.from_account_name,
    recipient_name: op.recipient_name,
    transaction_id: view ? view.transaction_id || null : null,
    confirmed_at: op.confirmed_at,
  }
}

function resolveReferencedRepayment(store, sessionId, session) {
  const ops = store.snapshot.repayment_operations || []
  let op = ops.find((o) => o.session_id === sessionId)
  if (!op && session.pendingRepaymentRef) op = store.snapshot.repayment_operations.find((o) => o.ref_no === session.pendingRepaymentRef)
  if (!op) return null
  const v = store.repaymentByRef(op.ref_no)
  return {
    ref_no: op.ref_no,
    scope: op.scope || 'statement',
    status: v ? v.status : op.status,
    amount_cents: op.amount_cents,
    from_account_name: op.from_account_name,
    credit_account_name: op.credit_account_name,
    statement_month: op.statement_month,
    confirmed_at: op.confirmed_at,
    statement: v ? v.statement || null : null,
    allocations: v ? v.allocations : [],
  }
}

function resolveReferencedCard(store, sessionId, session) {
  const ref = session.pendingCardOpRef
  if (!ref) return null
  const view = store.cardOpByRef(ref)
  if (!view) return null
  return { ref_no: view.ref_no, status: view.status, action: view.action, card_masked: view.masked_card_number,
    from_status: view.from_status, to_status: view.to_status, card: view.card }
}

function resolveReferencedSubscription(store, sessionId, session) {
  const ref = session.pendingSubscriptionOpRef
  if (!ref) return null
  const view = store.subscriptionOpByRef(ref)
  if (!view) return null
  return { ref_no: view.ref_no, status: view.status, action: view.action, merchant: view.merchant,
    amount_cents: view.amount_cents, billing_cycle: view.billing_cycle,
    from_status: view.from_status, to_status: view.to_status }
}

function cardStatusReply(store, snapshot) {
  if (!snapshot || !snapshot.ref_no) return null
  const current = store.cardOpByRef(snapshot.ref_no)
  if (!current || current.status === snapshot.status) return null
  const act = current.action === 'freeze' ? '冻结' : '解冻'
  if (current.status === 'completed') return `该银行卡${act}操作已完成。`
  return `该银行卡${act}操作${({ pending:'待确认（未执行）', needs_verification:'需要强验证（未执行）', cancelled:'已取消', expired:'已过期', failed:'已失效' })[current.status] || current.status}。`
}

function subscriptionStatusReply(store, snapshot) {
  if (!snapshot || !snapshot.ref_no) return null
  const current = store.subscriptionOpByRef(snapshot.ref_no)
  if (!current || current.status === snapshot.status) return null
  const act = { pause:'暂停', resume:'恢复', cancel:'取消', change_source:'更换扣款账户' }[current.action] || current.action
  if (current.status === 'completed') return `该订阅${act}操作已完成。`
  return `该订阅${act}操作${({ pending:'待确认（未执行）', needs_verification:'需要强验证（未执行）', cancelled:'已取消', expired:'已过期', failed:'已失效' })[current.status] || current.status}。`
}

function transferStatusReply(store, snapshot) {
  if (!snapshot || typeof snapshot.ref_no !== 'string' || !snapshot.ref_no) return null
  const row = (store.snapshot.transfer_operations || []).find((o) => o.ref_no === snapshot.ref_no)
  const current = store.transferOp(snapshot.ref_no)
  if (!row || !current || current.status === snapshot.status) return null
  if (current.status === 'completed') {
    return `该笔转账已完成，金额 ${centsToYuan(row.amount_cents)} 元，流水编号 ${current.transaction_id ?? '未知'}。`
  }
  return `该笔转账${TRANSFER_STATUS_TEXT[current.status] || current.status}。`
}

function repaymentStatusReply(store, snapshot) {
  if (!snapshot || typeof snapshot.ref_no !== 'string' || !snapshot.ref_no) return null
  const row = (store.snapshot.repayment_operations || []).find((o) => o.ref_no === snapshot.ref_no)
  const current = store.repaymentByRef(snapshot.ref_no)
  if (!row || !current || current.status === snapshot.status) return null
  if (current.status === 'completed') {
    return `该笔信用卡还款已完成，金额 ${centsToYuan(row.amount_cents)} 元，账期 ${row.statement_month}。`
  }
  return `该笔信用卡还款${REPAYMENT_STATUS_TEXT[current.status] || current.status}。`
}

// 持久化前以数据库最新状态清理已终态的待确认引用，避免把外部已确认 / 已取消的旧单重新写回会话。
function reconcilePendingRefs(session, store) {
  const terminal = new Set(['completed', 'cancelled', 'expired', 'failed'])
  const clearIfTerminal = (key, resolve) => {
    const ref = session[key]
    if (!ref) return
    const op = resolve(ref)
    if (!op || terminal.has(op.status)) session[key] = null
  }
  clearIfTerminal('pendingTransferRef', (ref) => store.transferOp(ref))
  clearIfTerminal('pendingCardOpRef', (ref) => store.cardOpByRef(ref))
  clearIfTerminal('pendingSubscriptionOpRef', (ref) => store.subscriptionOpByRef(ref))
  clearIfTerminal('pendingRepaymentRef', (ref) => store.repaymentByRef(ref))
}

function findTransferRecipient(store, id) {
  return (store.snapshot.transfer_recipients || []).find((r) => Number(r.id) === Number(id)) || null
}

function depositAccounts(store) {
  return (store.snapshot.accounts || []).filter((a) => a.status === 'active' && a.account_type === 'deposit')
}

function cardById(store, id) {
  return (store.snapshot.cards || []).find((c) => Number(c.id) === Number(id)) || null
}

function subscriptionById(store, id) {
  return (store.snapshot.subscriptions || []).find((s) => Number(s.id) === Number(id)) || null
}

// 执行一个白名单工具。写操作只调用 prepare/create 类 RPC；绝不确认、扣款或校验凭据。
async function executeTool(state, client, userId, name, args, ctx) {
  const store = () => state.store
  const refresh = async () => { state.store = await loadCloudStore({ client, userId }); return state.store }

  if (name === 'get_accounts') {
    if (Object.keys(args).length > 0) throw new ToolError('get_accounts 不接受额外参数')
    return store().accounts()
  }
  if (name === 'get_monthly_analytics') {
    const extra = Object.keys(args).filter((k) => !['month', 'account_id'].includes(k))
    if (extra.length) throw new ToolError(`get_monthly_analytics 不接受额外参数：${extra.join('、')}`)
    const parsed = parseMonth(args.month)
    if (!parsed) throw new ToolError('month 参数格式应为 YYYY-MM（月份 01-12）')
    let accountId
    if (args.account_id !== undefined) {
      if (typeof args.account_id !== 'number' || !Number.isSafeInteger(args.account_id) || args.account_id <= 0) throw new ToolError('account_id 必须为正整数')
      if (!store().snapshot.accounts.some((a) => Number(a.id) === args.account_id)) throw new ToolError('未找到该账户或不属于当前用户')
      accountId = args.account_id
    }
    return store().analytics({ ...parsed, asOf: new Date().toISOString(), accountId })
  }
  if (name === 'analyze_transactions_sandboxed') {
    const extra = Object.keys(args).filter((k) => !['month', 'account_id', 'code'].includes(k))
    if (extra.length) throw new ToolError(`analyze_transactions_sandboxed 不接受额外参数：${extra.join('、')}`)
    const parsed = parseMonth(args.month)
    if (!parsed) throw new ToolError('month 参数格式应为 YYYY-MM（月份 01-12）')
    if (typeof args.code !== 'string' || !args.code.trim()) throw new ToolError('code 不能为空')
    let accountId
    if (args.account_id !== undefined) {
      if (typeof args.account_id !== 'number' || !Number.isSafeInteger(args.account_id) || args.account_id <= 0) throw new ToolError('account_id 必须为正整数')
      if (!store().snapshot.accounts.some((a) => Number(a.id) === args.account_id)) throw new ToolError('未找到该账户或不属于当前用户')
      accountId = args.account_id
    }
    const { start, end } = shanghaiMonthRange(parsed.year, parsed.month)
    const rows = store().snapshot.transactions.filter((t) => t.transaction_at >= start && t.transaction_at < end
      && (!accountId || Number(t.account_id) === accountId)).slice(0, 5001)
    if (rows.length > 5000) throw new ToolError('流水行数超过沙箱分析上限（5000）')
    try {
      const { result, summary } = await runSandboxedAnalysis(args.code, rows)
      return { analysis: result, execution: summary, authoritative: false,
        note: '沙箱结果仅为辅助分析，不是账户余额、流水事实或执行结果；关键事实必须以服务端工具结果为准。' }
    } catch (e) {
      throw new ToolError(`沙箱分析失败（${e.code || 'error'}）：${e.message}`)
    }
  }
  if (name === 'plan_workflow') {
    const extra = Object.keys(args).filter((k) => !['flow', 'params', 'steps'].includes(k))
    if (extra.length) throw new ToolError(`plan_workflow 不接受额外参数：${extra.join('、')}`)
    try {
      return await ctx.workflow.create({ flow: args.flow, params: args.params || {}, steps: args.steps },
        { requestId: ctx.requestId || null, sessionId: ctx.session?.id || null })
    } catch (e) {
      throw new ToolError(`计划创建失败：${e.message}`)
    }
  }
  if (name === 'list_transfer_recipients') {
    if (Object.keys(args).length > 0) throw new ToolError('list_transfer_recipients 不接受额外参数')
    return (store().snapshot.transfer_recipients || []).map((r) => ({ id: r.id, name: r.name, masked_account: r.masked_account }))
  }
  if (name === 'search_transfer_recipients') {
    const extra = Object.keys(args).filter((k) => k !== 'name')
    if (extra.length) throw new ToolError(`search_transfer_recipients 不接受额外参数：${extra.join('、')}`)
    const q = typeof args.name === 'string' ? args.name.trim() : ''
    if (!q) throw new ToolError('name 参数不能为空')
    const lower = q.toLowerCase()
    return (store().snapshot.transfer_recipients || [])
      .filter((r) => String(r.name).toLowerCase().includes(lower) || String(r.masked_account).toLowerCase().includes(lower))
      .map((r) => ({ id: r.id, name: r.name, masked_account: r.masked_account }))
  }
  if (name === 'get_transfer_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_transfer_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = store().transferOp(refNo)
    if (!op) throw new ToolError('未找到该转账单')
    return op
  }
  if (name === 'prepare_transfer') {
    if (ctx.messageState.prepareTransferDone) throw new ToolError('本条消息已生成转账单，请先确认或取消后再发起新转账')
    const extra = Object.keys(args).filter((k) => !['recipient_id', 'amount_yuan', 'remark', 'account_id'].includes(k))
    if (extra.length) throw new ToolError(`prepare_transfer 不接受额外参数：${extra.join('、')}`)
    const recipientId = args.recipient_id
    if (typeof recipientId !== 'number' || !Number.isSafeInteger(recipientId) || recipientId <= 0) throw new ToolError('recipient_id 必须为正整数')
    const recipient = findTransferRecipient(store(), recipientId)
    if (!recipient) throw new ToolError('收款人不存在，请先用 search_transfer_recipients 确认收款人')
    const cents = yuanToCents(args.amount_yuan)
    if (cents === null) throw new ToolError('amount_yuan 格式不正确（须为非负数字字符串，最多两位小数，不能为负/零/科学计数法）')
    if (cents <= 0) throw new ToolError('金额必须大于 0')
    const remark = typeof args.remark === 'string' ? args.remark.trim() : ''
    const accts = depositAccounts(store())
    let fromAccountId
    if (args.account_id !== undefined) {
      if (typeof args.account_id !== 'number' || !Number.isSafeInteger(args.account_id) || args.account_id <= 0) throw new ToolError('account_id 必须为正整数')
      if (!accts.some((a) => Number(a.id) === args.account_id)) throw new ToolError('付款账户不存在或不可用')
      fromAccountId = args.account_id
    } else if (accts.length === 1) fromAccountId = accts[0].id
    else if (accts.length > 1) throw new ToolError('存在多个付款账户，请先让用户选择付款账户')
    else throw new ToolError('没有可用的付款账户')

    const prevRef = ctx.session.pendingTransferRef
    let r
    try {
      r = await client.write('transfer', 'create', {
        recipient_id: recipientId, amount_cents: cents, remark, from_account_id: fromAccountId, session_id: ctx.session.id,
      }, userId)
    } catch (e) {
      if (e instanceof CloudRpcError && e.sqlState === '22023') {
        const prevNote = prevRef ? `；原待确认转账单（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`转账单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }
    await refresh()
    const op = store().transferOp(r.ref_no)
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = await client.write('transfer', 'cancel', { ref_no: prevRef }, userId)
      await refresh()
      const prevView = store().transferOp(prevRef)
      const prevStatus = prevView ? prevView.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingTransferRef = op.ref_no
    ctx.messageState.prepareTransferDone = true
    return { ...op, previous, notice: buildTransferNotice(previous, op.ref_no) }
  }
  if (name === 'get_cards') {
    if (Object.keys(args).length > 0) throw new ToolError('get_cards 不接受额外参数')
    return store().cards()
  }
  if (name === 'get_card_operation_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_card_operation_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = store().cardOpByRef(refNo)
    if (!op) throw new ToolError('未找到该银行卡操作单')
    return op
  }
  if (name === 'prepare_card_operation') {
    if (ctx.messageState.prepareCardOpDone) throw new ToolError('本条消息已生成银行卡操作单，请先确认或取消后再发起新操作')
    const extra = Object.keys(args).filter((k) => !['card_id', 'action'].includes(k))
    if (extra.length) throw new ToolError(`prepare_card_operation 不接受额外参数：${extra.join('、')}`)
    const cardId = args.card_id
    if (typeof cardId !== 'number' || !Number.isSafeInteger(cardId) || cardId <= 0) throw new ToolError('card_id 必须为正整数')
    const action = args.action
    if (action !== 'freeze' && action !== 'unfreeze') throw new ToolError('action 必须是 freeze 或 unfreeze')
    if (!cardById(store(), cardId)) throw new ToolError('未找到该银行卡，请先用 get_cards 查询本人银行卡')

    const prevRef = ctx.session.pendingCardOpRef
    let r
    try {
      r = await client.write('card', 'create', { card_id: cardId, action }, userId)
    } catch (e) {
      if (e instanceof CloudRpcError && e.sqlState === '22023') {
        const prevNote = prevRef ? `；原待确认银行卡操作（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`银行卡操作单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }
    await refresh()
    const op = store().cardOpByRef(r.ref_no)
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = await client.write('card', 'cancel', { ref_no: prevRef }, userId)
      await refresh()
      const prevView = store().cardOpByRef(prevRef)
      const prevStatus = prevView ? prevView.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingCardOpRef = op.ref_no
    ctx.messageState.prepareCardOpDone = true
    return { ...op, previous, notice: buildCardOpNotice(previous, op.ref_no, op.action) }
  }
  if (name === 'get_subscriptions') {
    if (Object.keys(args).length > 0) throw new ToolError('get_subscriptions 不接受额外参数')
    return store().subscriptions()
  }
  if (name === 'get_subscription_operation_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_subscription_operation_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = store().subscriptionOpByRef(refNo)
    if (!op) throw new ToolError('未找到该订阅操作单')
    return op
  }
  if (name === 'prepare_subscription_operation') {
    if (ctx.messageState.prepareSubscriptionOpDone) throw new ToolError('本条消息已生成订阅操作单，请先确认或取消后再发起新操作')
    const extra = Object.keys(args).filter((k) => !['subscription_id', 'action', 'to_account_id'].includes(k))
    if (extra.length) throw new ToolError(`prepare_subscription_operation 不接受额外参数：${extra.join('、')}`)
    const subscriptionId = args.subscription_id
    if (typeof subscriptionId !== 'number' || !Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) throw new ToolError('subscription_id 必须为正整数')
    const action = args.action
    if (!['pause', 'resume', 'cancel', 'change_source'].includes(action)) throw new ToolError('action 必须是 pause、resume、cancel 或 change_source')
    if (action === 'change_source' && args.to_account_id === undefined) throw new ToolError('更换扣款账户需要 to_account_id（新扣款账户 id）')
    if (action === 'change_source' && (typeof args.to_account_id !== 'number' || !Number.isSafeInteger(args.to_account_id) || args.to_account_id <= 0)) throw new ToolError('to_account_id 必须为正整数')
    if (!subscriptionById(store(), subscriptionId)) throw new ToolError('未找到该订阅，请先用 get_subscriptions 查询本人订阅')

    const prevRef = ctx.session.pendingSubscriptionOpRef
    let r
    try {
      r = await client.write('subscription', 'create', {
        subscription_id: subscriptionId, action, ...(args.to_account_id !== undefined ? { to_account_id: args.to_account_id } : {}),
      }, userId)
    } catch (e) {
      if (e instanceof CloudRpcError && e.sqlState === '22023') {
        const prevNote = prevRef ? `；原待确认订阅操作（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`订阅操作单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }
    await refresh()
    const op = store().subscriptionOpByRef(r.ref_no)
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = await client.write('subscription', 'cancel', { ref_no: prevRef }, userId)
      await refresh()
      const prevView = store().subscriptionOpByRef(prevRef)
      const prevStatus = prevView ? prevView.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingSubscriptionOpRef = op.ref_no
    ctx.messageState.prepareSubscriptionOpDone = true
    return { ...op, previous, notice: buildSubscriptionOpNotice(previous, op.ref_no, op.action) }
  }
  if (name === 'start_subscription_review') {
    if (ctx.messageState.startTaskDone) throw new ToolError('本条消息已启动跨场景任务，请先处理当前任务')
    const extra = Object.keys(args).filter((k) => k !== 'month')
    if (extra.length) throw new ToolError(`start_subscription_review 不接受额外参数：${extra.join('、')}`)
    const parsed = parseMonth(args.month)
    if (!parsed) throw new ToolError('month 参数格式应为 YYYY-MM（月份 01-12）')
    const r = await client.write('task', 'create', { month: args.month, session_id: ctx.session.id }, userId)
    await refresh()
    const task = store().taskByNo(r.task_no)
    if (!task) throw new ToolError('任务创建后读取失败')
    ctx.messageState.startTaskDone = true
    return task
  }
  if (name === 'get_credit_accounts') {
    const extra = Object.keys(args).filter((k) => k !== 'card_id')
    if (extra.length) throw new ToolError(`get_credit_accounts 不接受额外参数：${extra.join('、')}`)
    let cardId
    if (args.card_id !== undefined) {
      if (typeof args.card_id !== 'number' || !Number.isSafeInteger(args.card_id) || args.card_id <= 0) throw new ToolError('card_id 必须为正整数')
      cardId = args.card_id
    } else if (ctx.selectedCardId != null) cardId = ctx.selectedCardId
    const all = store().creditAccounts()
    if (cardId != null) {
      const card = cardById(store(), cardId)
      if (!card) throw new ToolError('未找到该银行卡，请先用 get_cards 查询本人银行卡')
      const found = all.find((c) => Number(c.account_id) === Number(card.account_id))
      if (!found) throw new ToolError('该卡不是信用卡，请用 get_cards 查看卡种')
      return found
    }
    return all
  }
  if (name === 'get_statement') {
    const extra = Object.keys(args).filter((k) => k !== 'statement_id')
    if (extra.length) throw new ToolError(`get_statement 不接受额外参数：${extra.join('、')}`)
    const sid = args.statement_id
    if (typeof sid !== 'number' || !Number.isSafeInteger(sid) || sid <= 0) throw new ToolError('statement_id 必须为正整数')
    const detail = store().statementDetail(sid)
    if (!detail) throw new ToolError('未找到该账单，请先用 get_credit_accounts 确认账单')
    return detail
  }
  if (name === 'get_repayment_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_repayment_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = store().repaymentByRef(refNo)
    if (!op) throw new ToolError('未找到该还款单')
    return op
  }
  if (name === 'prepare_repayment') {
    if (ctx.messageState.prepareRepaymentDone) throw new ToolError('本条消息已生成还款单，请先确认或取消后再发起新还款')
    const extra = Object.keys(args).filter((k) => !['statement_id', 'from_account_id', 'mode', 'credit_account_id'].includes(k))
    if (extra.length) throw new ToolError(`prepare_repayment 不接受额外参数：${extra.join('、')}`)
    const mode = args.mode === undefined ? 'statement' : args.mode
    if (mode !== 'statement' && mode !== 'all_posted') throw new ToolError('mode 仅支持 statement / all_posted')
    let sid
    if (mode === 'statement') {
      sid = args.statement_id
      if (typeof sid !== 'number' || !Number.isSafeInteger(sid) || sid <= 0) throw new ToolError('statement_id 必须为正整数')
      const detail = store().statementDetail(sid)
      if (!detail) throw new ToolError('未找到该账单，请先用 get_credit_accounts 确认账单')
      if (!detail.issued) throw new ToolError('该账单尚未出账；如要提前还清全部已入账欠款，请使用 mode=all_posted')
    } else if (args.statement_id !== undefined) {
      throw new ToolError('mode=all_posted 不接受 statement_id')
    }

    let creditAccountId
    if (mode === 'all_posted') {
      if (args.credit_account_id !== undefined) {
        if (typeof args.credit_account_id !== 'number' || !Number.isSafeInteger(args.credit_account_id) || args.credit_account_id <= 0) throw new ToolError('credit_account_id 必须为正整数')
        if (!store().creditAccounts().some((c) => Number(c.id) === args.credit_account_id)) throw new ToolError('未找到该信用账户')
        creditAccountId = args.credit_account_id
      } else if (ctx.selectedCardId) {
        const card = cardById(store(), ctx.selectedCardId)
        if (card) {
          const ca = store().creditAccounts().find((c) => Number(c.account_id) === Number(card.account_id))
          if (ca) creditAccountId = ca.id
        }
      }
    }

    const depAccts = depositAccounts(store())
    let fromAccountId
    if (args.from_account_id !== undefined) {
      if (typeof args.from_account_id !== 'number' || !Number.isSafeInteger(args.from_account_id) || args.from_account_id <= 0) throw new ToolError('from_account_id 必须为正整数')
      if (!depAccts.some((a) => Number(a.id) === args.from_account_id)) throw new ToolError('付款账户不存在、不可用或不是活期账户')
      fromAccountId = args.from_account_id
    } else if (depAccts.length === 1) fromAccountId = depAccts[0].id
    else if (depAccts.length > 1) throw new ToolError('存在多个付款活期账户，请先让用户选择付款账户')
    else throw new ToolError('没有可用的付款活期账户')

    const prevRef = ctx.session.pendingRepaymentRef
    let r
    try {
      r = await client.write('repayment', 'create', {
        scope: mode,
        statement_id: sid,
        from_account_id: fromAccountId,
        credit_account_id: creditAccountId,
        session_id: ctx.session.id,
      }, userId)
    } catch (e) {
      if (e instanceof CloudRpcError && e.sqlState === '22023') {
        const prevNote = prevRef ? `；原待确认还款单（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`还款单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }
    await refresh()
    const op = store().repaymentByRef(r.ref_no)
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = await client.write('repayment', 'cancel', { ref_no: prevRef }, userId)
      await refresh()
      const prevView = store().repaymentByRef(prevRef)
      const prevStatus = prevView ? prevView.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingRepaymentRef = op.ref_no
    ctx.messageState.prepareRepaymentDone = true
    return { ...op, previous, notice: buildRepaymentNotice(previous, op.ref_no) }
  }
  throw new ToolError(`未知工具：${name}`)
}

async function runLoop(messages, state, client, userId, chatFn, ctx) {
  const toolRecords = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  let modelCalls = 0
  let toolExecutions = 0
  let finalReply = ''
  let incomplete = false

  for (;;) {
    if (modelCalls >= MAX_MODEL_CALLS) {
      incomplete = true
      finalReply = '（已达到本轮模型调用上限，回答未完成，请稍后重试）'
      break
    }
    modelCalls += 1
    let r
    try {
      r = await chatFn({ messages, tools: TOOL_DEFS, maxTokens: REPLY_MAX_TOKENS })
    } catch (e) {
      if (e && e.code === 'model_breaker') {
        const ae = new AssistantError(e.message, 'breaker')
        ae.retry_after_ms = e.retry_after_ms
        throw ae
      }
      if (e instanceof AiError) {
        const code = e.kind === 'quota' || e.kind === 'concurrency' ? 'ai_quota' : 'model'
        throw new AssistantError(e.message, code)
      }
      throw e
    }
    if (r.usage) {
      usage.prompt_tokens += r.usage.prompt_tokens || 0
      usage.completion_tokens += r.usage.completion_tokens || 0
      usage.total_tokens += r.usage.total_tokens || 0
    }
    const tcs = Array.isArray(r.toolCalls) ? r.toolCalls : []
    const content = typeof r.content === 'string' ? r.content.trim() : ''
    if (tcs.length === 0) {
      finalReply = content || '（模型未返回有效回答）'
      break
    }
    messages.push({ role: 'assistant', content: content || null, tool_calls: tcs })
    let stopped = false
    for (const call of tcs) {
      if (toolExecutions >= MAX_TOOL_CALLS) {
        incomplete = true
        finalReply = '（已达到本轮工具执行上限，回答未完成，请稍后重试）'
        stopped = true
        break
      }
      toolExecutions += 1
      const id = typeof call?.id === 'string' && call.id ? call.id : `tool_${toolExecutions}`
      const name = typeof call?.function?.name === 'string' ? call.function.name : '(未知)'
      const started = Date.now()
      let args
      try {
        args = parseToolArgs(call?.function?.arguments)
      } catch (e) {
        toolRecords.push({ name, call_id: id, args: null, status: 'error', queryTime: new Date().toISOString(), error: e.message })
        messages.push({ role: 'tool', tool_call_id: id, content: `错误：${e.message}` })
        if (ctx.audit) await ctx.audit.record({ request_id: ctx.requestId, session_id: ctx.session.id,
          tool_call_id: id, category: 'tool', action: name, result: 'error',
          detail: { error: e.message, duration_ms: Date.now() - started } })
        continue
      }
      try {
        const data = await executeTool(state, client, userId, name, args, ctx)
        toolRecords.push({ name, call_id: id, args, status: 'ok', queryTime: new Date().toISOString(), data })
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(data) })
        if (ctx.audit) await ctx.audit.record({ request_id: ctx.requestId, session_id: ctx.session.id,
          tool_call_id: id, operation_ref: data?.ref_no || data?.task_no || data?.plan_no || null,
          risk_level: data?.risk_level || null, category: 'tool', action: name, result: 'ok',
          detail: { args, operation_ref: data?.ref_no || data?.task_no || data?.plan_no || null, duration_ms: Date.now() - started } })
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : '工具执行失败'
        toolRecords.push({ name, call_id: id, args, status: 'error', queryTime: new Date().toISOString(), error: msg })
        messages.push({ role: 'tool', tool_call_id: id, content: `错误：${msg}` })
        if (ctx.audit) await ctx.audit.record({ request_id: ctx.requestId, session_id: ctx.session.id,
          tool_call_id: id, category: 'tool', action: name, result: 'error',
          detail: { args, error: msg, duration_ms: Date.now() - started } })
      }
    }
    if (stopped) break
  }
  messages.push({ role: 'assistant', content: finalReply })
  return { finalReply, toolRecords, incomplete, usage }
}

export function collectCloudFacts(store, refs) {
  const snap = store.snapshot || {}
  const facts = new Map()
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref) continue
    const t = (snap.transfer_operations || []).find((o) => o.ref_no === ref)
    if (t) {
      const v = store.transferOp(ref)
      facts.set(`transfer:${ref}`, { kind: 'transfer', ref_no: ref, status: t.status, amount_cents: t.amount_cents,
        transaction_id: v ? v.transaction_id ?? null : null, risk_level: t.risk_level, expires_at: t.expires_at })
      continue
    }
    const c = (snap.card_operations || []).find((o) => o.ref_no === ref)
    if (c) { facts.set(`card:${ref}`, { kind: 'card', ref_no: ref, status: c.status, action: c.action, card_masked: c.card_masked,
      risk_level: c.risk_level, expires_at: c.expires_at }); continue }
    const sub = (snap.subscription_operations || []).find((o) => o.ref_no === ref)
    if (sub) { facts.set(`subscription:${ref}`, { kind: 'subscription', ref_no: ref, status: sub.status, action: sub.action,
      amount_cents: sub.amount_cents, merchant: sub.merchant, risk_level: sub.risk_level, expires_at: sub.expires_at }); continue }
    const r = (snap.repayment_operations || []).find((o) => o.ref_no === ref)
    if (r) { facts.set(`repayment:${ref}`, { kind: 'repayment', ref_no: ref, status: r.status, action: 'repay',
      amount_cents: r.amount_cents, statement_month: r.statement_month, risk_level: r.risk_level, expires_at: r.expires_at }) }
  }
  return [...facts.values()]
}

export function createCloudAssistant({ client, userId, chatFn = chatCompletions, auditTrail = createCloudAuditTrail({ client, userId }), workflowService = null }) {
  const sessions = new Map()
  const load = () => loadCloudStore({ client, userId })
  const workflow = workflowService || createWorkflowService({
    store: createCloudWorkflowStore({ client, userId }), ops: createCloudWorkflowOps({ client, userId }), audit: auditTrail,
  })

  async function chat({ message, sessionId, selectedCardId = null, requestId: requestIdIn = null }) {
    const requestId = requestIdIn || newRequestId()
    const messageSha256 = typeof message === 'string' ? createHash('sha256').update(message).digest('hex') : null
    if (typeof message !== 'string' || message.trim() === '') throw new AssistantError('消息不能为空')
    if (message.length > MAX_USER_MESSAGE_LEN) throw new AssistantError(`消息过长（最多 ${MAX_USER_MESSAGE_LEN} 字符）`)
    const credentialReason = detectCredential(message)
    if (credentialReason) {
      await auditTrail.record({
        request_id: requestId, session_id: typeof sessionId === 'string' ? sessionId : null,
        category: 'security', action: 'credential_input_blocked', result: 'blocked',
        detail: { reason: credentialReason, message_sha256: messageSha256 },
      })
      throw new AssistantError(CREDENTIAL_REJECTION_MESSAGE, 'credential_detected')
    }

    const snap = await load()
    if (selectedCardId !== null && selectedCardId !== undefined) {
      if (typeof selectedCardId !== 'number' || !Number.isSafeInteger(selectedCardId) || selectedCardId <= 0) {
        throw new AssistantError('selectedCardId 必须为正整数', 'bad_card')
      }
      if (!(snap.snapshot.cards || []).some((c) => Number(c.id) === selectedCardId)) {
        throw new AssistantError('未找到该银行卡', 'bad_card')
      }
    }

    const trimmed = message.trim()
    const pointerAtStart = snap.snapshot.chat_state ? snap.snapshot.chat_state.current_session_id : null
    let session = sessionId ? sessions.get(sessionId) : null
    if (!session && sessionId) {
      const row = (snap.snapshot.chat_sessions || []).find((s) => s.id === sessionId)
      if (row) {
        session = sessionFromRow(row)
        sessions.set(session.id, session)
      }
    }
    if (!session) {
      session = {
        id: randomUUID(), messages: [], locked: false,
        pendingTransferRef: null, pendingCardOpRef: null, pendingSubscriptionOpRef: null, pendingRepaymentRef: null,
        createdAt: Date.now(), lastActiveAt: Date.now(), version: 0,
      }
      sessions.set(session.id, session)
    }
    await auditTrail.record({
      request_id: requestId, session_id: session.id,
      category: 'assistant', action: 'request', result: 'received',
      detail: { message_length: trimmed.length, message_sha256: messageSha256,
        requested_session_id: typeof sessionId === 'string' ? sessionId : null,
        selected_card_id: selectedCardId || null },
    })
    if (session.locked) {
      await auditTrail.record({ request_id: requestId, session_id: session.id, category: 'security',
        action: 'session_locked', result: 'blocked', detail: { reason: 'concurrent_request' } })
      throw new AssistantError('该会话正在处理上一个请求，请稍候再试', 'locked')
    }
    session.locked = true
    session.lastActiveAt = Date.now()

    try {
      const history = scrubMessagesForModel(trimHistory(session.messages))
      const snapshotTransfer = resolveReferencedTransfer(snap, session.id, session)
      const snapshotRepayment = resolveReferencedRepayment(snap, session.id, session)
      const snapshotCard = resolveReferencedCard(snap, session.id, session)
      const snapshotSubscription = resolveReferencedSubscription(snap, session.id, session)
      const transferContext = snapshotTransfer ? buildTransferStatusText(snapshotTransfer) : ''
      const repaymentContext = snapshotRepayment ? buildRepaymentStatusText(snapshotRepayment) : ''
      const cardContext = snapshotCard ? buildCardStatusText(snapshotCard) : ''
      const subscriptionContext = snapshotSubscription ? buildSubscriptionStatusText(snapshotSubscription) : ''
      const messages = [buildSystemMessage(transferContext, repaymentContext, cardContext, subscriptionContext), ...history, { role: 'user', content: trimmed }]
      const state = { store: snap }
      const messageState = {
        prepareTransferDone: false, prepareCardOpDone: false, prepareSubscriptionOpDone: false,
        startTaskDone: false, prepareRepaymentDone: false,
      }
      let loopResult
      try {
        loopResult = await runLoop(
          messages, state, client, userId, chatFn,
          { session, messageState, selectedCardId, audit: auditTrail, requestId, workflow },
        )
      } catch (e) {
        await auditTrail.record({
          request_id: requestId, session_id: session.id, category: 'assistant',
          action: 'model_error', result: 'error', detail: { code: e.code || 'error' },
        })
        throw e
      }
      const { finalReply, toolRecords, incomplete, usage } = loopResult

      // 回复生成后复核本轮引用单的最新状态；变化时用服务端权威文案替换模型草稿。
      await load().then((fresh) => { state.store = fresh })
      const authoritativeReplies = [
        statusReplyRelevant('transfer', trimmed, toolRecords) ? transferStatusReply(state.store, snapshotTransfer) : null,
        statusReplyRelevant('repayment', trimmed, toolRecords) ? repaymentStatusReply(state.store, snapshotRepayment) : null,
        statusReplyRelevant('card', trimmed, toolRecords) ? cardStatusReply(state.store, snapshotCard) : null,
        statusReplyRelevant('subscription', trimmed, toolRecords) ? subscriptionStatusReply(state.store, snapshotSubscription) : null,
      ].filter((x) => x !== null)
      const toolRefs = refsFromToolRecords(toolRecords)
      const pendingRefs = new Set([session.pendingTransferRef, session.pendingCardOpRef,
        session.pendingSubscriptionOpRef, session.pendingRepaymentRef].filter(Boolean))
      const historyRefs = refsFromMessages(session.messages)
      let factRefs
      if (toolRefs.size) factRefs = toolRefs
      else if (pendingRefs.size) factRefs = pendingRefs
      else factRefs = new Set([...historyRefs].slice(-1))
      const authoritativeFacts = collectCloudFacts(state.store, factRefs)
      const statusToolFailed = toolRecords.some((t) => t.status === 'error'
        && /_status$/.test(String(t.name || '')))
      // 与本地助手同一套受信输出：块是唯一事实来源，模型 content 只接受结构化信封。
      const prepareToolByKind = { transfer: 'prepare_transfer', repayment: 'prepare_repayment',
        card: 'prepare_card_operation', subscription: 'prepare_subscription_operation' }
      const snapshotFacts = factsFromStatusSnapshots({
        transfer: snapshotTransfer, repayment: snapshotRepayment,
        card: snapshotCard, subscription: snapshotSubscription,
      }, trimmed).filter((f) => !toolRecords.some((r) => r.status === 'ok' && r.name === prepareToolByKind[f.kind]))
      const blockFacts = [...authoritativeFacts.filter((f) => toolRefs.has(f.ref_no) || pendingRefs.has(f.ref_no)),
        ...snapshotFacts].filter((f, i, arr) => arr.findIndex((x) => `${x.kind}:${x.ref_no}` === `${f.kind}:${f.ref_no}`) === i)
      const replyBlocks = buildReplyBlocks({ toolRecords, facts: blockFacts })
      const trusted = buildTrustedReply({
        content: finalReply,
        blocks: replyBlocks,
        toolRecords,
        queryFailed: statusToolFailed,
        authoritative: authoritativeReplies.length > 0,
        statusTexts: authoritativeReplies,
        context: { accounts: (state.store.snapshot?.accounts || []) },
      })
      const reply = trusted.reply
      const lastMsg = messages[messages.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') lastMsg.content = reply

      const newMessages = messages.slice(1 + history.length)
      session.messages.push(...newMessages)
      session.messages = trimHistory(session.messages)
      session.lastActiveAt = Date.now()
      reconcilePendingRefs(session, state.store)

      const turnId = randomUUID()
      const saved = await client.write('chat', 'save_turn', {
        session_id: session.id,
        turn_id: turnId,
        base_version: session.version || 0,
        messages: session.messages,
        new_messages: newMessages,
        pending_transfer_ref: session.pendingTransferRef,
        pending_card_op_ref: session.pendingCardOpRef,
        pending_subscription_op_ref: session.pendingSubscriptionOpRef,
        pending_repayment_ref: session.pendingRepaymentRef,
        created_at: session.createdAt,
        user_text: trimmed,
        reply,
        tool_records: toolRecords,
        incomplete: !!incomplete,
        pointer_at_start: pointerAtStart,
      }, userId)
      if (saved && Number.isFinite(Number(saved.session_version))) {
        session.version = Number(saved.session_version)
      }
      if (saved && Array.isArray(saved.messages)) {
        session.messages = saved.messages
      }

      await auditTrail.record({
        request_id: requestId, session_id: session.id, category: 'assistant',
        action: 'reply', result: incomplete ? 'incomplete' : 'ok',
        detail: { reply_chars: reply.length, reply_sha256: createHash('sha256').update(reply).digest('hex'),
          tool_calls: toolRecords.length, tool_errors: toolRecords.filter((t) => t.status === 'error').length,
          intent: toolRecords.map((t) => t.name).join('>') || 'no_tool', incomplete },
      })
      return { sessionId: session.id, reply, toolRecords, incomplete, usage, request_id: requestId,
        authoritative_facts: authoritativeFacts, reply_blocks: trusted.blocks,
        fact_guard: { changed: reply !== finalReply, reason: trusted.reason,
          protocol: trusted.protocol, trust: trusted.trust, dropped_raw: trusted.dropped_raw } }
    } finally {
      session.locked = false
      session.lastActiveAt = Date.now()
    }
  }

  return { chat, _sessions: sessions }
}
