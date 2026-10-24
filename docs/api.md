# API 接口文档

融智 Agent 后端接口（只读查询 + 模拟转账 + 银行卡冻结/解冻 + 订阅暂停/恢复/取消 + 跨场景任务）。当前为**单用户演示模式**：服务端固定演示用户「张三」
（用户 id 由服务端解析），所有查询均按该用户限制数据范围，不接受客户端通过 `user_id` 切换用户。
该模式尚未实现正式登录认证。

## 通用约定

### 基础地址

- 开发环境：`http://localhost:3000`

### 响应格式

成功：

```json
{ "success": true, "data": [...] }
```

失败：

```json
{ "success": false, "message": "清晰的错误说明" }
```

### 金额单位

金额统一为整数「分」，字段以 `_cents` 结尾（如 `amount_cents`、`balance_cents`、`daily_limit_cents`）。
例如 `2500` 表示 ¥25.00。

### 时间

- `transaction_at`、`next_billing_date` 等业务时间为 UTC ISO 8601 字符串（带 `Z`）。
- `opened_on`（开户日期）、`issued_on`（开卡日期）为业务日期，格式 `YYYY-MM-DD`，与记录创建时间 `created_at` 无关。
- 交易按 `month=YYYY-MM` 筛选时，按 Asia/Shanghai（UTC+8）的自然月解释（左闭右开区间）。

### 交易状态

`status` 保留数据库原值：`posted`（已入账）、`pending`（待入账），不会把 `pending` 当成已入账。

## 接口列表

### GET /api/health

健康检查。

```json
{ "success": true, "message": "服务正常", "timestamp": "2026-10-21T10:59:11.850Z" }
```

### GET /api/accounts

返回演示用户账户列表。

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "account_name": "人民币活期账户",
      "opening_balance_cents": 800000,
      "balance_cents": 4233109,
      "currency": "CNY",
      "status": "active",
      "opened_on": "2026-08-01",
      "created_at": "2026-10-21T10:58:40.777Z"
    }
  ]
}
```

### GET /api/cards

返回演示用户银行卡列表（仅掩码卡号，不返回完整卡号）。

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "account_id": 1,
      "masked_card_number": "6222 **** **** 1234",
      "card_type": "借记卡",
      "status": "active",
      "daily_limit_cents": 5000000,
      "issued_on": "2026-08-01",
      "created_at": "2026-10-21T10:58:40.777Z"
    }
  ]
}
```

### GET /api/subscriptions

