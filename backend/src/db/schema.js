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
  account_type          TEXT NOT NULL DEFAULT 'deposit' CHECK (account_type IN ('deposit', 'credit')),
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
  posted_at     TEXT,                                    -- 入账时间（信用卡消费 pending→posted 时写入；非信用卡流水为 NULL）
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'pending')),
  transfer_ref  TEXT,
  flow_kind     TEXT NOT NULL DEFAULT 'external' CHECK (flow_kind IN ('external', 'repayment')),
  repayment_ref TEXT,
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
  version           INTEGER NOT NULL DEFAULT 1,
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

-- 结构化审计时间线：请求 / 会话 / 计划 / 工具 / 操作单 / 回执关联编号。
-- 不含密码、验证码、TOTP 种子或 API Key；安全失败事件独立提交。
CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  user_id        INTEGER,
  request_id     TEXT,
  session_id     TEXT,
  plan_id        TEXT,
  tool_call_id   TEXT,
  operation_ref  TEXT,
  category       TEXT NOT NULL,
  action         TEXT NOT NULL,
  result         TEXT,
  risk_level     TEXT,
  detail_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_events_request_id  ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_session_id  ON audit_events(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_plan_id     ON audit_events(plan_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_operation   ON audit_events(operation_ref);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at  ON audit_events(created_at);

-- 可疑行为范围锁定的独立持久状态：按可信 scope 索引计数 / 锁定 / 到期，不依赖审计列表分页。
CREATE TABLE IF NOT EXISTS security_scope_state (
  scope_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  locked_until_ms INTEGER,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (scope_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_security_scope_locked ON security_scope_state(scope_key, locked_until_ms);

-- 请求追踪异步写入失败的可核查记录（不静默丢失）。
CREATE TABLE IF NOT EXISTS audit_trace_failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT,
  payload_json TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 受约束 DAG 计划：白名单节点、依赖、参数、版本与进度全部持久化。
CREATE TABLE IF NOT EXISTS workflow_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_no      TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL,
  flow         TEXT NOT NULL CHECK (flow IN ('subscription_review','repayment_review')),
  status       TEXT NOT NULL,
  plan_json    TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_plans_user_id ON workflow_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_plans_status ON workflow_plans(status);

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
  session_id               TEXT,                      -- 发起该转账单的助手会话（可空，仅溯源；独立转账页建单为 NULL）
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
-- 注意：session_id 的索引不在此创建（旧库尚未有该列），由 migrate 在补列后建立，见 migrate.js。

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

-- 订阅与代扣操作单：查询 / 暂停·取消（yellow，点击确认）/ 恢复、更换扣款账户（red，交易密码 + TOTP 强验证）。
-- 保存订阅归属、动作、预期状态与建单时的订阅版本快照，确认时重新校验订阅状态与版本；
-- 更换扣款账户额外冻结原/新扣款账户与卡片快照（from_* / to_*）。
CREATE TABLE IF NOT EXISTS subscription_operations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no                TEXT NOT NULL UNIQUE,
  user_id               INTEGER NOT NULL,
  subscription_id       INTEGER NOT NULL,
  merchant              TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  billing_cycle         TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'cancel', 'change_source')),
  from_status           TEXT NOT NULL,
  to_status             TEXT NOT NULL,
  subscription_version  INTEGER NOT NULL,
  from_account_id       INTEGER,
  from_account_name     TEXT,
  from_account_type     TEXT,
  from_masked_card      TEXT,
  to_account_id         INTEGER,
  to_account_name       TEXT,
  to_account_type       TEXT,
  to_masked_card        TEXT,
  risk_level            TEXT NOT NULL CHECK (risk_level IN ('yellow', 'red')),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_verification','completed','cancelled','expired','failed')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at            TEXT NOT NULL,
  confirmed_at          TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
  FOREIGN KEY (from_account_id) REFERENCES accounts(id),
  FOREIGN KEY (to_account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_subscription_operations_user_id         ON subscription_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_operations_status          ON subscription_operations(status);
CREATE INDEX IF NOT EXISTS idx_subscription_operations_subscription_id ON subscription_operations(subscription_id);

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
  pending_subscription_op_ref TEXT,               -- 本会话当前待确认订阅操作单编号
  pending_repayment_ref TEXT,                     -- 本会话当前待确认信用卡还款单编号
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

-- 跨场景任务模板（当前仅支持「订阅审查」一条任务链）：
-- 任务、节点、依赖、状态、结果摘要与业务单引用均持久化，刷新 / 后端重启可恢复。
-- 模型只负责理解意图与提取月份；服务端用白名单节点构建任务图并校验依赖。
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no                  TEXT NOT NULL UNIQUE,       -- 任务编号（task- 前缀）
  user_id                  INTEGER NOT NULL,
  kind                     TEXT NOT NULL DEFAULT 'subscription_review' CHECK (kind IN ('subscription_review')),
  status                   TEXT NOT NULL DEFAULT 'waiting_selection' CHECK (status IN ('waiting_selection','waiting_confirmation','completed','failed','paused','cancelled','manual')),
  month                    TEXT,                       -- 分析月份（YYYY-MM，模型提取、服务端校验）
  session_id               TEXT,                       -- 发起该任务的助手会话（可空，仅溯源）
  selected_subscription_id INTEGER,                    -- 用户选定的订阅（等待/已确认）
  op_ref                   TEXT,                       -- 关联的订阅操作单编号（业务单引用）
  result_summary           TEXT,                       -- 汇总回执（JSON）
  failure_reason           TEXT,                       -- 失败原因
  created_at               INTEGER NOT NULL,           -- epoch 毫秒
  updated_at               INTEGER NOT NULL,
  completed_at             INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (selected_subscription_id) REFERENCES subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_id ON agent_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status  ON agent_tasks(status);

-- 任务节点：白名单节点执行状态、依赖（持久化）、结果摘要与失败原因。
CREATE TABLE IF NOT EXISTS agent_task_nodes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  node_key     TEXT NOT NULL,
  seq          INTEGER NOT NULL,                       -- 白名单内的顺序
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','skipped')),
  depends_on   TEXT,                                   -- JSON 数组：依赖的节点 key
  result_json  TEXT,                                   -- 节点结果摘要（JSON）
  error        TEXT,                                   -- 节点失败原因
  started_at   INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id),
  UNIQUE (task_id, node_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_task_nodes_task_id ON agent_task_nodes(task_id);

-- 多银行卡·信用账户：一张信用卡关联一个独立信用账户（accounts.account_type='credit'）。
-- 活期账户（deposit）沿用 accounts.balance_cents 记余额；信用账户的 balance_cents 恒为 0，
-- 债务（已入账未还 / 待入账占用）在此表单独维护，避免与活期余额语义混淆。
CREATE TABLE IF NOT EXISTS credit_accounts (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  INTEGER NOT NULL,
  account_id               INTEGER NOT NULL UNIQUE,               -- 对应 accounts 行（account_type='credit'）
  credit_limit_cents       INTEGER NOT NULL CHECK (credit_limit_cents > 0),
  posted_outstanding_cents INTEGER NOT NULL DEFAULT 0 CHECK (posted_outstanding_cents >= 0),  -- 已入账未还（= 各账单剩余应还之和）
  pending_occupied_cents   INTEGER NOT NULL DEFAULT 0 CHECK (pending_occupied_cents >= 0),    -- 待入账消费占额
  version                  INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_user_id ON credit_accounts(user_id);

-- 信用卡账单：每个上海自然月一份（跨期独立），出账日=下月 1 日，到期日=下月 25 日。
-- 每笔已入账消费按 posted_at（入账时间）的上海自然月归入唯一账单，还款只冲抵指定账单，杜绝重复计债 / 重复冲抵。
-- 未出账（issued_at 为 NULL）时 new_charges_cents 随入账累加；出账（issued_at 置值）后出账金额与消费明细冻结，
-- 出账后才入账的旧交易进入后续未出账账期，不再重开已出账账单。剩余应还 = new_charges_cents - paid_cents（恒 >= 0）。
CREATE TABLE IF NOT EXISTS statements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  credit_account_id INTEGER NOT NULL,
  statement_year    INTEGER NOT NULL,
  statement_month   INTEGER NOT NULL,                             -- 1-12
  period_start      TEXT NOT NULL,                                -- 账期起（上海月初，UTC ISO）
  period_end        TEXT NOT NULL,                                -- 账期止（下月月初，UTC ISO）
  issued_on         TEXT NOT NULL,                                -- 出账日（下月 1 日 00:00 上海）
  issued_at         TEXT,                                         -- 出账时间（实际出账/冻结时刻，UTC ISO；NULL=未出账）
  due_on            TEXT NOT NULL,                                -- 到期日（下月 25 日 00:00 上海）
  new_charges_cents INTEGER NOT NULL DEFAULT 0 CHECK (new_charges_cents >= 0),  -- 本期新增消费（出账后冻结）
  paid_cents        INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),         -- 累计已冲抵
  version           INTEGER NOT NULL DEFAULT 1,                   -- 乐观锁（还款确认时校验账单未变）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (credit_account_id) REFERENCES credit_accounts(id),
  UNIQUE (credit_account_id, statement_year, statement_month)
);

CREATE INDEX IF NOT EXISTS idx_statements_credit_account_id ON statements(credit_account_id);

-- 还款冲抵明细：一笔还款可冲抵多个账单（全部结清模式），因此 repayment_ref 不再唯一；
-- 同一操作单对同一账单最多一条（由 repayment_allocations 的唯一约束与写入逻辑保证）。
CREATE TABLE IF NOT EXISTS statement_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  statement_id  INTEGER NOT NULL,
  repayment_ref TEXT NOT NULL,                                    -- 对应 repayment_operations.ref_no
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_at       TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (statement_id) REFERENCES statements(id)
);

CREATE INDEX IF NOT EXISTS idx_statement_payments_statement_id ON statement_payments(statement_id);
CREATE INDEX IF NOT EXISTS idx_statement_payments_repayment_ref ON statement_payments(repayment_ref);

-- 还款操作单的冲抵分配快照：建单时冻结「每个账单冲抵多少 + 当时的账单版本」，
-- 确认时逐条复核（未出账账单可提前还款；出账后 paid_cents 保留，不重复计债）。
CREATE TABLE IF NOT EXISTS repayment_allocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no            TEXT NOT NULL,                                -- 对应 repayment_operations.ref_no
  statement_id      INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  statement_version INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (statement_id) REFERENCES statements(id)
);

