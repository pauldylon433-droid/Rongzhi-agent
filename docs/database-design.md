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
| created_at | TEXT | NOT NULL | 创建时间 |

> 余额核算只统计 `status = 'posted'`（已入账）的交易；`pending`（待入账）不计入余额。

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

### 索引

为各外键列及常用查询列建立了索引（`idx_*`），例如：
`idx_transactions_account_id`、`idx_transactions_transaction_at`、
`idx_subscriptions_next_billing_date` 等。
转账相关：`idx_transfer_operations_user_id` / `_status` / `_confirmed_at`，
以及唯一索引 `idx_transactions_transfer_ref`（同一转账单最多对应一条流水，数据库层面防重复入账）。

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

## 五、初始化与约束

- 初始化：`npm run db:init`（`backend/scripts/init-db.js`）。
  - 数据库不存在时创建表结构并写入种子数据；
  - 重复执行检测到已有用户数据即跳过，不重复插入、不清空、不覆盖；
  - 建表与种子数据写入均在事务中完成；
  - 未提供自动清库/重置功能。
- 迁移：`backend/src/db/migrate.js`（幂等）。建表后自动执行，对已有库增量补列 `opened_on` / `issued_on` / `transactions.transfer_ref` 并回填 `2026-08-01`，建立唯一关联索引 `idx_transactions_transfer_ref`，并在 `transfer_recipients` 为空时写入 4 条虚构收款人；仅回填 NULL 与空表，不删库、不清空、不重建交易、不改余额，重复执行数据不变。
- 普通后端启动（`npm run dev` / `npm start`）确保表结构存在并执行迁移，不灌入、不清空数据。

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

运行：`node backend/scripts/verify-db.js`、`node backend/scripts/verify-transfers.js`
