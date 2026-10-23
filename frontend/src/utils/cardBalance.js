// 银行卡 / 账户字段的兼容解析（纯函数，便于用 Node 直接验证）。
//
// 背景：新后端 /api/cards 返回增强字段（account_type / account_name / account_status / balance_cents），
// 旧后端只返回 id / account_id / masked_card_number / card_type / status / daily_limit_cents。
// 这里统一「卡片余额来自关联账户」的取值规则：
//   1) 卡片接口有合法的 balance_cents → 直接使用（明确契约，不重复计算）；
//   2) 否则按真实 account_id 关联账户接口的 balance_cents；
//   3) 仍不可用 → 返回不可用（界面显示「暂无法获取」），绝不回退为 0 / 信用额度 / 第一个账户。

export function isFiniteCents(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

// 账户列表 → Map<account_id, account>（只接受整数 id，不做下标 / 名称匹配）
export function accountsIndex(accounts) {
  const map = new Map()
  for (const acc of Array.isArray(accounts) ? accounts : []) {
    if (acc && Number.isInteger(acc.id)) map.set(acc.id, acc)
  }
  return map
}

// 借记卡余额：返回 { available, cents }
export function resolveDebitBalance(card, accountsById) {
  if (card && isFiniteCents(card.balance_cents)) return { available: true, cents: card.balance_cents }
  const acc = card && accountsById instanceof Map ? accountsById.get(card.account_id) : null
  if (acc && isFiniteCents(acc.balance_cents)) return { available: true, cents: acc.balance_cents }
  return { available: false, cents: null }
}

// 关联账户名：卡片接口 → 账户接口 → 空串（界面显示「暂无法获取」）
export function resolveAccountName(card, accountsById) {
  if (card && typeof card.account_name === 'string' && card.account_name) return card.account_name
  const acc = card && accountsById instanceof Map ? accountsById.get(card.account_id) : null
  return acc && typeof acc.account_name === 'string' ? acc.account_name : ''
}

// 是否为借记（存款）卡：
// - 新接口有 account_type 时严格按字段判断；
// - 旧接口缺失 account_type 时，仅接受明确的 card_type === '借记卡'，不猜测账户类型。
export function isDepositCard(card) {
  if (!card) return false
  if (card.account_type === 'credit') return false
  if (card.account_type === 'deposit') return true
  return card.card_type === '借记卡'
}

// 是否可作为对外付款账户：借记卡 + 卡片 active +（账户状态：新接口字段或按 account_id 关联的账户）active。
export function isActivePayerCard(card, accountsById) {
  if (!isDepositCard(card)) return false
  if (card.status !== 'active') return false
  if (card.account_status === 'active') return true
  if (card.account_status === 'frozen' || card.account_status === 'closed') return false
  const acc = card && accountsById instanceof Map ? accountsById.get(card.account_id) : null
  return !!acc && acc.status === 'active'
}
