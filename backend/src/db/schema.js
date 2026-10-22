// 六张基础表的建表语句与索引。
// 约定：金额统一使用整数「分」存储，字段以 _cents 结尾。

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL,
  account_name          TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  balance_cents         INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency              TEXT NOT NULL DEFAULT 'CNY',
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  opened_on             TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  account_id    INTEGER NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  category      TEXT NOT NULL,
  merchant      TEXT,
  description   TEXT,
  transaction_at TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'pending')),
  transfer_ref  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  account_id         INTEGER NOT NULL,
  masked_card_number TEXT NOT NULL,
  card_type          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'cancelled')),
  daily_limit_cents  INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit_cents >= 0),
  issued_on          TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  account_id        INTEGER NOT NULL,
  merchant          TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  billing_cycle     TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  next_billing_date TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER,
  operation_type TEXT NOT NULL,
  operation_ref  TEXT,
  action         TEXT NOT NULL,
  result         TEXT,
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id          ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id      ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id   ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_transaction_at ON transactions(transaction_at);
CREATE INDEX IF NOT EXISTS idx_cards_user_id             ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_cards_account_id          ON cards(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id     ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_id  ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing_date ON subscriptions(next_billing_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id        ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS transfer_recipients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  masked_account TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfer_operations (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no                   TEXT NOT NULL UNIQUE,
  user_id                  INTEGER NOT NULL,
  from_account_id          INTEGER NOT NULL,
  from_account_name        TEXT NOT NULL,
  recipient_id             INTEGER NOT NULL,
  recipient_name           TEXT NOT NULL,
  recipient_masked_account TEXT NOT NULL,
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  remark                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_verification','completed','cancelled','expired','failed')),
  risk_level               TEXT NOT NULL CHECK (risk_level IN ('yellow','red')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at               TEXT NOT NULL,
  confirmed_at             TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (from_account_id) REFERENCES accounts(id),
  FOREIGN KEY (recipient_id) REFERENCES transfer_recipients(id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_operations_user_id       ON transfer_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_transfer_operations_status        ON transfer_operations(status);
CREATE INDEX IF NOT EXISTS idx_transfer_operations_confirmed_at  ON transfer_operations(confirmed_at);

-- 强验证：验证器绑定（交易密码哈希 + TOTP 密钥密文）
CREATE TABLE IF NOT EXISTS verification_bindings (
  user_id          INTEGER PRIMARY KEY,
  password_salt    TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  totp_secret_enc  TEXT NOT NULL, -- JSON {iv,tag,data}（AES-256-GCM 认证加密）
  enabled          INTEGER NOT NULL DEFAULT 1,
  bound_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 强验证：已消费的 TOTP 时间步（防重放，跨单/并发/重启均不可复用）
CREATE TABLE IF NOT EXISTS totp_used_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  step        INTEGER NOT NULL,
  purpose     TEXT NOT NULL,
  consumed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, step),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_totp_used_steps_user_id ON totp_used_steps(user_id);

-- 强验证：持久化失败计数与锁定（连续失败 5 次锁定 15 分钟，跨单/重启不失效）
CREATE TABLE IF NOT EXISTS verification_failures (
  user_id      INTEGER PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`

export function createSchema(db) {
  db.transaction(() => {
    db.exec(SCHEMA_SQL)
  })()
}
