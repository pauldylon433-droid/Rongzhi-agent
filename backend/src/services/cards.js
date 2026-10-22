// 银行卡查询（只读，仅返回掩码卡号）
export function listCards(db, userId) {
  return db
    .prepare(
      `SELECT id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at
       FROM cards
       WHERE user_id = ?
       ORDER BY id`,
    )
    .all(userId)
}
