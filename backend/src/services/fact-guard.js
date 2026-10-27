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

// —— 结构化回复块：业务事实只从本轮工具结果 / 数据库事实生成，模型草稿不作为事实来源 ——
const MONEY_RE = /(?:(?:¥|￥|\bCNY\b|\bRMB\b)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:元|CNY|RMB|¥|￥|\byuan\b))/gi
const REF_RE = /(?:流水编号|流水号|交易编号|操作编号|凭证号|单号|ref[_-]?no|transaction[_-]?id)\s*[:：=]?\s*([A-Za-z0-9_-]{4,})/gi
const PENDING_WORDS = /(待确认|尚未扣款|未扣款|待验证|待强验证|需要强验证|等待确认|待处理|尚未核验|未核验|处理中|pending|awaiting|processing)/i
const CANCELLED_WORDS = /(已取消|取消成功|cancell?ed)/i
const FAILED_WORDS = /(失败|已失效|操作失败|failed|expired)/i
const PAUSED_WORDS = /(已暂停|暂停成功|paused)/i
const FROZEN_WORDS = /(已冻结|冻结成功|frozen)/i
const ACTIVE_WORDS = /(已解冻|解冻成功|已恢复|恢复成功|unfrozen|reactivated)/i
const SUCCESS_WORDS = /(已完成|已成功|办理成功|操作成功|交易成功|已扣款|已转账|转账成功|已到账|已入账|已还款|还款成功|已支付|已转出|已办妥|成功完成|completed|successful|succeeded|\bdone\b|\btransferred\b|\bpaid\b|\bcredited\b|\bsettled\b)/i

function fmtCents(cents) {
  const n = Number(cents)
  return Number.isFinite(n) ? `${(n / 100).toFixed(2)} 元` : '金额未知'
}
function cell(v) {
  if (v === null || v === undefined || v === '') return '—'
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
function mdTable(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
}
function walkFields(v, fn, key = '') {
  if (Array.isArray(v)) { for (const x of v) walkFields(x, fn, key); return }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walkFields(x, fn, k); return }
  fn(v, key)
}
function extractAmounts(text) {
  const out = new Set()
  const re = new RegExp(MONEY_RE.source, 'gi')
  let m
  while ((m = re.exec(String(text || '')))) {
    const raw = (m[1] || m[2] || '').replace(/,/g, '')
    const n = Number(raw)
    if (Number.isFinite(n)) out.add(Math.round(n * 100))
  }
  return out
}
function extractRefs(text) {
  const out = new Set()
  const re = new RegExp(REF_RE.source, 'gi')
  let m
  while ((m = re.exec(String(text || '')))) out.add(m[1])
  return out
}
function statusClaimTypes(text) {
  const s = String(text || '')
  const out = []
  if (PENDING_WORDS.test(s)) out.push('pending')
  if (CANCELLED_WORDS.test(s)) out.push('cancelled')
  if (FAILED_WORDS.test(s)) out.push('failed')
  if (PAUSED_WORDS.test(s)) out.push('paused')
  if (FROZEN_WORDS.test(s)) out.push('frozen')
  if (ACTIVE_WORDS.test(s)) out.push('active')
  if (SUCCESS_WORDS.test(s)) out.push('success')
  return out
}
function statusMatches(type, statuses) {
  const set = statuses instanceof Set ? statuses : new Set(statuses || [])
  if (type === 'pending') return ['pending', 'needs_verification', 'waiting_confirmation', 'waiting_verification', 'paused'].some((s) => set.has(s))
  if (type === 'cancelled') return set.has('cancelled')
  if (type === 'failed') return set.has('failed') || set.has('expired')
  if (type === 'paused') return set.has('paused') || set.has('completed')
  if (type === 'frozen') return set.has('frozen') || set.has('completed')
  if (type === 'active') return set.has('active') || set.has('completed')
  if (type === 'success') return set.has('completed')
  return false
}
function collectBlockAmounts(blocks) {
  const out = new Set()
  for (const b of blocks) {
    if (b.authoritative === false) continue
    walkFields(b.fields, (v, k) => {
      if (/_cents$/.test(k) && Number.isFinite(Number(v))) out.add(Math.round(Number(v)))
    })
  }
  return out
}
function collectBlockStatuses(blocks) {
  const out = new Set()
  for (const b of blocks) {
    walkFields(b.fields, (v, k) => {
      if (['status', 'op_status', 'account_status', 'card_status'].includes(k) && typeof v === 'string') out.add(v)
    })
  }
  return out
}
function collectBlockRefs(blocks) {
  const out = new Set()
  for (const b of blocks) {
    walkFields(b.fields, (v, k) => {
      if (['ref_no', 'transaction_id', 'op_ref'].includes(k) && v != null && v !== '') out.add(String(v))
    })
  }
  return out
}
function lineHasFact(line) {
  return isBusinessClaim(line) || extractAmounts(line).size > 0 || extractRefs(line).size > 0
    || statusClaimTypes(line).length > 0
}
// 删除未核验的业务行 / 整张 Markdown 表格；普通解释与澄清问题保留。
function sanitizeBusinessText(text) {
  const lines = String(text || '').split(/\r?\n/)
  const kept = []
  const removed = []
  for (let i = 0; i < lines.length;) {
    if (/^\s*\|/.test(lines[i])) {
      let j = i
      while (j < lines.length && /^\s*\|/.test(lines[j])) j += 1
      const group = lines.slice(i, j)
      if (group.some(lineHasFact)) removed.push(...group)
      else kept.push(...group)
      i = j
      continue
    }
    if (lineHasFact(lines[i])) removed.push(lines[i])
    else kept.push(lines[i])
    i += 1
  }
  return { kept: kept.map((l) => l.trim()).filter(Boolean).join('\n'), removed }
}

