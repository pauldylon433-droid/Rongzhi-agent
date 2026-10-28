// 首页概览「账户余额」口径（与账户列表共用同一份 accounts 数据）：
// - 未选中具体账户、或当前选中的是信用卡：展示全部借记（deposit）账户余额合计；
// - 选中具体借记账户：展示该账户当前余额；
// - 信用卡额度 / 欠款不属于存款余额，任何情况下都不计入。
export function summarizeOverviewBalance(accounts, selectedAccountId = null) {
  const all = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === 'object') : []
  const deposits = all.filter((a) => a.account_type === 'deposit')
  const selected = selectedAccountId === null || selectedAccountId === undefined
    ? null
    : all.find((a) => Number(a.id) === Number(selectedAccountId))

  if (selected && selected.account_type === 'deposit') {
    return {
      mode: 'account',
      label: '账户余额',
      totalCents: Number.isSafeInteger(selected.balance_cents) ? selected.balance_cents : 0,
      currency: selected.currency || 'CNY',
      count: 1,
      subText: `该账户当前余额 · ${selected.currency || 'CNY'} · ${selected.account_name || '未命名账户'}`,
    }
  }

  if (!deposits.length) {
    return {
      mode: 'empty',
      label: '借记账户余额合计',
      totalCents: null,
      currency: null,
      count: 0,
      subText: '暂无借记账户',
    }
  }

  const currencies = [...new Set(deposits.map((a) => a.currency || 'CNY'))]
  if (currencies.length > 1) {
    return {
      mode: 'mixed',
      label: '借记账户余额合计',
      totalCents: null,
      currency: null,
      count: deposits.length,
      subText: `存在 ${currencies.length} 种币种，暂不合并展示`,
    }
  }

  const currency = currencies[0]
  const totalCents = deposits.reduce(
    (sum, a) => sum + (Number.isSafeInteger(a.balance_cents) ? a.balance_cents : 0),
    0,
  )
  const creditNote = selected && selected.account_type === 'credit'
    ? ' · 信用卡额度与欠款不计入'
    : ''
  return {
    mode: 'total',
    label: '借记账户余额合计',
    totalCents,
    currency,
    count: deposits.length,
    subText: `全部借记账户当前余额合计 · ${currency} · ${deposits.length} 个账户${creditNote}`,
  }
}