返回演示用户订阅与代扣列表。

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "account_id": 1,
      "merchant": "爱奇艺会员",
      "amount_cents": 2500,
      "billing_cycle": "monthly",
      "next_billing_date": "2026-11-15T01:00:00.000Z",
      "status": "active",
      "created_at": "2026-10-21T10:58:40.777Z"
    }
  ]
}
```

### GET /api/transactions

返回演示用户交易流水，支持月份筛选、入账状态筛选与分页。

#### 查询参数

| 参数 | 类型 | 默认 | 说明 |
| ---- | ---- | ---- | ---- |
| month | string | 无 | `YYYY-MM`，按上海时区自然月筛选；不传则不限制 |
| status | string | 无 | `posted`（已入账）/ `pending`（待入账）；不传则不限制 |
| limit | integer | 50 | 每页条数，1-100 |
| offset | integer | 0 | 偏移量，非负整数 |

- 结果按 `transaction_at DESC, id DESC` 排序（时间倒序，稳定）。
- `limit` / `offset` 非法返回 400；`month` 非法格式或非法月份返回 400。
- `status` 仅接受单个 `posted` / `pending`；非法值、重复参数（数组）或 `status[]=` 数组形式均返回 400。
- `meta.total` 始终为「月份 + 状态」完整筛选条件下的计数，与列表同条件（同一 `WHERE`），不受分页影响。

#### 响应

```json
{
  "success": true,
  "data": [ "...交易对象..." ],
  "meta": { "total": 58, "limit": 50, "offset": 0 }
}
```

`meta.total` 为符合筛选条件的总条数，不受分页影响；无匹配时返回空数组且 `total=0`。

单个交易对象示例：

```json
{
  "id": 58,
  "account_id": 1,
  "direction": "expense",
  "amount_cents": 56306,
  "category": "住房",
  "merchant": "国家电网",
  "description": "日常消费",
  "transaction_at": "2026-10-30T06:42:00.000Z",
  "status": "pending",
  "created_at": "2026-10-21 10:58:40"
}
```

### GET /api/analytics/monthly

返回演示用户某上海自然月的账单统计（已入账收支、待入账、收入分类、支出分类）。

#### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| month | string | 是 | `YYYY-MM`，按上海时区自然月统计；缺失、非法格式或非法月份返回 400 |

#### 统计口径

- 只把 `status='posted'` 且 `transaction_at <= as_of`（截至请求时刻已发生）的交易计入已入账收入/支出/净收支与笔数；
- `pending`（待入账）不计入已入账，单独列出数量与金额；
- 未来时间却标记 `posted` 的记录不计入已发生；
- 按整个月全部符合条件的记录聚合，不受分页参数影响。

#### 响应

```json
{
  "success": true,
  "data": {
    "month": "2026-10",
    "timezone": "Asia/Shanghai",
    "as_of": "2026-10-21T12:14:52.610Z",
    "income_cents": 1580000,
    "expense_cents": 209096,
    "net_cents": 1370904,
    "posted_count": 13,
    "pending": { "count": 2, "amount_cents": 69413 },
    "income_by_category": [
      { "category": "收入", "amount_cents": 1580000, "count": 2 }
    ],
    "expense_by_category": [
      { "category": "住房", "amount_cents": 83959, "count": 2 }
    ]
  }
}
```

- `as_of` 为本次统计截止时刻（UTC ISO），与统计月份 `month` 明确区分；
- `income_by_category` 按收入金额倒序，仅统计已入账收入；合计恒等于 `income_cents`；
- `expense_by_category` 按支出金额倒序，仅统计已入账支出；合计恒等于 `expense_cents`；
- 无记录月份正常返回零值与空分类数组。

#### 说明

统计逻辑集中在 `backend/src/services/analytics.js`（`monthlyAnalytics`），HTTP 路由只负责参数校验、用户范围与响应；后续 AI 工具可直接复用同一服务函数。

### POST /api/assistant/chat

AI 助手对话接口：自然语言 → 模型工具调用 → 实际数据库查询 / 生成待确认转账单 → 回答与工具结果展示。仅开放只读工具与「生成转账单」工具，不开放任何扣款执行工具。

#### 请求体

```json
{ "message": "我的账户余额是多少？", "sessionId": "可选，服务端返回的会话标识" }
```

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| message | string | 是 | 用户消息，去空格后非空，最多 2000 字符 |
| sessionId | string | 否 | 上一次对话返回的 `sessionId`，用于追问（如「上个月呢？」）；不传则服务端新建会话 |

- 客户端**只能**提交 `message` 与 `sessionId` 两个字段；提交 `system`、`tool`、完整模型历史、`user_id` 等其他字段返回 400。
- 用户身份由服务端固定演示用户提供，不接受客户端切换。
- 同一会话同时只处理一个请求；并发请求返回 409。
- 会话与模型上下文由服务端持久化到 SQLite；刷新 / 后端重启可通过 `GET /api/assistant/current` 恢复当前对话。
  system 提示每次由服务端按当前上海时间生成，不持久化；不持久化任何交易密码 / 验证码 / TOTP 密钥 / 模型密钥 / 敏感请求体。

#### 响应

```json
{
  "success": true,
  "data": {
    "sessionId": "0d7c...-...",
    "reply": "您的人民币活期账户当前余额为 42,794.38 元。",
    "toolRecords": [
      { "name": "get_accounts", "args": {}, "status": "ok", "queryTime": "2026-10-21T12:30:00.000Z", "data": [ "账户列表（同 GET /api/accounts）" ] },
      { "name": "get_monthly_analytics", "args": { "month": "2026-10" }, "status": "ok", "queryTime": "...", "data": { "month": "2026-10", "...同 GET /api/analytics/monthly" } }
    ],
    "incomplete": false,
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
  }
}
```

- `reply`：最终自然语言回答。金额、笔数、分类等具体数值来自工具返回的真实查询结果，前端展示不得被 AI 文本覆盖。
- `toolRecords`：本次实际执行的工具记录。`status` 为 `ok` 时含 `data`（来自真实查询）；为 `error` 时含 `error`（工具被拒或执行失败，不含伪造数据）。
- `incomplete`：因达到模型调用或工具执行上限而提前结束时为 `true`，此时回答不完整，前端应如实提示而非当成成功结果。
- `usage`：本次模型调用 token 用量（供记录，不展示密钥）。

#### 工具白名单

| 工具 | 参数 | 说明 |
| ---- | ---- | ---- |
| get_accounts | 无 | 查询账户列表（复用 `listAccounts`） |
| get_monthly_analytics | `month`（YYYY-MM，严格校验） | 月度账单统计（复用 `monthlyAnalytics`） |
| search_transfer_recipients | `name`（字符串） | 按姓名 / 虚构联系方式搜索收款人，仅返回 `id`、姓名、掩码账户 |
| list_transfer_recipients | 无 | 列举当前用户常用收款人（复用 `listRecipients`，仅返回 `id`、姓名、掩码账户），用于「我的收款人有哪些」；只读，不建单 / 不改收款人 / 不动资金 |
| prepare_transfer | `recipient_id`、`amount_yuan`（字符串）、`remark`（可选）、`account_id`（可选） | 调用现有转账服务生成「待确认转账单」（不扣款） |
| get_transfer_status | `ref_no`（字符串） | 按操作编号查询转账单当前状态（以数据库为准） |
| get_cards | 无 | 查询本人银行卡列表（复用 `listCards`，含掩码卡号 / 卡类型 / 状态 / 日限额） |
| prepare_card_operation | `card_id`、`action`（freeze/unfreeze） | 调用银行卡操作服务生成「银行卡操作单」（不改状态）；冻结需点击确认、解冻需强验证 |
| get_card_operation_status | `ref_no`（字符串） | 按操作编号查询银行卡操作单当前状态（以数据库为准） |
| get_subscriptions | 无 | 查询本人订阅与代扣列表（复用 `listSubscriptions`，含商户 / 金额 / 周期 / 下次扣费日期 / 状态） |
| prepare_subscription_operation | `subscription_id`、`action`（pause/resume/cancel） | 调用订阅操作服务生成「订阅操作单」（不改状态）；暂停/取消需点击确认、恢复需强验证 |
| get_subscription_operation_status | `ref_no`（字符串） | 按操作编号查询订阅操作单当前状态（以数据库为准） |
| start_subscription_review | `month`（YYYY-MM，必填） | 启动跨场景「订阅审查」任务（分析该月支出 + 列出生效订阅，落到等待选择；仅此一条任务链） |

- 转账流程：先用 `search_transfer_recipients` 确认收款人；信息齐全且收款人明确后调用 `prepare_transfer` 生成草稿。
  「我的收款人有哪些 / 列出常用收款人」等列举需求用 `list_transfer_recipients`（只读，返回全部收款人的 `id`/姓名/掩码账户）；
  指定姓名查找仍用 `search_transfer_recipients`。
  金额参数用 `amount_yuan` 字符串（如 `"100.00"`），服务端用字符串拆分精确转换为整数分（拒绝负数、零、
  超过两位小数、科学计数法、超出安全整数范围；不采用浮点乘 100）。付款账户不唯一且用户未指定时先澄清。
- `prepare_transfer` 的 `data` 为转账单视图（同 `POST /api/transfers` 返回），前端据此渲染确认卡；
  确认卡上「确认 / 取消」按钮直接调用 `POST /api/transfers/:refNo/confirm` / `cancel`，不经过模型。
- `prepare_transfer` 的 `data` 额外含两个改单字段：
  - `previous`：若本次取消 / 涉及旧单，返回 `{ ref_no, status, cancelled }`，`status` 由服务端读取真实状态
    （`cancelled` / `completed` / `expired` / `needs_verification` / `failed`），不由模型推断；无旧单时为 `null`。
  - `notice`：后端根据旧单真实状态生成的确定性中文说明（如「已取消原待确认转账单…，并生成新的待确认转账单…」、
    「原转账单…已完成，未取消…」），前端以此为准展示改单结果，不用模型回复文字。
- 单条用户消息最多生成一张转账单，重复调用 `prepare_transfer` 会被拒绝；用户修改待确认金额 / 收款人时，
  服务端取消本会话旧的待确认单并生成新单，旧确认卡不可再执行。新单创建失败时返回错误并附加
  「原待确认转账单（…）未变更」，旧单保持原状。
- **不开放任何扣款执行工具**（如 `confirm_transfer`）；「确认」「我同意」「跳过验证」等聊天文字不会触发扣款。
- 银行卡操作：查询用 `get_cards`；冻结 / 解冻用 `prepare_card_operation`（只生成操作单，不改状态）。
  多张卡片时列出掩码卡号选项，不擅自选第一张；卡片模糊时先澄清。`prepare_card_operation` 的 `data` 含
  `notice` 与 `previous`（服务端读真实状态，语义同转账改单，`previous.status` 为 cancelled/completed/…）。
  用户提到「挂失 / 销卡 / 补卡 / 调额」时明确说明不支持，询问是否改用「临时冻结」，不替用户决定。
- **不开放任何执行 / 强验证工具**（如 `confirm_card_operation`、`verify_card_operation`）；聊天文字
  「确认」「我同意」不会冻结 / 解冻，只能提醒用户在界面确认卡上操作。
- 订阅与代扣：查询用 `get_subscriptions`；暂停 / 恢复 / 取消用 `prepare_subscription_operation`（只生成操作单，不改状态）。
  多项订阅时列出商户选项，不擅自选第一项；订阅模糊时先澄清。`prepare_subscription_operation` 的 `data` 含
  `notice` 与 `previous`（服务端读真实状态，语义同转账改单）。已取消（cancelled）的订阅不可再操作。
  **不开放任何执行 / 强验证工具**（如 `confirm_subscription_operation`、`verify_subscription_operation`）；
  聊天文字「确认」不会暂停 / 取消 / 恢复，只能提醒用户在界面确认卡上操作。
- 跨场景任务：仅支持一条任务链——「分析某月支出 → 列出生效订阅 → 用户选择一项 → 生成暂停单 → 界面确认 → 核验 → 汇总回执」，
  由 `start_subscription_review` 启动（仅接受 `month`，多余参数被拒）。模型只负责理解意图与提取月份，
  服务端用白名单节点构建任务图并校验依赖，**不执行模型生成的任意代码 / URL / SQL / 操作步骤**；
  模型不能代用户选择订阅，也不能仅凭聊天文字「确认」推进任务——选择与确认分别走 `POST /api/agent-tasks/:taskNo/select`
  与订阅操作单确认接口。其它任务组合（多场景任意编排）一律说明「不支持」。
- 未开放改余额、挂失、销卡、补卡、调额等写操作。未知工具、额外参数、非法 JSON、非法参数均被拒绝；
  模型不得传 `user_id`、SQL、文件路径或 URL。相对月份（「这个月 / 上个月」）由服务端按当前上海日期换算。

#### 错误码

| 状态码 | 含义 |
| ---- | ---- |
| 400 | 请求体非法 / 提交了非 `message`、`sessionId` 的字段 / message 为空或超长 |
| 409 | 该会话正在处理上一个请求 |
| 502 | 模型服务暂不可用（缺密钥时不会走到这里，见 503） |
| 503 | 未配置模型密钥（在 `backend/.env` 配置后重启后端） |
| 500 | 助手服务内部错误 |

错误响应不泄露密钥、原始异常、SQL、文件路径。

### GET /api/assistant/current

读取服务端「当前对话」用于刷新恢复（**只读**）。不调用模型、不重发消息、不修改任何数据；未配置模型密钥也可用。

```json
{
  "success": true,
  "data": {
    "sessionId": "0d7c...-...",
    "messages": [
      { "role": "user", "text": "我的账户余额是多少？", "toolRecords": null, "incomplete": false, "error": null },
      { "role": "assistant", "text": "...", "toolRecords": [ "本次工具执行记录" ], "incomplete": false, "error": null }
    ]
  }
}
```

- `sessionId`：当前会话标识；无当前对话时为 `null`。
- `messages`：用户可见消息（按顺序）。`role` 为 `user` / `assistant`；助手消息含 `toolRecords`（工具展示记录）、
  `incomplete`（是否因达到调用/工具上限而未完成）、`error`（失败说明，正常为空）。
- 历史消息为查询时的**快照**；转账 / 银行卡操作卡以其中的 `ref_no` 回读业务库**最新状态**，不会沿用历史里的旧状态。
- 不返回模型上下文（tool_calls / tool 原始消息）、system 消息、任何密码 / 验证码 / TOTP 密钥 / 模型密钥。

### POST /api/assistant/new

服务端切换「新建对话」：清除当前对话指针，刷新不再恢复旧对话。不删除历史、不修改业务数据、不调用模型。

```json
{ "success": true, "data": { "sessionId": null } }
```

- 请求体可留空（`{}`）。客户端仅能切换当前对话指针，不能传入 `user_id` 或会话内容。

### 模拟转账接口

模拟转账流程：创建转账单（不扣款）→ 查看详情 → 明确点击确认后才执行（扣款 + 入账流水 + 审计）。
风险级别由**后端**判定：`日累计成功转账金额 + 本次金额 ≤ 100000 分（¥1000）` 为黄色（可确认）；
超过为红色（需要交易密码 + 手机验证器动态码强验证）。这不是单笔金额判断。明确标注「模拟银行环境」，收款人为虚构数据。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/transfers/recipients` | 虚构收款人列表 |
| POST | `/api/transfers` | 创建转账单（不扣款） |
| GET | `/api/transfers/:refNo` | 查看转账单详情 |
| POST | `/api/transfers/:refNo/confirm` | 确认并执行（需 `{ "confirm": true }`） |
| POST | `/api/transfers/:refNo/cancel` | 取消转账单（不扣款） |
| POST | `/api/transfers/:refNo/verify` | 强验证确认（交易密码 + 动态验证码） |
| GET | `/api/verification/status` | 验证器绑定 / 锁定状态（只读） |

