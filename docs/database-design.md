# 数据库设计说明

本文件说明融智 Agent 的 SQLite 数据库表结构、金额单位、日期规则与模拟数据生成方式。

- 数据库文件：`backend/data/rongzhi.db`（已加入 `.gitignore`，不纳入版本控制）
- 驱动：`better-sqlite3`（同步 API）
- 外键约束：每个连接均通过 `PRAGMA foreign_keys = ON` 开启
- 日志模式：WAL（会生成 `rongzhi.db-wal` / `rongzhi.db-shm` 日志文件）

## 一、金额单位约定

所有金额统一使用整数「分」存储，字段名以 `_cents` 结尾，例如：

- `amount_cents`：交易金额（分）
- `opening_balance_cents`：期初余额（分）
- `balance_cents`：当前余额（分）
- `daily_limit_cents`：卡片日限额（分）

> 例：`1280000` 表示 ¥12800.00。交易金额要求为正整数（`amount_cents > 0`），
> 收入/支出方向由 `direction` 字段（`income` / `expense`）区分，而非正负号。

## 二、日期与时间约定

- 演示数据的「日历日期」（年/月/日）按 **Asia/Shanghai（UTC+8，无夏令时）** 解释。
- 存储时统一转换为 **UTC ISO 8601 字符串（带 `Z`）**，例如 `2026-10-05T01:00:00.000Z`。
- `created_at` 使用 SQLite 默认 `datetime('now')`（UTC），或由脚本显式写入 UTC 时间。
- `opened_on`（开户日期）、`issued_on`（开卡日期）为**业务日期**，纯日期字符串 `YYYY-MM-DD`，区别于记录创建时间 `created_at`。本套演示数据统一为 `2026-08-01`。
- 交易覆盖「当前月 + 前两个月」，当前月由 Asia/Shanghai 时区的今天计算得出。

## 三、表结构

### 1. users — 用户

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 用户 ID |
| name | TEXT | NOT NULL | 姓名 |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | 创建时间（UTC） |

### 2. accounts — 账户

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 账户 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| account_name | TEXT | NOT NULL | 账户名称 |
| opening_balance_cents | INTEGER | NOT NULL, >= 0 | 期初余额（分） |
| balance_cents | INTEGER | NOT NULL, >= 0 | 当前余额（分） |
| currency | TEXT | NOT NULL DEFAULT 'CNY' | 币种 |
| account_type | TEXT | NOT NULL DEFAULT 'deposit', deposit/credit | 账户类型（活期 / 信用） |
| status | TEXT | NOT NULL, active/frozen/closed | 状态 |
| opened_on | TEXT | 可空，演示数据为 2026-08-01 | 开户日期（业务日期 YYYY-MM-DD） |
| created_at | TEXT | NOT NULL | 创建时间 |

### 3. transactions — 交易流水

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 交易 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| account_id | INTEGER | NOT NULL, FK→accounts.id | 关联账户 |
| direction | TEXT | NOT NULL, income/expense | 收支方向 |
| amount_cents | INTEGER | NOT NULL, > 0 | 金额（分） |
| category | TEXT | NOT NULL | 分类 |
| merchant | TEXT | | 商户 |
| description | TEXT | | 描述 |
| transaction_at | TEXT | NOT NULL | 交易时间（UTC ISO） |
| status | TEXT | NOT NULL, posted/pending | 状态 |
| transfer_ref | TEXT | 可空 | 转账操作编号（非转账流水为 NULL） |
| flow_kind | TEXT | NOT NULL DEFAULT 'external', external/repayment | 资金性质（普通收支 / 信用卡还款冲抵） |
| repayment_ref | TEXT | 可空 | 还款操作编号（非还款流水为 NULL） |
| created_at | TEXT | NOT NULL | 创建时间 |

> 余额核算只统计 `status = 'posted'`（已入账）的交易；`pending`（待入账）不计入余额。
> `flow_kind = 'repayment'` 的还款冲抵流水既不计为消费支出、也不计作收入（`monthlyAnalytics` 排除）。