const LIST_STATUS_TEXT = {
  active: '正常', paused: '暂停', cancelled: '已取消', frozen: '冻结', expired: '已过期',
  open: '未结清', paid: '已结清', unissued: '未出账', issued: '已出账', failed: '失败',
}

function sourceLine(tool, callId, extra = '') {
  const parts = [`来源：${tool}`]
  if (callId) parts.push(`call_id=${callId}`)
  if (extra) parts.push(extra)
  return parts.join(' · ')
}
function accountsBlock(rec, callId) {
  const data = Array.isArray(rec.data) ? rec.data : []
  if (!data.length) return null
  const rows = data.map((a) => [a.account_name, fmtCents(a.balance_cents), a.currency || 'CNY',
    a.account_type === 'credit' ? '信用账户' : '活期账户', LIST_STATUS_TEXT[a.status] || a.status])
  return {
    kind: 'accounts', authoritative: true, source: { tool: 'get_accounts', call_id: callId },
    fields: { items: data.map((a) => ({ account_id: a.id, account_name: a.account_name, balance_cents: a.balance_cents,
      currency: a.currency, account_type: a.account_type, status: a.status })), account_ids: data.map((a) => a.id) },
    text: `**账户信息（服务端核验）**\n\n${mdTable(['账户', '余额', '币种', '类型', '状态'], rows)}\n\n${sourceLine('get_accounts', callId, `account_ids=${data.map((a) => a.id).join(',')}`)}`,
  }
}
function analyticsBlock(rec, callId) {
  const d = rec.data || {}
  const rows = [
    ['收入', `+${fmtCents(d.income_cents)}`],
    ['支出', `-${fmtCents(d.expense_cents)}`],
    ['净收支', `${Number(d.net_cents) >= 0 ? '+' : ''}${fmtCents(d.net_cents)}`],
    ['已入账笔数', `${d.posted_count ?? 0} 笔`],
    ['待入账', `${d.pending?.count ?? 0} 笔 / ${fmtCents(d.pending?.amount_cents ?? 0)}`],
    ['信用卡还款（内部冲账）', fmtCents(d.repayment_cents ?? 0)],
  ]
  if (Array.isArray(d.expense_by_category) && d.expense_by_category.length) {
    rows.push(['支出分类', d.expense_by_category.map((c) => `${c.category} ${fmtCents(c.amount_cents)}（${c.count} 笔）`).join('；')])
  }
  return {
    kind: 'analytics', authoritative: true, source: { tool: 'get_monthly_analytics', call_id: callId },
    fields: { month: d.month, account_id: rec.args?.account_id ?? null, income_cents: d.income_cents,
      expense_cents: d.expense_cents, net_cents: d.net_cents, repayment_cents: d.repayment_cents,
      posted_count: d.posted_count, pending: d.pending, as_of: d.as_of },
    text: `**${d.month || '本月'} 账单统计（服务端核验）**\n\n${mdTable(['项目', '数值'], rows)}\n\n${sourceLine('get_monthly_analytics', callId, `month=${d.month || '—'}${rec.args?.account_id ? ` · account_id=${rec.args.account_id}` : ''}`)}`,
  }
}
function subscriptionsBlock(rec, callId) {
  const data = Array.isArray(rec.data) ? rec.data : []
  if (!data.length) return null
  const rows = data.map((s) => [s.merchant, fmtCents(s.amount_cents), s.billing_cycle || '—',
    LIST_STATUS_TEXT[s.status] || s.status, s.account_name || '未设置', s.masked_card_number || '—'])
  return {
    kind: 'subscriptions', authoritative: true, source: { tool: 'get_subscriptions', call_id: callId },
    fields: { items: data.map((s) => ({ subscription_id: s.id, merchant: s.merchant, amount_cents: s.amount_cents,
      billing_cycle: s.billing_cycle, status: s.status, account_id: s.account_id })) },
    text: `**订阅与代扣（服务端核验）**\n\n${mdTable(['商户', '每期金额', '周期', '状态', '扣款来源', '卡号'], rows)}\n\n${sourceLine('get_subscriptions', callId)}`,
  }
}
function cardsBlock(rec, callId) {
  const data = Array.isArray(rec.data) ? rec.data : []
  if (!data.length) return null
  const rows = data.map((c) => [c.masked_card_number, c.card_type, LIST_STATUS_TEXT[c.status] || c.status,
    c.account_type === 'credit' ? `可用额度 ${fmtCents(c.available_credit_cents)}` : `余额 ${fmtCents(c.balance_cents)}`,
    c.account_name])
  return {
    kind: 'cards', authoritative: true, source: { tool: 'get_cards', call_id: callId },
    fields: { items: data.map((c) => ({ card_id: c.id, masked_card_number: c.masked_card_number, card_type: c.card_type,
      status: c.status, account_type: c.account_type, balance_cents: c.balance_cents,
      available_credit_cents: c.available_credit_cents })) },
    text: `**银行卡（服务端核验）**\n\n${mdTable(['卡号', '类型', '状态', '余额 / 可用额度', '关联账户'], rows)}\n\n${sourceLine('get_cards', callId)}`,
  }
}
function creditBlock(rec, callId) {
  const data = Array.isArray(rec.data) ? rec.data : (rec.data ? [rec.data] : [])
  if (!data.length) return null
  const rows = data.map((c) => [c.account_name, fmtCents(c.credit_limit_cents), fmtCents(c.posted_outstanding_cents),
    fmtCents(c.available_credit_cents), fmtCents(c.repayable_total_cents)])
  return {
    kind: 'credit_accounts', authoritative: true, source: { tool: 'get_credit_accounts', call_id: callId },
    fields: { items: data.map((c) => ({ credit_account_id: c.id, account_name: c.account_name,
      credit_limit_cents: c.credit_limit_cents, posted_outstanding_cents: c.posted_outstanding_cents,
      pending_occupied_cents: c.pending_occupied_cents, available_credit_cents: c.available_credit_cents,
      repayable_total_cents: c.repayable_total_cents, account_status: c.account_status,
      card_status: c.card?.status })) },
    text: `**信用卡额度与欠款（服务端核验）**\n\n${mdTable(['账户', '额度', '已入账欠款', '可用额度', '可还款总额'], rows)}\n\n${sourceLine('get_credit_accounts', callId)}`,
  }
}
function statementBlock(rec, callId) {
  const d = rec.data || {}
  const s = d.statement || d
  if (!s || s.id == null) return null
  const rows = [
    ['账单', `${s.statement_month || '—'}${s.issued ? '（已出账）' : '（未出账）'}`],
    ['剩余应还', fmtCents(s.remaining_due_cents)],
    ['本期消费', fmtCents(s.new_charges_cents)],
    ['已还', fmtCents(s.paid_cents)],
    ['状态', LIST_STATUS_TEXT[s.status] || s.status || '—'],
  ]
  return {
    kind: 'statement', authoritative: true, source: { tool: 'get_statement', call_id: callId },
    fields: { statement_id: s.id, statement_month: s.statement_month, issued: s.issued, remaining_due_cents: s.remaining_due_cents,
      new_charges_cents: s.new_charges_cents, paid_cents: s.paid_cents, status: s.status },
    text: `**账单详情（服务端核验）**\n\n${mdTable(['项目', '内容'], rows)}\n\n${sourceLine('get_statement', callId, `statement_id=${s.id}`)}`,
  }
}
function operationBlock(rec, callId, kind, factByRef) {
  const d = rec.data || {}
  const f = d.ref_no ? factByRef.get(String(d.ref_no)) : null
  const status = f?.status || d.status
  const amountCents = f?.amount_cents ?? d.amount_cents
  const fact = { kind, ref_no: d.ref_no, status, amount_cents: amountCents,
    transaction_id: f?.transaction_id ?? d.transaction_id, action: d.action,
    statement_month: d.statement_month || f?.statement_month, card_masked: d.masked_card_number || f?.card_masked,
    merchant: d.merchant || f?.merchant }
  const head = receiptForFact(fact)
  let rows
  if (kind === 'transfer') {
    rows = [['操作编号', d.ref_no], ['状态', STATUS_TEXT[status] || status], ['金额', fmtCents(amountCents)],
      ['收款人', d.recipient_name], ['付款账户', d.from_account_name], ['风险等级', d.risk_level],
      ['备注', d.remark], ['到期时间', d.expires_at]]
    if (fact.transaction_id) rows.push(['流水编号', fact.transaction_id])
  } else if (kind === 'card') {
    rows = [['操作编号', d.ref_no], ['状态', STATUS_TEXT[status] || status], ['操作', ACTION_TEXT[d.action] || d.action],
      ['银行卡', d.masked_card_number], ['风险等级', d.risk_level], ['到期时间', d.expires_at]]
  } else if (kind === 'subscription') {
    rows = [['操作编号', d.ref_no], ['状态', STATUS_TEXT[status] || status], ['操作', ACTION_TEXT[d.action] || d.action],
      ['订阅商户', d.merchant], ['每期金额', fmtCents(amountCents)], ['原扣款来源', d.from_account_name || d.from_masked_card],
      ['新扣款来源', d.to_account_name || d.to_masked_card], ['风险等级', d.risk_level]]
  } else {
    rows = [['操作编号', d.ref_no], ['状态', STATUS_TEXT[status] || status], ['还款范围', d.scope === 'all_posted' ? '结清全部已入账欠款' : '指定账单'],
      ['账期', d.statement_month], ['金额', fmtCents(amountCents)], ['付款账户', d.from_account_name],
      ['信用卡', d.credit_account_name], ['风险等级', d.risk_level]]
  }
  const title = { transfer: '转账操作单', card: '银行卡操作单', subscription: '订阅操作单', repayment: '信用卡还款单' }[kind]
  return {
    kind: `operation_${kind}`, authoritative: true,
    source: { tool: rec.name, call_id: callId, ref_no: d.ref_no || null },
    fields: { ref_no: d.ref_no, status, amount_cents: amountCents, action: d.action, transaction_id: fact.transaction_id,
      statement_month: d.statement_month, recipient_name: d.recipient_name, merchant: d.merchant },
    text: `${head}\n\n**${title}（服务端核验）**\n\n${mdTable(['项目', '内容'], rows)}\n\n${sourceLine(rec.name, callId, d.ref_no ? `ref_no=${d.ref_no}` : '')}`,
  }
}
function factBlock(f) {
  if (!f || !f.kind || !f.ref_no) return null
  const recName = { transfer: 'transfer', card: 'card_operation', subscription: 'subscription_operation', repayment: 'repayment' }[f.kind]
  return operationBlock({ name: recName, data: { ref_no: f.ref_no, status: f.status, amount_cents: f.amount_cents,
    action: f.action, transaction_id: f.transaction_id, statement_month: f.statement_month,
    masked_card_number: f.card_masked, merchant: f.merchant } }, null, f.kind, new Map([[String(f.ref_no), f]]))
}
function recipientsBlock(rec, callId) {
  const data = Array.isArray(rec.data) ? rec.data : []
  if (!data.length) return null
  const rows = data.map((r) => [r.name, r.masked_account])
  return {
    kind: 'recipients', authoritative: true, source: { tool: rec.name, call_id: callId },
    fields: { items: data.map((r) => ({ recipient_id: r.id, name: r.name, masked_account: r.masked_account })) },
    text: `**收款人（服务端核验）**\n\n${mdTable(['姓名', '账户'], rows)}\n\n${sourceLine(rec.name, callId)}`,
  }
}
function analysisBlock(rec, callId) {
  return {
    kind: 'sandbox_analysis', authoritative: false, source: { tool: rec.name, call_id: callId },
    fields: { analysis: rec.data?.analysis ?? null },
    text: `**沙箱辅助分析（非银行事实，不作为余额 / 交易 / 执行结果依据）**\n\n来源：${rec.name}${callId ? ` · call_id=${callId}` : ''}`,
  }
}

