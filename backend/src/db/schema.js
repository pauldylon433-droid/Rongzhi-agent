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
  version            INTEGER NOT NULL DEFAULT 1,
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

-- 银行卡操作单：查询 / 临时冻结（yellow，点击确认）/ 解冻（red，交易密码 + TOTP 强验证）。
-- 保存卡片归属、动作、预期状态与建单时的卡片版本快照，确认时重新校验卡片状态与版本。
CREATE TABLE IF NOT EXISTS card_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no        TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL,
  card_id       INTEGER NOT NULL,
  card_masked   TEXT NOT NULL,
  card_type     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('freeze', 'unfreeze')),
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  card_version  INTEGER NOT NULL,
  risk_level    TEXT NOT NULL CHECK (risk_level IN ('yellow', 'red')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_verification','completed','cancelled','expired','failed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE INDEX IF NOT EXISTS idx_card_operations_user_id ON card_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_card_operations_status  ON card_operations(status);
CREATE INDEX IF NOT EXISTS idx_card_operations_card_id ON card_operations(card_id);

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

-- AI 助手会话（服务端持久化，刷新恢复当前对话）：
-- 保存「模型上下文 + 会话元数据」（part B）。不含 system 消息（每次由服务端按当前时间生成），
-- 不含任何交易密码 / 验证码 / TOTP 密钥 / 模型密钥 / 敏感请求体。
-- messages_json 为 user/assistant/tool 消息数组，完整保留 tool_calls 与 tool 结果配对。
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,           -- 会话 UUID
  user_id             INTEGER NOT NULL,
  messages_json       TEXT NOT NULL DEFAULT '[]', -- 模型上下文（不含 system）
  pending_transfer_ref TEXT,                      -- 本会话当前待确认转账单编号（改单时取消旧单）
  pending_card_op_ref TEXT,                       -- 本会话当前待确认银行卡操作单编号
  created_at          INTEGER NOT NULL,           -- 创建时间（epoch 毫秒）
  last_active_at      INTEGER NOT NULL,           -- 最近活跃时间（epoch 毫秒，用于 TTL）
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_active_at ON chat_sessions(last_active_at);

-- AI 助手「用户可见消息」（part A）：每轮 user 与 assistant 各存一行，含工具展示记录与时间。
-- 不保存原始 tool_calls / tool 消息（那属于模型上下文 part B），也不保存任何验证凭据。
CREATE TABLE IF NOT EXISTS chat_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  user_id           INTEGER NOT NULL,
  seq               INTEGER NOT NULL,             -- 会话内顺序（单调递增）
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text              TEXT NOT NULL,                -- 用户消息文本 / 助手回复文本
  tool_records_json TEXT,                         -- 助手消息的工具执行记录（user 消息为 NULL）
  incomplete        INTEGER NOT NULL DEFAULT 0,   -- 助手回答是否因达到调用/工具上限而未完成
  error             TEXT,                         -- 助手回复失败说明（正常为空）
  created_at        INTEGER NOT NULL,             -- 创建时间（epoch 毫秒）
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);

-- 单用户演示：当前对话指针（「新建对话」服务端切换；刷新按此指针恢复当前对话）
CREATE TABLE IF NOT EXISTS chat_state (
  user_id            INTEGER PRIMARY KEY,
  current_session_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`

export function createSchema(db) {
  db.transaction(() => {
    db.exec(SCHEMA_SQL)
  })()
}
