// 只读接口请求封装。全部使用相对地址 /api/...，由 Vite 开发服务器代理到后端。
// 统一校验响应格式：成功返回 body，失败抛出带中文说明的 Error。

async function request(path) {
  let res
  try {
    res = await fetch(path)
  } catch {
    throw new Error('无法连接到后端服务')
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应（如代理错误页），走下方统一错误分支
  }

  if (!res.ok || !body || body.success !== true) {
    const message = body && body.message ? body.message : `请求失败（HTTP ${res.status}）`
    throw new Error(message)
  }
  return body
}

export async function fetchAccounts() {
  const body = await request('/api/accounts')
  return body.data
}

export async function fetchCards() {
  const body = await request('/api/cards')
  return body.data
}

export async function fetchSubscriptions() {
  const body = await request('/api/subscriptions')
  return body.data
}

// month 为空表示不筛选（全部月份）；status 为空表示不筛选（全部入账状态）；
// accountId 为可选账户过滤（借记卡选择驱动按账户查看流水）
export async function fetchTransactions({ month, status, accountId, limit, offset }) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (month) params.set('month', month)
  if (status) params.set('status', status)
  if (accountId) params.set('account_id', String(accountId))
  const body = await request(`/api/transactions?${params.toString()}`)
  return { rows: body.data, total: body.meta.total }
}

// 月度账单分析（month 必填；accountId 为可选账户过滤）
export async function fetchMonthlyAnalytics({ month, accountId }) {
  const params = new URLSearchParams()
  params.set('month', month)
  if (accountId) params.set('account_id', String(accountId))
  const body = await request(`/api/analytics/monthly?${params.toString()}`)
  return body.data
}

// POST JSON，统一校验响应格式（成功返回 body，失败抛带中文说明的 Error）
async function postJson(path, payload) {
  let res
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('无法连接到后端服务')
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应走统一错误分支
  }

  if (!res.ok || !body || body.success !== true) {
    const message = body && body.message ? body.message : `请求失败（HTTP ${res.status}）`
    const err = new Error(message)
    if (body && typeof body.code === 'string') err.code = body.code // 保留业务错误码（不含任何凭据）
    throw err
  }
  return body
}

// 构造助手对话请求体：仅当 sessionId 为非空字符串时才附带，否则省略该字段；
// selectedCardId 为当前选中卡（由前端显式传递，服务端核验归属），仅正整数时附带。
// 避免把 null / undefined / 空字符串序列化成 "null" 等非法值，导致后端 400。
export function buildChatPayload(message, sessionId, selectedCardId) {
  const payload = { message }
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    payload.sessionId = sessionId.trim()
  }
  if (typeof selectedCardId === 'number' && Number.isSafeInteger(selectedCardId) && selectedCardId > 0) {
    payload.selectedCardId = selectedCardId
  }
  return payload
}

// AI 助手对话：首次仅提交 { message }；后续携带后端返回的 sessionId 追问；
// selectedCardId 为当前选中卡（前端显式传递，服务端核验归属后用于按卡查询 / 生成还款单）
export async function chatAssistant({ message, sessionId, selectedCardId }) {
  const body = await postJson('/api/assistant/chat', buildChatPayload(message, sessionId, selectedCardId))
  return body.data
}

// 读取当前对话（刷新恢复；只读，不调用模型、不重发消息）
export async function fetchCurrentChat() {
  const body = await request('/api/assistant/current')
  return body.data
}

// 会话历史列表（只读；标题取首条用户消息，含最近活跃时间）
export async function fetchConversations() {
  const body = await request('/api/assistant/conversations')
  return body.data
}

// 打开历史会话：切换服务端当前对话指针并返回该会话消息（不重发、不调用模型）
export async function selectConversation(id) {
  const body = await postJson(`/api/assistant/conversations/${encodeURIComponent(id)}/select`, {})
  return body.data
}

// 服务端切换「新建对话」（清除当前对话指针；不删除历史、不改业务数据）
export async function newConversation() {
  const body = await postJson('/api/assistant/new', {})
  return body.data
}

// —— 模拟转账 ——

export async function fetchTransferRecipients() {
  const body = await request('/api/transfers/recipients')
  return body.data
}