### 4. cards — 银行卡

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 卡片 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| account_id | INTEGER | NOT NULL, FK→accounts.id | 关联账户 |
| masked_card_number | TEXT | NOT NULL | 掩码卡号（虚构） |
| card_type | TEXT | NOT NULL | 卡类型（如 借记卡） |
| status | TEXT | NOT NULL, active/frozen/cancelled | 状态 |
| daily_limit_cents | INTEGER | NOT NULL, >= 0 | 日限额（分） |
| issued_on | TEXT | 可空，演示数据为 2026-08-01 | 开卡日期（业务日期 YYYY-MM-DD） |
| version | INTEGER | NOT NULL DEFAULT 1 | 乐观锁版本号（冻结/解冻状态 CAS 用） |
| created_at | TEXT | NOT NULL | 创建时间 |

### 5. subscriptions — 订阅与代扣

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 订阅 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| account_id | INTEGER | NOT NULL, FK→accounts.id | 扣款账户 |
| merchant | TEXT | NOT NULL | 商户 |
| amount_cents | INTEGER | NOT NULL, > 0 | 每期扣费金额（分） |
| billing_cycle | TEXT | NOT NULL, monthly/yearly | 扣费周期 |
| next_billing_date | TEXT | 可空 | 下次扣费日期（UTC ISO） |
| status | TEXT | NOT NULL, active/paused/cancelled | 状态 |
| version | INTEGER | NOT NULL DEFAULT 1 | 乐观锁版本号（暂停/恢复/取消状态 CAS 用） |
| created_at | TEXT | NOT NULL | 创建时间 |

> `next_billing_date` 表示「未来」的计划扣费日期，不会被提前生成为已发生的交易；
> 已取消（cancelled）的订阅该字段为 `NULL`。

### 6. audit_logs — 审计日志

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 日志 ID |
| user_id | INTEGER | 可空, FK→users.id | 相关用户 |
| operation_type | TEXT | NOT NULL | 操作类型 |
| operation_ref | TEXT | | 操作编号 |
| action | TEXT | NOT NULL | 动作 |
| result | TEXT | | 结果 |
| detail | TEXT | | 详情 |
| created_at | TEXT | NOT NULL | 创建时间 |

> 种子数据阶段本表为空；模拟转账会写入 `create` / `confirm` / `cancel` 等真实操作日志。

### 7. transfer_recipients — 虚构收款人

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 收款人 ID |
| name | TEXT | NOT NULL | 收款人姓名（虚构） |
| masked_account | TEXT | NOT NULL | 掩码账户（虚构） |
| created_at | TEXT | NOT NULL | 创建时间 |

> 由迁移在表为空时写入 4 条虚构收款人（李雷 / 韩梅梅 / 王强 / 赵敏），幂等。

### 8. transfer_operations — 转账操作记录

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 记录 ID |
| ref_no | TEXT | NOT NULL UNIQUE | 操作唯一编号 |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户（服务端演示用户） |
| from_account_id | INTEGER | NOT NULL, FK→accounts.id | 付款账户 |
| from_account_name | TEXT | NOT NULL | 付款账户名称快照 |
| recipient_id | INTEGER | NOT NULL, FK→transfer_recipients.id | 收款人 |
| recipient_name | TEXT | NOT NULL | 收款人姓名快照 |
| recipient_masked_account | TEXT | NOT NULL | 收款人掩码账户快照 |
| amount_cents | INTEGER | NOT NULL, > 0 | 金额（分） |
| remark | TEXT | | 备注 |
| status | TEXT | NOT NULL, pending/needs_verification/completed/cancelled/expired/failed | 状态 |
| risk_level | TEXT | NOT NULL, yellow/red | 风险级别（后端判定） |
| created_at | TEXT | NOT NULL | 创建时间 |
| expires_at | TEXT | NOT NULL | 确认有效期（5 分钟） |
| confirmed_at | TEXT | 可空 | 确认时间 |

> 保存不可被确认请求覆盖的付款账户、收款人、金额、备注快照；金额为整数分。
> `needs_verification` 表示「需要强验证」（红色），本阶段不执行。