export function buildReplyBlocks({ toolRecords = [], facts = [] } = {}) {
  const factByRef = new Map(facts.filter((f) => f && f.ref_no).map((f) => [String(f.ref_no), f]))
  const blocks = []
  const index = new Map()
  const upsert = (key, block) => {
    if (!block) return
    if (index.has(key)) blocks[index.get(key)] = block
    else { index.set(key, blocks.length); blocks.push(block) }
  }
  for (const rec of toolRecords) {
    if (!rec || rec.status !== 'ok' || rec.data == null) continue
    const callId = rec.call_id || rec.tool_call_id || null
    const name = rec.name
    if (name === 'get_accounts') upsert(`accounts:${callId || blocks.length}`, accountsBlock(rec, callId))
    else if (name === 'get_monthly_analytics') upsert(`analytics:${rec.data?.month}:${rec.args?.account_id ?? 'all'}:${callId || blocks.length}`, analyticsBlock(rec, callId))
    else if (name === 'get_subscriptions') upsert(`subscriptions:${callId || blocks.length}`, subscriptionsBlock(rec, callId))
    else if (name === 'get_cards') upsert(`cards:${callId || blocks.length}`, cardsBlock(rec, callId))
    else if (name === 'get_credit_accounts') upsert(`credit:${callId || blocks.length}`, creditBlock(rec, callId))
    else if (name === 'get_statement') upsert(`statement:${rec.data?.statement?.id ?? rec.data?.id}:${callId || blocks.length}`, statementBlock(rec, callId))
    else if (name === 'prepare_transfer') upsert(`op:transfer:${rec.data?.ref_no}`, operationBlock(rec, callId, 'transfer', factByRef))
    else if (name === 'prepare_card_operation') upsert(`op:card:${rec.data?.ref_no}`, operationBlock(rec, callId, 'card', factByRef))
    else if (name === 'prepare_subscription_operation') upsert(`op:subscription:${rec.data?.ref_no}`, operationBlock(rec, callId, 'subscription', factByRef))
    else if (name === 'prepare_repayment') upsert(`op:repayment:${rec.data?.ref_no}`, operationBlock(rec, callId, 'repayment', factByRef))
    else if (name === 'get_transfer_status') upsert(`op:transfer:${rec.data?.ref_no}`, operationBlock(rec, callId, 'transfer', factByRef))
    else if (name === 'get_card_operation_status') upsert(`op:card:${rec.data?.ref_no}`, operationBlock(rec, callId, 'card', factByRef))
    else if (name === 'get_subscription_operation_status') upsert(`op:subscription:${rec.data?.ref_no}`, operationBlock(rec, callId, 'subscription', factByRef))
    else if (name === 'get_repayment_status') upsert(`op:repayment:${rec.data?.ref_no}`, operationBlock(rec, callId, 'repayment', factByRef))
    else if (name === 'list_transfer_recipients' || name === 'search_transfer_recipients') upsert(`recipients:${callId || blocks.length}`, recipientsBlock(rec, callId))
    else if (name === 'analyze_transactions_sandboxed') upsert(`analysis:${callId || blocks.length}`, analysisBlock(rec, callId))
  }
  for (const f of facts) {
    if (!f || !f.ref_no) continue
    const key = `op:${f.kind}:${f.ref_no}`
    if (index.has(key)) continue
    upsert(key, factBlock(f))
  }
  // 操作单 / 状态回执优先展示，其次账户 / 账单 / 列表；保证回复首行是当前业务的权威回执。
  const priority = { operation_transfer: 100, operation_repayment: 100, operation_card: 100, operation_subscription: 100,
    accounts: 80, analytics: 70, credit_accounts: 60, statement: 60, subscriptions: 50, cards: 50,
    recipients: 10, sandbox_analysis: 1 }
  return blocks.sort((a, b) => (priority[b.kind] ?? 30) - (priority[a.kind] ?? 30))
}