#### 创建转账单

请求体（仅允许以下字段，多余字段返回 400）：

```json
{ "recipient_id": 1, "amount_cents": 5000, "remark": "测试" }
```

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| recipient_id | integer | 是 | 收款人 id（来自收款人列表） |
| amount_cents | integer | 是 | 金额（分），正整数安全整数 |
| remark | string | 否 | 备注，最多 200 字符 |

- 金额必须为正整数安全整数；小数分、负数、NaN、超大数、非法类型均返回 400。
- 校验账户状态、余额、收款人归属；创建不扣款。
- 返回转账单视图：`ref_no`（唯一编号）、付款账户、收款人及掩码账户、金额、备注、
  `risk_level`（yellow / red）、`status`、`expires_at`（确认有效期，5 分钟）。

#### 确认转账

请求体仅允许 `{ "confirm": true }`；缺少或非 `true` 返回 400；携带其他字段（如 `amount_cents`、`recipient_id`）返回 400（不可重新指定金额或收款人）。

- 服务端从数据库读取原操作快照（付款账户、收款人、金额、备注），重新校验账户状态、余额、当日累计与有效期。
- 在同一事务内：扣款 → 写入已入账转账流水 → 更新状态为已完成 → 写审计。
- 重复确认 / 并发确认只执行一次，返回原回执（含 `transaction_id`）。
- 若确认时累计已过线进入红色，返回 409 要求强验证，不扣款。