### 9. card_operations — 银行卡操作记录（临时冻结 / 解冻）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 记录 ID |
| ref_no | TEXT | NOT NULL UNIQUE | 操作唯一编号（`card-op-` 前缀，区别于转账） |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户（服务端演示用户） |
| card_id | INTEGER | NOT NULL, FK→cards.id | 目标银行卡 |
| card_masked | TEXT | NOT NULL | 掩码卡号快照 |
| card_type | TEXT | NOT NULL | 卡类型快照 |
| action | TEXT | NOT NULL, freeze/unfreeze | 冻结 / 解冻 |
| from_status | TEXT | NOT NULL | 建单时卡片状态快照 |
| to_status | TEXT | NOT NULL | 目标卡片状态快照 |
| card_version | INTEGER | NOT NULL | 建单时卡片版本快照（乐观锁 CAS 依据） |
| risk_level | TEXT | NOT NULL, yellow/red | 风险级别（后端判定，冻结 yellow / 解冻 red） |
| status | TEXT | NOT NULL, pending/needs_verification/completed/cancelled/expired/failed | 状态 |
| created_at | TEXT | NOT NULL | 创建时间 |
| expires_at | TEXT | NOT NULL | 确认有效期（5 分钟） |
| confirmed_at | TEXT | 可空 | 确认时间 |

> 创建操作单**不改变卡片状态**；冻结在确认时执行，解冻在强验证时执行，均以 `card_version` 做
> 状态 CAS（`UPDATE cards ... WHERE id=? AND status=? AND version=?`），建单后卡片被改动（含「正常→冻结→正常」）
> 的旧单不可覆盖新状态。`cancelled` 卡不可解冻 / 冻结；除到期外不允许任意跳转。

### 10. subscription_operations — 订阅操作记录（暂停 / 恢复 / 取消）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 记录 ID |
| ref_no | TEXT | NOT NULL UNIQUE | 操作唯一编号（`sub-op-` 前缀，区别于转账 / 银行卡） |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户（服务端演示用户） |
| subscription_id | INTEGER | NOT NULL, FK→subscriptions.id | 目标订阅 |
| merchant | TEXT | NOT NULL | 商户快照 |
| amount_cents | INTEGER | NOT NULL | 每期金额快照（分） |
| billing_cycle | TEXT | NOT NULL | 扣费周期快照 |
| action | TEXT | NOT NULL, pause/resume/cancel | 暂停 / 恢复 / 取消 |
| from_status | TEXT | NOT NULL | 建单时订阅状态快照 |
| to_status | TEXT | NOT NULL | 目标订阅状态快照 |
| subscription_version | INTEGER | NOT NULL | 建单时订阅版本快照（乐观锁 CAS 依据） |
| risk_level | TEXT | NOT NULL, yellow/red | 风险级别（后端判定，暂停/取消 yellow / 恢复 red） |
| status | TEXT | NOT NULL, pending/needs_verification/completed/cancelled/expired/failed | 状态 |
| created_at | TEXT | NOT NULL | 创建时间 |
| expires_at | TEXT | NOT NULL | 确认有效期（5 分钟） |
| confirmed_at | TEXT | 可空 | 确认时间 |

> 创建操作单**不改变订阅状态**；暂停 / 取消在确认时执行，恢复在强验证时执行，均以 `subscription_version` 做
> 状态 CAS（`UPDATE subscriptions ... WHERE id=? AND version=?`），建单后订阅被改动（含「生效→暂停→生效」）
> 的旧单不可覆盖新状态。`cancelled` 订阅为终态不可再操作；除到期外不允许任意跳转。
> 操作编号 / 待办引用与转账、银行卡完全独立，互不影响。

### 11. chat_sessions — AI 助手会话（模型上下文 + 会话元数据，part B）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | TEXT | PRIMARY KEY | 会话 UUID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户（服务端演示用户） |
| messages_json | TEXT | NOT NULL DEFAULT '[]' | 模型上下文（user / assistant / tool 消息，含完整 tool_calls 与 tool 结果配对；不含 system） |
| pending_transfer_ref | TEXT | 可空 | 本会话当前待确认转账单编号 |
| pending_card_op_ref | TEXT | 可空 | 本会话当前待确认银行卡操作单编号 |
| pending_subscription_op_ref | TEXT | 可空 | 本会话当前待确认订阅操作单编号 |
| created_at | INTEGER | NOT NULL | 创建时间（epoch 毫秒） |
| last_active_at | INTEGER | NOT NULL | 最近活跃时间（epoch 毫秒，用于 30 分钟会话 TTL） |

