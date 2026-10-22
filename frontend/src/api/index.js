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

// month 为空表示不筛选（全部月份）
export async function fetchTransactions({ month, limit, offset }) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (month) params.set('month', month)
  const body = await request(`/api/transactions?${params.toString()}`)
  return { rows: body.data, total: body.meta.total }
}

// 月度账单分析（month 必填）
export async function fetchMonthlyAnalytics({ month }) {
  const params = new URLSearchParams()
  params.set('month', month)
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
    throw new Error(message)
  }
  return body
}

// 构造助手对话请求体：仅当 sessionId 为非空字符串时才附带，否则省略该字段。
// 避免把 null / undefined / 空字符串序列化成 "null" 等非法值，导致后端 400。
export function buildChatPayload(message, sessionId) {
  const payload = { message }
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    payload.sessionId = sessionId.trim()
  }
  return payload
}

// AI 助手对话：首次仅提交 { message }；后续携带后端返回的 sessionId 追问
export async function chatAssistant({ message, sessionId }) {
  const body = await postJson('/api/assistant/chat', buildChatPayload(message, sessionId))
  return body.data
}

// —— 模拟转账 ——

export async function fetchTransferRecipients() {
  const body = await request('/api/transfers/recipients')
  return body.data
}

export async function createTransfer({ recipient_id, amount_cents, remark }) {
  const body = await postJson('/api/transfers', { recipient_id, amount_cents, remark })
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