CREATE INDEX IF NOT EXISTS idx_repayment_allocations_ref ON repayment_allocations(ref_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repayment_allocations_ref_statement ON repayment_allocations(ref_no, statement_id);

-- 信用卡还款操作单：全额还款（指定账单剩余应还），恒为红色强验证（交易密码 + TOTP），复用现有安全机制。
-- 建单快照 statement_version + amount_cents，确认时重新核验账单版本与剩余应还，再原子扣款 + 冲抵 + 审计。
CREATE TABLE IF NOT EXISTS repayment_operations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no              TEXT NOT NULL UNIQUE,
  user_id             INTEGER NOT NULL,
  session_id          TEXT,                                       -- 发起该还款单的助手会话（可空，仅溯源；独立页面建单为 NULL）
  scope               TEXT NOT NULL DEFAULT 'statement' CHECK (scope IN ('statement', 'all_posted')),
  from_account_id     INTEGER NOT NULL,                           -- 还款账户（活期）
  from_account_name   TEXT NOT NULL,
  credit_account_id   INTEGER NOT NULL,                           -- 信用账户
  credit_account_name TEXT NOT NULL,
  statement_id        INTEGER NOT NULL,                           -- 主账单（指定账单模式=该账单；全部结清=首个分配账单）
  statement_month     TEXT NOT NULL,                              -- 账单期标签（YYYY-MM）
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),  -- 本次还款合计（服务端计算）
  statement_version   INTEGER NOT NULL,                           -- 主账单版本快照（全部结清以分配表逐条复核）
  risk_level          TEXT NOT NULL CHECK (risk_level IN ('red')),
  status              TEXT NOT NULL DEFAULT 'needs_verification' CHECK (status IN ('needs_verification','completed','cancelled','expired','failed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at          TEXT NOT NULL,
  confirmed_at        TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (from_account_id) REFERENCES accounts(id),
  FOREIGN KEY (credit_account_id) REFERENCES credit_accounts(id),
  FOREIGN KEY (statement_id) REFERENCES statements(id)
);

CREATE INDEX IF NOT EXISTS idx_repayment_operations_user_id      ON repayment_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_repayment_operations_status       ON repayment_operations(status);
CREATE INDEX IF NOT EXISTS idx_repayment_operations_statement_id ON repayment_operations(statement_id);
CREATE INDEX IF NOT EXISTS idx_repayment_operations_session_id   ON repayment_operations(session_id);
`

export function createSchema(db) {
  db.transaction(() => {
    db.exec(SCHEMA_SQL)
  })()
}