> system 提示**不持久化**，每次由服务端按当前上海时间生成；不持久化任何密码 / 验证码 / TOTP 密钥 / 模型密钥 / 敏感请求体。

### 12. chat_messages — AI 助手用户可见消息（part A）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 记录 ID |
| session_id | TEXT | NOT NULL, FK→chat_sessions.id | 所属会话 |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| seq | INTEGER | NOT NULL | 会话内顺序（单调递增） |
| role | TEXT | NOT NULL, user/assistant | 消息角色（tool 消息不入此表） |
| text | TEXT | NOT NULL | 用户消息文本 / 助手回复文本 |
| tool_records_json | TEXT | 可空 | 助手消息的工具展示记录（user 消息为 NULL） |
| incomplete | INTEGER | NOT NULL DEFAULT 0 | 助手回答是否因达到调用 / 工具上限而未完成 |
| error | TEXT | 可空 | 助手回复失败说明（正常为空） |
| created_at | INTEGER | NOT NULL | 创建时间（epoch 毫秒） |

> 每轮对话存 user 与 assistant 各一行；工具调用 / 结果的原始消息只存于 `chat_sessions.messages_json`（模型上下文）。

### 13. chat_state — 当前对话指针

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| user_id | INTEGER | PRIMARY KEY, FK→users.id | 所属用户 |
| current_session_id | TEXT | 可空 | 当前会话 id（「新建对话」置空） |

> 单用户演示：刷新按此指针恢复「当前对话」；新建对话仅清除指针，不删除历史。
> 记录上限：单会话最多 200 条用户可见消息（超出截断最旧）；保留期：7 天，过期会话在访问时惰性清除上下文与消息。

### 14. agent_tasks — 跨场景任务（当前仅「订阅审查」一条任务链）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 任务 ID |
| task_no | TEXT | NOT NULL UNIQUE | 任务唯一编号（`task-` 前缀） |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户（服务端演示用户） |
| kind | TEXT | NOT NULL, subscription_review | 任务类型（当前仅此一种） |
| status | TEXT | NOT NULL, waiting_selection/waiting_confirmation/completed/failed/paused/cancelled/manual | 任务状态 |
| month | TEXT | 可空 | 分析月份（YYYY-MM，服务端校验） |
| session_id | TEXT | 可空 | 启动任务的会话 id |
| selected_subscription_id | INTEGER | 可空, FK→subscriptions.id | 用户选定的订阅 |
| op_ref | TEXT | 可空 | 关联订阅操作单编号（复用 subscription_operations） |
| result_summary | TEXT | 可空 | 汇总回执 JSON（服务端生成） |
| failure_reason | TEXT | 可空 | 失败原因 |
| created_at | INTEGER | NOT NULL | 创建时间（epoch 毫秒） |
| updated_at | INTEGER | NOT NULL | 更新时间（epoch 毫秒） |
| completed_at | INTEGER | 可空 | 完成时间（epoch 毫秒） |

### 15. agent_task_nodes — 跨场景任务节点（白名单图 + 依赖 + 状态持久化）

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 节点 ID |
| task_id | INTEGER | NOT NULL, FK→agent_tasks.id | 所属任务 |
| node_key | TEXT | NOT NULL | 节点白名单 key（monthly_analysis 等 7 个） |
| seq | INTEGER | NOT NULL | 节点顺序 |
| status | TEXT | NOT NULL, pending/completed/failed/skipped | 节点状态 |
| depends_on | TEXT | 可空 | 依赖节点 key（JSON 数组，服务端构建时校验） |
| result_json | TEXT | 可空 | 节点结果 JSON（月度统计 / 订阅快照 / 操作单编号等） |
| error | TEXT | 可空 | 节点失败说明 |
| started_at | INTEGER | 可空 | 开始时间（epoch 毫秒） |
| completed_at | INTEGER | 可空 | 完成时间（epoch 毫秒） |

