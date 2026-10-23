// 银行卡查询（只读，仅返回掩码卡号）。
// 每张卡关联一个账户：借记卡关联活期账户（返回余额），信用卡关联信用账户（返回额度 / 已入账欠款 / 待入账占用 / 可用额度）。
export function listCards(db, userId) {
  const rows = db
    .prepare(
      `SELECT c.id, c.account_id, c.masked_card_number, c.card_type, c.status, c.daily_limit_cents, c.issued_on, c.created_at,
              a.account_name, a.account_type, a.balance_cents, a.status AS account_status
       FROM cards c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.user_id = ?
       ORDER BY c.id`,
    )
    .all(userId)

  return rows.map((c) => {
    const base = {
      id: c.id,
      account_id: c.account_id,
      account_type: c.account_type,
      account_name: c.account_name,
      account_status: c.account_status,
      masked_card_number: c.masked_card_number,
      card_type: c.card_type,
      status: c.status,
      daily_limit_cents: c.daily_limit_cents,
      issued_on: c.issued_on,
      created_at: c.created_at,
    }
    if (c.account_type === 'credit') {
      const ca = db
        .prepare(
          'SELECT id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents FROM credit_accounts WHERE account_id = ? AND user_id = ?',
        )
        .get(c.account_id, userId)
      base.credit_account_id = ca ? ca.id : null
      base.credit_limit_cents = ca ? ca.credit_limit_cents : null
      base.posted_outstanding_cents = ca ? ca.posted_outstanding_cents : null
      base.pending_occupied_cents = ca ? ca.pending_occupied_cents : null
      base.available_credit_cents = ca
        ? ca.credit_limit_cents - ca.posted_outstanding_cents - ca.pending_occupied_cents
        : null
    } else {
      // 借记卡：展示关联活期账户余额（不套用信用语义）
      base.balance_cents = c.balance_cents
    }
    return base
  })
}