#### 强验证确认（红色单）

请求体仅允许 `{ "password": "...", "totp": "..." }`；多余字段（如 `user_id`、`risk_level`、`verified`）返回 400。

- 仅限红色单（`needs_verification`）；黄色单不可走该接口（返回 409 提示直接确认）。
- 服务端重新校验：绑定状态、锁定状态、有效期、账户状态、余额、归属、当日累计；交易密码与动态验证码均正确后，
  在**同一事务**内消费 TOTP 时间步 + 扣款 + 入账流水 + 更新状态 + 审计，返回回执（含 `transaction_id`）。
- 防重放：同一时间步（30 秒）验证码跨单 / 并发 / 重启不可复用；已取消 / 已过期 / 已完成的单不可通过验证重新执行。
- 失败锁定：连续 5 次密码或验证码错误锁定 15 分钟（跨单 / 重启不失效，到期自动解锁）；失败计数独立于请求限流。
- 未绑定 / 缺加密密钥 / 解密失败时红色单保持阻断。

#### 验证器状态

`GET /api/verification/status` 只读返回 `{ bound, locked, locked_until, remaining_attempts }`，不含任何密码 / 密钥 / 验证码。

#### 状态流转

`pending`（待确认）→ `completed`（已完成）/ `cancelled`（已取消）/ `expired`（已过期）/ `failed`（失败）；
`pending` → `needs_verification`（累计过线转红）；`needs_verification` → `completed`（强验证通过）/
`cancelled`（可取消）/ `expired`（过期）。除到期外不允许任意跳转。