> 任务图由服务端用白名单节点构建并校验（key 唯一、依赖存在、无环、顺序连续），**不执行模型生成的任意步骤**。
> 任务、节点、依赖、状态、结果摘要与业务单引用全部持久化，刷新 / 后端重启可恢复；恢复不重发模型请求、不重发业务操作。
> `UNIQUE(task_id, node_key)` 保证同一任务内节点唯一。

### 16. credit_accounts — 信用账户（多银行卡）

一张信用卡关联一个独立信用账户（`accounts.account_type = 'credit'`）。活期账户（deposit）沿用
`accounts.balance_cents` 记余额；信用账户的 `balance_cents` 恒为 0，债务在此表单独维护，
避免「信用欠款」与「活期余额」语义混淆。

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 信用账户 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| account_id | INTEGER | NOT NULL UNIQUE, FK→accounts.id | 对应 accounts 行（account_type='credit'） |
| credit_limit_cents | INTEGER | NOT NULL, > 0 | 信用额度（分） |
| posted_outstanding_cents | INTEGER | NOT NULL DEFAULT 0, >= 0 | 已入账未还（= 各账单剩余应还之和） |
| pending_occupied_cents | INTEGER | NOT NULL DEFAULT 0, >= 0 | 待入账消费占额 |
| version | INTEGER | NOT NULL DEFAULT 1 | 乐观锁版本号 |
| created_at | TEXT | NOT NULL | 创建时间 |

> 可用额度 = `credit_limit_cents - posted_outstanding_cents - pending_occupied_cents`。
> 待入账消费占额、入账后转欠款、还款冲抵均在同一事务内维护本表两个计数，保证不重复占额 / 不重复计债。

### 17. statements — 信用卡账单（跨期独立）

每个上海自然月一份账单；出账日 = 下月 1 日，到期日 = 下月 25 日（均按 Asia/Shanghai 边界）。
每笔已入账消费按 `transaction_at` 的上海自然月归入**唯一**账单；还款只冲抵**指定**账单，
从模型上杜绝重复计债 / 重复冲抵。逾期未还的剩余应还如实保留在各自账单，不自动结转合并。

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 账单 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| credit_account_id | INTEGER | NOT NULL, FK→credit_accounts.id | 信用账户 |
| statement_year | INTEGER | NOT NULL | 账期年（上海） |
| statement_month | INTEGER | NOT NULL, 1-12 | 账期月（上海） |
| period_start | TEXT | NOT NULL | 账期起（上海月初，UTC ISO） |
| period_end | TEXT | NOT NULL | 账期止（下月月初，UTC ISO） |
| issued_on | TEXT | NOT NULL | 出账日（下月 1 日 00:00 上海） |
| due_on | TEXT | NOT NULL | 到期日（下月 25 日 00:00 上海） |
| new_charges_cents | INTEGER | NOT NULL DEFAULT 0, >= 0 | 本期新增消费 |
| paid_cents | INTEGER | NOT NULL DEFAULT 0, >= 0 | 累计已冲抵 |
| version | INTEGER | NOT NULL DEFAULT 1 | 乐观锁版本号（还款确认时校验账单未变） |
| created_at | TEXT | NOT NULL | 创建时间 |

> 剩余应还 = `new_charges_cents - paid_cents`（恒 >= 0）。状态派生：剩余 <= 0 → paid（已结清）；
> 剩余 > 0 且已过 `due_on` → overdue（到期未还）；否则 open（未到期未结清）。
> `UNIQUE(credit_account_id, statement_year, statement_month)` 保证同一信用账户每月至多一份账单。

### 18. statement_payments — 还款冲抵明细

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 明细 ID |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| statement_id | INTEGER | NOT NULL, FK→statements.id | 被冲抵账单 |
| repayment_ref | TEXT | NOT NULL UNIQUE | 对应还款操作编号 |
| amount_cents | INTEGER | NOT NULL, > 0 | 冲抵金额（分） |
| paid_at | TEXT | NOT NULL | 冲抵时间 |

> 每笔还款只冲抵一个账单；`repayment_ref` 唯一，从数据库层防同一还款重复冲抵（还款可追溯性）。

### 19. repayment_operations — 信用卡还款操作单（全额还款 + 强验证）

