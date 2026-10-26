// 事实保护：以服务端操作单 / 流水为唯一事实来源，对模型最终回答做安全渲染。
// 文本检测只用于识别「业务执行声明」（成功 / 待确认 / 流水号），不用于证明事实；
// 任何声明都必须映射到本轮或会话历史明确引用的操作单，否则拒绝确定性成功文案。
// 同一状态下模型声称的金额 / 流水号与权威事实冲突时，整行由结构化回执替换。
const SUCCESS_CLAIM = /(已扣款|已转账|转账成功|还款成功|已还款|已冻结|已解冻|已暂停|已恢复|已取消|转账已完成|还款已完成|冻结操作已完成|解冻操作已完成|暂停操作已完成|恢复操作已完成|已完成扣款|已执行|扣款成功|操作成功|交易成功)/i
const PENDING_CLAIM = /(待确认|尚未扣款|未扣款|待验证|待强验证|需要强验证|尚未执行|待处理)/i
const REF_CLAIM = /(流水编号|流水号|交易编号|ref[_-]?no|FAKE|transaction[_-]?id)/i

export function isBusinessClaim(line) {
  const s = String(line || '')
  return SUCCESS_CLAIM.test(s) || PENDING_CLAIM.test(s) || REF_CLAIM.test(s)
}

const STATUS_TEXT = {
  pending: '待确认（尚未扣款）',
  needs_verification: '需要强验证（尚未扣款）',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  failed: '已失效',
}
const ACTION_TEXT = { freeze: '冻结', unfreeze: '解冻', pause: '暂停', resume: '恢复', cancel: '取消', change_source: '更换扣款账户' }

function yuan(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '金额未知'
  return `${(n / 100).toFixed(2)} 元`
}

export function receiptForFact(f) {
  if (!f) return ''
  if (f.kind === 'transfer') {
    if (f.status === 'completed') return `该笔转账已完成，金额 ${yuan(f.amount_cents)}，流水编号 ${f.transaction_id ?? '未知'}。`
    return `该笔转账${STATUS_TEXT[f.status] || f.status}。`
  }
  if (f.kind === 'repayment') {
    if (f.status === 'completed') return `该笔信用卡还款已完成，金额 ${yuan(f.amount_cents)}，账期 ${f.statement_month || '未知'}。`
    return `该笔信用卡还款${STATUS_TEXT[f.status] || f.status}。`
  }
  if (f.kind === 'card') {
    const act = ACTION_TEXT[f.action] || '银行卡操作'
    return `该银行卡${act}操作${STATUS_TEXT[f.status] || f.status}。`
  }
  if (f.kind === 'subscription') {
    const act = ACTION_TEXT[f.action] || '订阅操作'
    return `该订阅${act}操作${STATUS_TEXT[f.status] || f.status}。`
  }
  return ''
}

// 声称金额 / 流水号与权威事实的显式冲突（仅检查含业务声明的行，避免误伤解释性文字）。
export function findFactConflicts(reply, facts = []) {
  const amounts = facts.map((f) => f.amount_cents).filter((n) => Number.isFinite(n))
  const refs = new Set(facts.flatMap((f) => [f.ref_no, f.transaction_id]).filter(Boolean).map(String))
  const conflicts = []
  for (const line of String(reply || '').split(/\r?\n/)) {
    if (!isBusinessClaim(line)) continue
    for (const m of line.matchAll(/(\d+(?:\.\d{1,2})?)\s*元/g)) {
      const cents = Math.round(Number(m[1]) * 100)
      if (amounts.length && !amounts.includes(cents)) conflicts.push(`金额 ${m[1]} 元与操作单不一致`)
    }
    for (const m of line.matchAll(/(?:流水编号|流水号|交易编号|transaction[_ ]?id)\s*[:：=]?\s*([A-Za-z0-9_-]{4,})/gi)) {
      if (!refs.has(m[1])) conflicts.push(`流水编号 ${m[1]} 无对应服务端记录`)
    }
  }
  return conflicts
}

const NO_FACT_NOTE = '我无法依据当前服务端数据确认该操作已成功或已扣款；未生成、未确认或查询失败的操作不会被视为完成。请先查询对应操作单的最新状态。'
const QUERY_FAILED_NOTE = '服务端查询失败或未返回操作单，因此该操作是否成功尚未核验；未核验的结果不会被视为已完成。请稍后重试查询。'

// 将模型回答中的业务声明行替换为服务端权威回执；无关的查询 / 解释行保留。
export function applyFactGuard(reply, facts = [], options = {}) {
  const text = String(reply || '')
  const lines = text.split(/\r?\n/)
  const claimLines = lines.filter((l) => isBusinessClaim(l))
  if (!claimLines.length) return { reply: text, changed: false, reason: 'no_business_claim', facts }
  const receipts = [...new Set(facts.map(receiptForFact).filter(Boolean))]
  const conflicts = findFactConflicts(text, facts)
  const kept = lines.filter((l) => !isBusinessClaim(l)).map((l) => l.trim()).filter(Boolean)
  if (!receipts.length) {
    const note = options.queryFailed ? QUERY_FAILED_NOTE : NO_FACT_NOTE
    const out = [...kept, note].join('\n')
    return {
      reply: out || note,
      changed: out !== text,
      reason: options.queryFailed ? 'unsupported_claim_query_failed' : 'unsupported_claim_no_fact',
      conflicts,
      facts,
    }
  }
  const out = [...kept, ...receipts].join('\n')
  return {
    reply: out || receipts.join('\n'),
    changed: out !== text,
    reason: conflicts.length ? 'claim_fact_conflict' : 'replaced_with_authoritative_receipt',
    conflicts,
    facts,
  }
}

export function refsFromToolRecords(toolRecords = []) {
  const refs = new Set()
  for (const t of toolRecords) {
    const d = t && t.data
    if (!d || typeof d !== 'object') continue
    for (const k of ['ref_no', 'transaction_id', 'op_ref']) if (d[k] != null) refs.add(String(d[k]))
  }
  return refs
}

export function refsFromMessages(messages = []) {
  const refs = new Set()
  for (const m of messages) {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue
    let obj
    try { obj = JSON.parse(m.content) } catch { continue }
    const walk = (v, depth = 0) => {
      if (!v || depth > 4) return
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
      if (typeof v !== 'object') return
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'ref_no' || k === 'op_ref') && typeof x === 'string') refs.add(x)
        else walk(x, depth + 1)
      }
    }
    walk(obj)
  }
  return refs
}