#### 流水口径

转账成功写入一条 `direction=expense`、`category=转账` 的已入账流水，`transfer_ref` 关联操作编号。
当前月度「支出」为账户流出口径，**包含转账**；转账不描述为商户消费。

### 银行卡操作接口

银行卡查询（只读）复用 `GET /api/cards`。临时冻结 / 解冻走「操作单」流程：创建操作单**不改变卡片状态**，
用户在界面明确点击确认（冻结）或交易密码 + 动态验证码强验证（解冻）后才执行。明确标注「模拟银行环境」，
仅改变卡片状态 `active ↔ frozen`，不改变余额、交易流水、订阅与日限额。正式挂失 / 销卡 / 补卡 / 调额本阶段不支持。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/card-operations` | 创建银行卡操作单（不改变卡片状态） |
| GET | `/api/card-operations/:refNo` | 查看操作单详情（含当前卡片状态） |
| POST | `/api/card-operations/:refNo/confirm` | 确认并执行冻结（需 `{ "confirm": true }`） |
| POST | `/api/card-operations/:refNo/cancel` | 取消操作单（不改变卡片状态） |
| POST | `/api/card-operations/:refNo/verify` | 强验证确认解冻（交易密码 + 动态验证码） |

#### 创建银行卡操作单

请求体（仅允许以下字段，多余字段返回 400）：

```json
{ "card_id": 1, "action": "freeze" }
```

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| card_id | integer | 是 | 银行卡 id（来自 `GET /api/cards`） |
| action | string | 是 | `freeze`（冻结）或 `unfreeze`（解冻） |

- 冻结：仅 `active → frozen`，风险等级 `yellow`、状态 `pending`（待确认）；
- 解冻：仅 `frozen → active`，风险等级 `red`、状态 `needs_verification`（需强验证）；
- 已注销（cancelled）卡、已处于目标状态的卡、未知状态一律拒绝（如实返回 400，不伪造成功）；
- 服务端校验卡片归属；创建不改变卡片状态，写入建单时卡片版本快照 `card_version`。

#### 确认冻结 / 取消

- 确认仅接受 `{ "confirm": true }`；从数据库重新读取卡片状态与版本，建单后卡片被改动
  （含「正常→冻结→正常」回环）的旧单不可执行（返回 409 `stale` / `failed`），不覆盖新状态；重复确认幂等返回原回执。
- 解冻单（`needs_verification`）不可通过普通确认接口执行（返回 409）。
- 取消不改变卡片状态；已完成 / 已失效的单不可取消。

#### 强验证解冻（红色单）

请求体仅允许 `{ "password": "...", "totp": "..." }`；多余字段（如 `user_id`、`risk_level`、`verified`）返回 400。

- 仅限解冻单（`needs_verification`）；交易密码 + TOTP 均正确后在**同一事务**内「消费时间步 + 更新卡片状态 + 审计」。
- 防重放与失败锁定复用转账强验证的同一套：`totp_used_steps` 的 `UNIQUE(user_id, step)` 保证
  「已用于转账的时间步不可再用于解冻，反之亦然」；`verification_failures` 以 `user_id` 为键，跨业务累计失败同样锁定 15 分钟。
- 未绑定 / 缺密钥 / 解密失败 / 已锁定时解冻保持阻断。

#### 状态流转

冻结：`pending` → `completed`（确认）/ `cancelled` / `expired` / `failed`（版本变化或状态已变）；
解冻：`needs_verification` → `completed`（强验证）/ `cancelled` / `expired` / `failed`。除到期外不允许任意跳转。

### 订阅操作接口

订阅查询（只读）复用 `GET /api/subscriptions`。暂停 / 取消 / 恢复走「操作单」流程：创建操作单**不改变订阅状态**，
用户在界面明确点击确认（暂停 / 取消）或交易密码 + 动态验证码强验证（恢复）后才执行。明确标注「模拟银行环境」，
仅改变订阅状态 `active ↔ paused / cancelled`，不改变余额、历史流水、金额、周期或原扣费日期，不代表取消真实商户合同、不实际发起扣费。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/subscription-operations` | 创建订阅操作单（不改变订阅状态） |
| GET | `/api/subscription-operations/:refNo` | 查看操作单详情（含当前订阅状态） |
| POST | `/api/subscription-operations/:refNo/confirm` | 确认并执行暂停 / 取消（需 `{ "confirm": true }`） |
| POST | `/api/subscription-operations/:refNo/cancel` | 取消操作单（不改变订阅状态） |
| POST | `/api/subscription-operations/:refNo/verify` | 强验证确认恢复（交易密码 + 动态验证码） |

