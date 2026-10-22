// 账户查询（只读）
export function listAccounts(db, userId) {
  return db
    .prepare(
      `SELECT id, account_name, opening_balance_cents, balance_cents, currency, status, opened_on, created_at
       FROM accounts
       WHERE user_id = ?
       ORDER BY id`,
    )
    .all(userId)
}