仅支持「指定账单剩余应还」的全额还款，不支持最低还款 / 分期 / 取现。恒为红色强验证
（交易密码 + TOTP），复用现有验证服务；建单快照 `statement_version + amount_cents`，
确认时重新核验账单版本与剩余应还，再原子扣款 + 冲抵 + 审计。

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 记录 ID |
| ref_no | TEXT | NOT NULL UNIQUE | 操作唯一编号 |
| user_id | INTEGER | NOT NULL, FK→users.id | 所属用户 |
| from_account_id | INTEGER | NOT NULL, FK→accounts.id | 还款账户（活期） |
| from_account_name | TEXT | NOT NULL | 还款账户名称快照 |
| credit_account_id | INTEGER | NOT NULL, FK→credit_accounts.id | 信用账户 |
| credit_account_name | TEXT | NOT NULL | 信用账户名称快照 |
| statement_id | INTEGER | NOT NULL, FK→statements.id | 目标账单 |
| statement_month | TEXT | NOT NULL | 账单期标签（YYYY-MM） |
| amount_cents | INTEGER | NOT NULL, > 0 | 全额 = 建单时该账单剩余应还 |
| statement_version | INTEGER | NOT NULL | 建单时账单版本快照（乐观锁 CAS 依据） |
| risk_level | TEXT | NOT NULL, red | 风险级别（恒为红色强验证） |
| status | TEXT | NOT NULL, needs_verification/completed/cancelled/expired/failed | 状态 |
| created_at | TEXT | NOT NULL | 创建时间 |
| expires_at | TEXT | NOT NULL | 确认有效期（5 分钟） |
| confirmed_at | TEXT | 可空 | 确认时间 |

> 还款执行：扣减活期账户余额 + 记一条 `flow_kind='repayment'` 的还款流水（不计入收支/消费）+
> 写 `statement_payments` 冲抵明细 + 账单 `paid_cents` 累加 + 信用账户 `posted_outstanding_cents` 扣减，
> 全部同一事务；操作单状态 CAS 认领保证重复确认只执行一次。
> 冻结（cards.status='frozen'）期间允许还款、禁止新增消费；已待入账流水仍可正常入账。

### 索引

为各外键列及常用查询列建立了索引（`idx_*`），例如：
`idx_transactions_account_id`、`idx_transactions_transaction_at`、
`idx_subscriptions_next_billing_date` 等。
转账相关：`idx_transfer_operations_user_id` / `_status` / `_confirmed_at`，
以及唯一索引 `idx_transactions_transfer_ref`（同一转账单最多对应一条流水，数据库层面防重复入账）。
银行卡操作相关：`idx_card_operations_user_id` / `_status` / `_confirmed_at`，
以及唯一索引 `idx_card_operations_ref_no`（操作编号唯一）。
订阅操作相关：`idx_subscription_operations_user_id` / `_status` / `_subscription_id`，
`ref_no` 以 `UNIQUE` 约束保证操作编号唯一。
AI 助手相关：`idx_chat_sessions_user_id` / `_last_active_at`、
`idx_chat_messages_session_id`（`session_id` + `seq`）等。
跨场景任务相关：`idx_agent_tasks_user_id` / `idx_agent_tasks_status`、`idx_agent_task_nodes_task_id`，
`agent_tasks.task_no` 以 `UNIQUE` 约束保证编号唯一，`agent_task_nodes` 以 `UNIQUE(task_id, node_key)` 保证节点唯一。
信用卡相关：`idx_credit_accounts_user_id`、`idx_statements_credit_account_id`、
`idx_statement_payments_statement_id` / `idx_statement_payments_repayment_ref`（还款冲抵唯一）、
`idx_repayment_operations_user_id` / `_status` / `_statement_id`、
唯一索引 `idx_transactions_repayment_ref`（同一还款操作单最多对应一条还款流水，数据库层面防重复入账）；
`statements` 以 `UNIQUE(credit_account_id, statement_year, statement_month)` 保证每信用账户每月至多一份账单。

## 四、模拟数据生成方式