#### 创建订阅操作单

请求体（仅允许以下字段，多余字段返回 400）：

```json
{ "subscription_id": 1, "action": "pause" }
```

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| subscription_id | integer | 是 | 订阅 id（来自 `GET /api/subscriptions`） |
| action | string | 是 | `pause`（暂停）/ `resume`（恢复）/ `cancel`（取消） |

- 暂停：仅 `active → paused`，风险等级 `yellow`、状态 `pending`（待确认）；
- 取消：`active` 或 `paused → cancelled`，风险等级 `yellow`、状态 `pending`（待确认）；
- 恢复：仅 `paused → active`，风险等级 `red`、状态 `needs_verification`（需强验证）；
- 已取消（cancelled）订阅为终态，本轮不支持重新开通；已处于目标状态、未知状态一律拒绝（如实返回 400，不伪造成功）；
- 服务端校验订阅归属与合法状态转换；风险级别由后端判定，客户端不能指定；创建不改变订阅状态，写入建单时订阅版本快照 `subscription_version`。

#### 确认暂停 / 取消

- 确认仅接受 `{ "confirm": true }`；从数据库重新读取订阅状态与版本，建单后订阅被改动
  （含「生效→暂停→生效」回环）的旧单不可执行（返回 409 `stale` / `failed`），不覆盖新状态；重复确认幂等返回原回执。
- 恢复单（`needs_verification`）不可通过普通确认接口执行（返回 409）。
- 取消不改变订阅状态；已完成 / 已失效的单不可取消。

#### 强验证恢复（红色单）

请求体仅允许 `{ "password": "...", "totp": "..." }`；多余字段（如 `user_id`、`risk_level`、`verified`）返回 400。

- 仅限恢复单（`needs_verification`）；交易密码 + TOTP 均正确后在**同一事务**内「消费时间步 + 更新订阅状态 + 审计」。
- 防重放与失败锁定复用转账强验证的同一套：`totp_used_steps` 的 `UNIQUE(user_id, step)` 保证
  「已用于转账 / 解冻的时间步不可再用于恢复，反之亦然」；`verification_failures` 以 `user_id` 为键，跨业务累计失败同样锁定 15 分钟。