// 付款账户必须显式传入（服务端核验归属 / 活期类型 / 余额；信用卡一律拒绝）
export async function createTransfer({ recipient_id, amount_cents, remark, from_account_id }) {
  const body = await postJson('/api/transfers', { recipient_id, amount_cents, remark, from_account_id })
  return body.data
}

export async function fetchTransfer(refNo) {
  const body = await request(`/api/transfers/${refNo}`)
  return body.data
}

export async function confirmTransfer(refNo) {
  const body = await postJson(`/api/transfers/${refNo}/confirm`, { confirm: true })
  return body.data
}

export async function cancelTransfer(refNo) {
  const body = await postJson(`/api/transfers/${refNo}/cancel`, { cancel: true })
  return body.data
}

// —— 强验证 ——

// 读取验证器绑定 / 锁定状态（不含任何密码 / 密钥 / 验证码）
export async function fetchVerificationStatus() {
  const body = await request('/api/verification/status')
  return body.data
}

// 强验证确认转账（交易密码 + 动态验证码；凭据仅发往专用验证接口，不进入 AI 请求 / 聊天历史 / 本地存储）
export async function verifyTransfer(refNo, { password, totp }) {
  const body = await postJson(`/api/transfers/${refNo}/verify`, { password, totp })
  return body.data
}

// —— 银行卡操作（查询 + 临时冻结 / 解冻）——

export async function createCardOperation({ card_id, action }) {
  const body = await postJson('/api/card-operations', { card_id, action })
  return body.data
}

export async function fetchCardOperation(refNo) {
  const body = await request(`/api/card-operations/${refNo}`)
  return body.data
}

export async function confirmCardOperation(refNo) {
  const body = await postJson(`/api/card-operations/${refNo}/confirm`, { confirm: true })
  return body.data
}

export async function cancelCardOperation(refNo) {
  const body = await postJson(`/api/card-operations/${refNo}/cancel`, { cancel: true })
  return body.data
}

// 强验证确认解冻（交易密码 + 动态验证码；凭据仅发往专用验证接口，不进入 AI 请求 / 聊天历史 / 本地存储）
export async function verifyCardOperation(refNo, { password, totp }) {
  const body = await postJson(`/api/card-operations/${refNo}/verify`, { password, totp })
  return body.data
}

// —— 订阅与代扣操作（查询 + 暂停 / 恢复 / 取消）——

// action: pause / resume / cancel / change_source（更换扣款账户需 to_account_id）
export async function createSubscriptionOperation({ subscription_id, action, to_account_id }) {
  const payload = { subscription_id, action }
  if (to_account_id !== undefined && to_account_id !== null) payload.to_account_id = to_account_id
  const body = await postJson('/api/subscription-operations', payload)
  return body.data
}

export async function fetchSubscriptionOperation(refNo) {
  const body = await request(`/api/subscription-operations/${refNo}`)
  return body.data
}

export async function confirmSubscriptionOperation(refNo) {
  const body = await postJson(`/api/subscription-operations/${refNo}/confirm`, { confirm: true })
  return body.data
}

export async function cancelSubscriptionOperation(refNo) {
  const body = await postJson(`/api/subscription-operations/${refNo}/cancel`, { cancel: true })
  return body.data
}

// 强验证确认恢复（交易密码 + 动态验证码；凭据仅发往专用验证接口，不进入 AI 请求 / 聊天历史 / 本地存储）
export async function verifySubscriptionOperation(refNo, { password, totp }) {
  const body = await postJson(`/api/subscription-operations/${refNo}/verify`, { password, totp })
  return body.data
}

// —— 信用卡（信用账户）与还款（只读查询 + 还款准备 / 强验证）——

// 全部信用账户（含关联卡片、额度汇总与账单列表）
export async function fetchCreditAccounts() {
  const body = await request('/api/credit/accounts')
  return body.data
}

// 单个信用账户（额度汇总 + 账单列表）
export async function fetchCreditAccount(id) {
  const body = await request(`/api/credit/accounts/${id}`)
  return body.data
}

// 某信用账户的账单列表
export async function fetchStatements(creditAccountId) {
  const body = await request(`/api/credit/accounts/${creditAccountId}/statements`)
  return body.data
}

// 账单详情（账单视图 + 本期已入账消费明细 + 还款冲抵明细，可追溯）
export async function fetchStatementDetail(statementId) {
  const body = await request(`/api/credit/statements/${statementId}`)
  return body.data
}