- 使用**固定随机种子**（mulberry32，seed = 20261021）的确定性伪随机数，保证每次生成结果一致、可复现。
- 交易覆盖「当前月 + 前两个月」，共 **58 条**：
  - 收入：3 笔月度工资（每月 ¥12800）+ 1 笔季度奖金（¥3000）；
  - 支出：餐饮、购物、交通、娱乐、住房、订阅扣费 6 大类，每类 9 笔，共 54 笔；
  - 其中未来时间（相对种子运行时刻）的交易标记为 `pending`（待入账，不计入余额），
    另外最近 2 笔支出也标记为 `pending`；其余为 `posted`（已入账）。
- 账户余额 = 期初余额（¥8000）+ 已入账收入 − 已入账支出，保证非负。
- 订阅：6 条，覆盖 active / paused / cancelled 三种状态；`next_billing_date` 为未来日期。
- 账户 / 卡片各 1 条；审计日志 0 条。
- 虚构收款人 4 条（李雷 / 韩梅梅 / 王强 / 赵敏），由迁移在 `transfer_recipients` 为空时写入。

### 可选演示数据（信用卡·多银行卡，默认关闭）

`backend/scripts/seed-demo.js` 是一份**独立、可选、幂等**的演示数据脚本，不接入 `db:init` / 启动流程，默认不执行。
它在**隔离演示库**（默认 `data/demo.db`，与开发库 `data/rongzhi.db` 分离）生成可控样本：

- **2 张借记卡**，各自关联一个独立活期账户（`deposit`，含少量已入账收支）；
- **1 张信用卡**，关联一个独立信用账户（`credit`，额度 ¥50000）；
- 跨期消费样本覆盖三种账单状态 + 待入账占用：
  - 上上月：两笔已入账消费 → 已出账并全额还款 → `paid`（已结清）；
  - 上月：两笔已入账消费 → 已出账未结清 → `open` / `overdue`（未到期 / 逾期）；
  - 本月：一笔已入账消费 → `unissued`（未出账）+ 一笔待入账消费 → `pending_occupied`（待入账占用）。

金额固定（非随机），演示「交易发生 / 入账 / 出账 / 还款」四种时间与账单状态机。安全护栏：目标库默认与开发库分离；
`--db` 显式指向开发库须加 `--allow-dev-db`；`--preview`（一次性临时库真实生成后打印清单，不落盘）与
`--check`（只读一致性校验）供未来开发库部署前检查。

## 五、初始化与约束

- 初始化：`npm run db:init`（`backend/scripts/init-db.js`）。
  - 数据库不存在时创建表结构并写入种子数据；
  - 重复执行检测到已有用户数据即跳过，不重复插入、不清空、不覆盖；
  - 建表与种子数据写入均在事务中完成；
  - 未提供自动清库/重置功能。
- 迁移：`backend/src/db/migrate.js`（幂等）。建表后自动执行，对已有库增量补列 `opened_on` / `issued_on` / `transactions.transfer_ref` 并回填 `2026-08-01`、补列 `cards.version` 并回填 `1`，建立唯一关联索引 `idx_transactions_transfer_ref`，新增 `card_operations` 表及索引，并在 `transfer_recipients` 为空时写入 4 条虚构收款人；新增 `subscription_operations` 表及索引、补列 `subscriptions.version` 并回填 `1`、补列 `chat_sessions.pending_subscription_op_ref`；仅回填 NULL 与空表，不删库、不清空、不重建交易、不改余额，重复执行数据不变。
- 普通后端启动（`npm run dev` / `npm start`）确保表结构存在并执行迁移，不灌入、不清空数据。
  `chat_sessions` / `chat_messages` / `chat_state` / `agent_tasks` / `agent_task_nodes` 五张表由 `createSchema`
  （`CREATE TABLE IF NOT EXISTS`）在每次启动时幂等创建，无需额外迁移步骤。

## 六、验证脚本

`backend/scripts/verify-db.js` 在独立的临时数据库上执行以下检查，不影响开发数据库：

1. 六张基础表存在；
2. 数据条数符合要求；
3. 重复初始化后条数不变；
4. 关闭后重新打开数据仍存在；
5. 余额与流水核算一致且非负；
6. 无效外键与非法金额被约束拒绝。

