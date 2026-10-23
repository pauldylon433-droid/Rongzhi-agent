// 账户查询（只读）。account_type 区分 deposit（活期）/ credit（信用），信用账户 balance_cents 恒为 0，
// 其额度与债务在 credit_accounts 单独维护，不得以 balance_cents=0 冒充现金余额。
export function listAccounts(db, userId) {
  return db
    .prepare(
      `SELECT id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at
       FROM accounts
       WHERE user_id = ?
       ORDER BY id`,
    )
    .all(userId)
}
