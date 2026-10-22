// 订阅与代扣查询（只读）
export function listSubscriptions(db, userId) {
  return db
    .prepare(
      `SELECT id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, created_at
       FROM subscriptions
       WHERE user_id = ?
       ORDER BY id`,
    )
    .all(userId)
}