`backend/scripts/verify-transfers.js` 在独立临时库上验证模拟转账：创建不扣款、黄色确认扣款入账、
防重复、取消 / 过期 / 余额不足 / 异常账户不扣款、1000 元边界与累计跨过、上海跨日重置、
确认时重新判累计、归属与篡改、红色无法普通确认、转账后余额与流水一致（61 项断言）。

`backend/scripts/verify-card-operations.js` 在独立临时库上验证银行卡查询 / 临时冻结 / 解冻：
创建不改状态、归属与状态流转校验、版本 CAS（含「正常→冻结→正常」旧单不可覆盖）、
冻结确认 / 解冻强验证 / 取消 / 过期 / 重复执行幂等、与转账强验证共用防重放与失败锁定（78 项断言）。

`backend/scripts/verify-subscription-operations.js` 在独立临时库上验证订阅查询 / 暂停 / 恢复 / 取消：
创建不改状态、归属与状态流转校验（active↔paused / cancelled 终态）、版本 CAS（含「生效→暂停→生效」旧单不可覆盖）、
暂停 / 取消确认与恢复强验证 / 取消 / 过期 / 重复执行幂等、与转账强验证共用防重放与失败锁定、
越权 / 篡改 / 未知状态 / 订阅被删 / 事务回滚、多订阅澄清 / 上下文指向 / 模型重复建单、
聊天「确认」不执行、HTTP 路由端到端（84 项断言）。

`backend/scripts/verify-chat-persistence.js` 在独立临时库上验证 AI 助手会话持久化（mock 模型，不调用收费模型）：
两轮对话刷新恢复、后端重启后上下文恢复、过期会话历史可查看且上下文重新开始、tool_calls/tool 配对与归属隔离、
新建对话隔离（旧迟到响应不污染新会话）、只读恢复不伪造历史、操作卡回读业务库最新状态、
不持久化任何凭据、200 条上限 + 7 天保留 + 损坏 JSON 容错（35 项断言）。

`backend/scripts/verify-agent-tasks.js` 在独立临时库上验证跨场景任务模板（mock 模型，不调用收费模型）：
完整任务链（分析→列订阅→选择→暂停单→确认→核验→回执）、选择前不建变更单、准备不执行、真实确认后才完成、
重复请求幂等、依赖与参数校验、越权、旧版本 / 过期单、暂停 / 取消与确认竞态、刷新 / 重启恢复、
失败后安全继续、手动接管、助手模型启动任务、HTTP 路由字段校验、原业务无回归（70 项断言）。

`backend/scripts/verify-credit-repayment.js` 在独立临时库上验证信用卡模型 / 迁移（mock，不调用收费模型）：
旧库兼容补列与回填、消费→入账→出账→全额还款闭环、七项重点（不重复占额 / 不重复计债 / 还款不计收支 /
重复确认幂等 / 越权拒绝 / 冻结可还款禁消费 / 账期按入账时间月初边界）、强验证接线（错误凭据拒绝、未绑定被拒）
（62 项断言）。

`backend/scripts/verify-credit-routes.js` 在独立临时库上验证信用卡 / 还款 HTTP 路由：信用账户视图（含账单）、
还款操作单 prepare / verify / status / cancel、服务器端字段校验、越权拒绝、信用卡账户不可对外转账 / 不可作还款来源。

`backend/scripts/verify-activity.js` 验证 `/api/activity` 聚合纳入 `repayment` 类型（转账 / 银行卡 / 订阅 / 还款 / 任务）。

`backend/scripts/verify-demo-seed.js` 在独立临时库上验证可选演示数据 `seed-demo.js`：
2 借记卡 + 1 信用卡、paid / open·overdue / unissued 状态覆盖、`posted_outstanding` / `pending_occupied` 一致性、
还款流水 / 冲抵明细 / 审计完整、幂等不重复插入（21 项断言）。

运行：`node backend/scripts/verify-db.js`、`node backend/scripts/verify-transfers.js`、
`node backend/scripts/verify-card-operations.js`、`node backend/scripts/verify-subscription-operations.js`、
`node backend/scripts/verify-chat-persistence.js`、`node backend/scripts/verify-credit-repayment.js`、
`node backend/scripts/verify-credit-routes.js`、`node backend/scripts/verify-demo-seed.js`