- 未绑定 / 缺密钥 / 解密失败 / 已锁定时恢复保持阻断。

#### 状态流转

暂停 / 取消：`pending` → `completed`（确认）/ `cancelled` / `expired` / `failed`（版本变化或状态已变）；
恢复：`needs_verification` → `completed`（强验证）/ `cancelled` / `expired` / `failed`。除到期外不允许任意跳转。

### 跨场景任务接口

当前仅支持**一条**任务链：「分析某月支出 → 列出生效订阅 → 用户选择一项 → 准备暂停单 → 界面确认 → 核验执行结果 → 汇总回执」，
任务类型 `kind = subscription_review`。任务由 AI 助手工具 `start_subscription_review` 创建（或已存在任务），
后续通过下列接口推进。客户端不能指定任务类型、节点、依赖或任何业务步骤。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/agent-tasks/recent` | 最近任务列表（按更新时间倒序，轻量入口，便于新对话后继续查看） |
| GET | `/api/agent-tasks/:taskNo` | 查看任务详情（先对账再返回，刷新 / 后端重启可恢复） |
| POST | `/api/agent-tasks/:taskNo/select` | 选择要暂停的一项订阅（生成暂停操作单，不执行） |
| POST | `/api/agent-tasks/:taskNo/pause` | 暂停任务（后端阻断关联未执行操作单） |
| POST | `/api/agent-tasks/:taskNo/resume` | 继续任务（重新校验订阅 / 版本 / 操作单有效期） |
| POST | `/api/agent-tasks/:taskNo/cancel` | 取消任务（后端阻断关联未执行操作单；已确认变更不反向） |
| POST | `/api/agent-tasks/:taskNo/manual` | 转手动处理（复用已有订阅操作入口） |

#### 任务状态

`waiting_selection`（等待选择）/ `waiting_confirmation`（等待确认）/ `completed`（已完成）/ `failed`（失败）/
`paused`（已暂停）/ `cancelled`（已取消）/ `manual`（手动处理）。

#### 任务视图字段

```json
{
  "task_no": "task-…",
  "kind": "subscription_review",
  "status": "waiting_selection",
  "month": "2026-10",
  "selected_subscription_id": null,
  "selected_subscription": null,
  "op_ref": null,
  "op": null,
  "selectable_subscriptions": [ "生效订阅列表（以实时业务状态为准）" ],
  "result_summary": null,
  "failure_reason": "",
  "created_at": 1760000000000,
  "updated_at": 1760000000000,
  "completed_at": null,
  "nodes": [
    { "node_key": "monthly_analysis", "label": "月度支出分析", "status": "completed", "result": { "...月度统计..." }, "error": "" }
  ]
}
```

- `nodes` 依次为 7 个白名单节点：`monthly_analysis` / `subscription_query` / `await_selection` / `prepare_pause` /
  `await_confirmation` / `verify_result` / `summary`。只读节点（月度分析、订阅查询）自动执行；
  选择（await_selection）与确认（await_confirmation）等待用户在界面操作；`prepare_pause` 生成操作单但**不执行**。
- 月度分析与订阅查询结果带 `month` / `as_of` 快照标记，不冒充实时数据；选择时以业务库当前生效订阅为准。
- `result_summary` 为服务端生成的确定性回执（分析月份、该月支出、订阅每期金额、当前状态、操作编号与防误解提示）；
  不编造「长期未使用」或「节省金额」。

#### 选择订阅

请求体仅允许 `{ "subscription_id": 1 }`；多余字段返回 400。`subscription_id` 必须为正整数；服务端校验订阅归属与生效状态
（`active`），不信任快照。选择成功后生成「待确认暂停单」（复用 `POST /api/subscription-operations` 的暂停单规则，风险等级黄色），
任务转入 `waiting_confirmation`，订阅状态**不变**。

- 非 `waiting_selection` 状态返回 409；订阅不存在 / 非生效状态返回 400 / 404（如实说明）。
- 生成暂停单后，确认仍需在订阅操作单确认卡（`POST /api/subscription-operations/:refNo/confirm`）点击执行；
  聊天文字「确认」不推进任务。确认后任务由服务端对账（核验操作单 `completed` + 业务库订阅确实 `paused`）推进到 `completed`。

#### 暂停 / 继续 / 取消 / 转手动

- 四个接口请求体均不接受任何额外字段（`{}` 或空），多余字段返回 400。
- 暂停 / 取消 / 转手动会**在后端阻断**关联的未执行操作单（`cancelSubscriptionOperation`），而非仅隐藏前端按钮；
  若关联操作单已确认完成（确认与取消竞态），以事务结果为准：任务按真实结果对账为 `completed`，**不反向**已发生的订阅变更。
- 继续（resume）重新检查任务、订阅版本与操作单有效期；过期 / 失效单需重新生成并要求再次确认，不直接执行。
- 失败（failed）任务可「继续」回到等待选择，重新选择；已确认的订阅变更不会因任务取消 / 失败 / 转手动被自动反向。

### GET /api/activity

业务活动聚合列表（**只读**）：把当前用户四类真实业务记录——转账操作单、银行卡操作单、订阅操作单、
跨场景任务——合并为一条统一时间线，供「最近任务」页与 AI 工作区左侧「最近任务」共用。

事实来源为原业务表（`transfer_operations` / `card_operations` / `subscription_operations` / `agent_tasks`），
不拼接聊天 `toolRecords`、不生成新记录、不猜测会话关联；普通余额 / 状态 / 回执查询**不会**产生新记录。
跨场景任务通过选择订阅生成的关联订阅操作单（`agent_tasks.op_ref` 指向的订阅单）**不重复列出**，
避免同一暂停被误以为执行两次；独立的订阅操作正常列出。

#### 查询参数

| 参数 | 类型 | 默认 | 说明 |
| ---- | ---- | ---- | ---- |
| type | string | 无 | `transfer` / `card_op` / `subscription_op` / `task`；不传则全部 |
| status | string | 无 | 操作单或任务状态；支持逗号分隔多个状态（如 `pending,waiting_confirmation` 表示「待确认」合并筛选）；不传则全部 |
| limit | integer | 50 | 每页条数，1-100 |
| offset | integer | 0 | 偏移量，非负整数 |

- 结果按「创建时间倒序 + 类型固定序 + 编号」稳定排序，保证分页不重不漏。
- `type` 非法返回 400；`status` 必须为字符串，非字符串返回 400；`limit` / `offset` 非法返回 400。
- `status` 支持逗号分隔多个状态（在**分页之前**对全集生效，`meta.total` 与列表、页数一致）：
  独立操作单的 `pending`（待确认）与跨场景任务的 `waiting_confirmation`（等待确认）语义同属「等待界面确认」，
  前端「待确认」筛选项传 `status=pending,waiting_confirmation` 同时包含两类，仅改展示与筛选、不改数据库状态值。
- `meta.total` 为完整筛选条件下（`type` + `status`）的总条数，不受分页影响。

#### 响应

```json
{
  "success": true,
  "data": [
    {
      "key": "subscription_op:9f86bf9d-…",
      "kind": "subscription_op",
      "ref_no": "9f86bf9d-…",
      "task_no": null,
      "status": "completed",
      "action": "pause",
      "object": "Adobe 摄影计划",
      "amount_cents": 8800,
      "billing_cycle": "yearly",
      "month": null,
      "op_ref": null,
      "created_at": "2026-10-23T06:30:00.000Z",
      "updated_at": "2026-10-23T06:30:00.000Z",
      "completed_at": "2026-10-23T06:31:00.000Z"
    }
  ],
  "meta": { "total": 12, "limit": 50, "offset": 0 }
}
```

- `key` 为「类型 + 编号」唯一键（如 `transfer:…` / `card_op:…` / `subscription_op:…` / `task:…`），供前端去重与定位。
- `kind` 四类：`transfer`（转账）、`card_op`（银行卡）、`subscription_op`（订阅）、`task`（跨场景任务）。
- `ref_no` 为操作单编号（任务为 `null`）；`task_no` 为任务编号（非任务为 `null`）；二者必居其一。
- `object` 为摘要对象：转账收款人、银行卡掩码卡号、订阅商户、任务所选商户（未选则空）。
- `amount_cents` / `billing_cycle`：转账与订阅为金额（分）与周期（`monthly` / `yearly`）；银行卡操作与无金额任务为 `null`。
- `created_at` / `updated_at` / `completed_at` 统一为 UTC ISO 8601（操作单用 ISO，任务用 epoch 毫秒在服务端归一化后返回）。
- `status` 保留数据库原值（操作单与任务两套词汇并存），展示层仅做文案映射，不改语义；过期判定由各操作单详情读取时应用，聚合列表为只读不写。

## 错误处理

- 参数校验失败：HTTP 400，`{ "success": false, "message": "..." }`
- 路径不存在：HTTP 404，`{ "success": false, "message": "接口不存在" }`
- 服务器内部错误：HTTP 500，`{ "success": false, "message": "服务器内部错误" }`

错误响应不会返回 SQL、堆栈或数据库文件路径。