// 创建还款操作单（还款准备，不扣款、不冲抵）。金额由服务端计算：
// scope='statement' 指定已出账账单全额；scope='all_posted' 结清全部已入账欠款（含未出账已入账）。
export async function createRepayment({ statement_id, from_account_id, scope, credit_account_id }) {
  const payload = { from_account_id }
  if (statement_id !== undefined && statement_id !== null) payload.statement_id = statement_id
  if (scope) payload.scope = scope
  if (credit_account_id !== undefined && credit_account_id !== null) payload.credit_account_id = credit_account_id
  const body = await postJson('/api/repayments', payload)
  return body.data
}

// 查看还款操作单（读取时惰性过期）
export async function fetchRepayment(refNo) {
  const body = await request(`/api/repayments/${refNo}`)
  return body.data
}

// 取消还款操作单（不扣款、不冲抵）
export async function cancelRepayment(refNo) {
  const body = await postJson(`/api/repayments/${refNo}/cancel`, { cancel: true })
  return body.data
}

// 强验证确认还款（交易密码 + 动态验证码；凭据仅发往专用验证接口，不进入 AI 请求 / 聊天历史 / 本地存储）
export async function verifyRepayment(refNo, { password, totp }) {
  const body = await postJson(`/api/repayments/${refNo}/verify`, { password, totp })
  return body.data
}

// —— 跨场景任务（当前仅支持「订阅审查」一条任务链）——

export async function fetchRecentAgentTasks() {
  const body = await request('/api/agent-tasks/recent')
  return body.data
}

export async function fetchAgentTask(taskNo) {
  const body = await request(`/api/agent-tasks/${taskNo}`)
  return body.data
}

export async function selectAgentTaskSubscription(taskNo, subscription_id) {
  const body = await postJson(`/api/agent-tasks/${taskNo}/select`, { subscription_id })
  return body.data
}

export async function pauseAgentTask(taskNo) {
  const body = await postJson(`/api/agent-tasks/${taskNo}/pause`, {})
  return body.data
}

export async function resumeAgentTask(taskNo) {
  const body = await postJson(`/api/agent-tasks/${taskNo}/resume`, {})
  return body.data
}

export async function cancelAgentTask(taskNo) {
  const body = await postJson(`/api/agent-tasks/${taskNo}/cancel`, {})
  return body.data
}

export async function manualAgentTask(taskNo) {
  const body = await postJson(`/api/agent-tasks/${taskNo}/manual`, {})
  return body.data
}

// —— 业务活动聚合（转账 / 银行卡 / 订阅 / 跨场景任务的统一只读列表）——

export async function fetchActivity({ type, status, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (type) params.set('type', type)
  if (status) params.set('status', status)
  const body = await request(`/api/activity?${params.toString()}`)
  return { rows: body.data, total: body.meta.total }
}

// —— 受约束 DAG 计划（新版计划任务；与旧「最近任务」列表分开）——

export async function fetchWorkflowPlans(limit = 30) {
  const body = await request(`/api/workflows?limit=${encodeURIComponent(limit)}`)
  return body.data
}

export async function fetchWorkflowPlan(planNo) {
  const body = await request(`/api/workflows/${encodeURIComponent(planNo)}`)
  return body.data
}

export async function createWorkflowPlan({ flow, params, steps = null }) {
  const payload = { flow, params }
  if (steps !== null && steps !== undefined) payload.steps = steps
  const body = await postJson('/api/workflows', payload)
  return body.data
}

export async function selectWorkflowPlan(planNo, params) {
  const body = await postJson(`/api/workflows/${encodeURIComponent(planNo)}/select`, params)
  return body.data
}

export async function workflowPlanAction(planNo, action) {
  const allowed = ['pause', 'resume', 'cancel', 'retry', 'manual']
  if (!allowed.includes(action)) throw new Error('不支持的计划操作')
  const body = await postJson(`/api/workflows/${encodeURIComponent(planNo)}/${action}`, {})
  return body.data
}

export async function modifyWorkflowPlan(planNo, params) {
  const body = await postJson(`/api/workflows/${encodeURIComponent(planNo)}/modify`, { params })
  return body.data
}
