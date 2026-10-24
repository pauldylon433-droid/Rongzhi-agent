// 订阅与代扣查询（只读）：附带扣款来源（账户 + 该账户下的银行卡，按 account_id 关联，不做名称猜测）。
// 账户 / 卡片缺失时对应字段为 null，前端显示「未设置扣款账户」，不回退到第一张卡。
export function listSubscriptions(db, userId) {
  return db
    .prepare(
      `SELECT s.id, s.account_id, s.merchant, s.amount_cents, s.billing_cycle, s.next_billing_date, s.status, s.created_at,
              a.account_name, a.account_type, a.currency, a.status AS account_status,
              (SELECT c.masked_card_number FROM cards c
                WHERE c.account_id = s.account_id AND c.user_id = s.user_id AND c.status != 'cancelled'
                ORDER BY c.id LIMIT 1) AS masked_card_number,
              (SELECT c.card_type FROM cards c
                WHERE c.account_id = s.account_id AND c.user_id = s.user_id AND c.status != 'cancelled'
                ORDER BY c.id LIMIT 1) AS card_type,
              (SELECT c.status FROM cards c
                WHERE c.account_id = s.account_id AND c.user_id = s.user_id AND c.status != 'cancelled'
                ORDER BY c.id LIMIT 1) AS card_status
       FROM subscriptions s
       LEFT JOIN accounts a ON a.id = s.account_id AND a.user_id = s.user_id
       WHERE s.user_id = ?
       ORDER BY s.id`,
    )
    .all(userId)
}