// 用服务端块核验回复中的金额 / 编号 / 状态；全部有来源则保留原文，否则用服务端块替换。
export function renderVerifiedReply(reply, options = {}) {
  const { blocks = [], queryFailed = false, authoritative = false } = options
  const text = String(reply || '')
  if (authoritative) {
    return { reply: text, changed: false, reason: 'authoritative_status', blocks, removed: [], conflicts: [] }
  }
  const amounts = extractAmounts(text)
  const refs = extractRefs(text)
  const claims = statusClaimTypes(text)
  const blockAmounts = collectBlockAmounts(blocks)
  const blockStatuses = collectBlockStatuses(blocks)
  const blockRefs = collectBlockRefs(blocks)
  const conflicts = []
  for (const a of amounts) if (!blockAmounts.has(a)) conflicts.push(`金额 ${fmtCents(a)} 无服务端来源`)
  for (const r of refs) if (!blockRefs.has(r)) conflicts.push(`编号 ${r} 无服务端记录`)
  for (const c of claims) if (!statusMatches(c, blockStatuses)) conflicts.push(`状态 ${c} 与服务端不一致`)
  const sanitized = sanitizeBusinessText(text)
  // 即使金额 / 状态恰好与服务端一致，也不直接展示模型草稿中的业务事实；
  // 业务事实统一由服务端块渲染，模型文本只保留不含事实的解释 / 澄清。
  if (!sanitized.removed.length) {
    return { reply: text, changed: false, reason: blocks.length ? 'verified_blocks_available' : 'no_business_claim', blocks, removed: [], conflicts }
  }
  if (blocks.length) {
    const out = [sanitized.kept, ...blocks.map((b) => b.text)].filter(Boolean).join('\n\n')
    return { reply: out, changed: out !== text, reason: 'replaced_with_verified_blocks', blocks, removed: sanitized.removed, conflicts }
  }
  const note = queryFailed ? QUERY_FAILED_NOTE : NO_FACT_NOTE
  const out = [sanitized.kept, note].filter(Boolean).join('\n')
  return {
    reply: out || note,
    changed: out !== text,
    reason: queryFailed ? 'unsupported_claim_query_failed' : 'unsupported_claim_no_fact',
    blocks, removed: sanitized.removed, conflicts,
  }
}

// 将模型回答中的业务声明行替换为服务端权威回执；无关的查询 / 解释行保留。
// options.blocks 存在时走结构化块核验（金额 / 编号 / 状态必须能在服务端块中找到来源）。
export function applyFactGuard(reply, facts = [], options = {}) {
  if (Array.isArray(options.blocks)) {
    const r = renderVerifiedReply(reply, options)
    return { ...r, facts }
  }
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
