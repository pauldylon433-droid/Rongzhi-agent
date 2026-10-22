# 开发日志

## 第二阶段：搭建最小可运行的前后端工程

日期：2026-10-21

### 一、本阶段创建 / 修改的文件

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `frontend/package.json` | Vite + Vue 脚手架生成，含启动脚本 |
| `frontend/vite.config.js` | 修改：新增 `/api` 代理到 `http://localhost:3000` |
| `frontend/index.html` | 修改：标题改为「融智 Agent」，语言改为 zh-CN |
| `frontend/src/App.vue` | 重写：融智 Agent 中文首页（产品名、副标题、五场景、开发中状态、检查后端连接按钮） |
| `frontend/src/style.css` | 重写：清理默认样式，改为简洁全局基础样式 |
| `frontend/src/main.js` | 脚手架生成，未改动 |
| `frontend/src/components/HelloWorld.vue` | 脚手架默认文件，当前未被引用 |
| `frontend/src/assets/`、`frontend/public/` | 脚手架默认资源 |

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `backend/package.json` | 新建：ES Modules，启动脚本 start/dev |
| `backend/src/index.js` | 新建：Express 服务，`GET /api/health`、404 与统一错误处理 |

#### 文档（docs/、根目录）

| 文件 | 说明 |
| ---- | ---- |
| `README.md` | 更新：补充真实启动步骤 |
| `docs/development-log.md` | 新建：本开发日志 |

### 二、安装的依赖

#### 前端

- 运行时：`vue ^3.5.44`
- 开发：`vite ^8.3.4`、`@vitejs/plugin-vue ^6.0.10`

#### 后端

- 运行时：`express ^5.3.0`
- 开发：`nodemon ^3.1.14`

> 说明：`npm audit` 报告后端存在 3 个 high 级漏洞，均来自 nodemon 的间接依赖（devDependencies）。不影响生产运行，暂未使用 `npm audit fix --force`（可能引入破坏性变更），留待后续评估。

### 三、运行命令

```bash
# 后端（端口 3000）
cd backend
npm install
npm run dev        # 或 npm start

# 前端（端口 5173）
cd frontend
npm install
npm run dev
```

### 四、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| 前端依赖安装 | ✅ 成功（35 packages，0 vulnerabilities） |
| 后端依赖安装 | ✅ 成功（express + nodemon） |
| 后端 `GET /api/health` | ✅ 返回 `{"success":true,"message":"服务正常","timestamp":"..."}` |
| 前端启动 | ✅ Vite ready，首页 HTTP 200，标题为「融智 Agent」 |
| 前端通过代理访问后端 | ✅ `GET /api/health`（经 5173 代理）返回 200，响应头含 `x-powered-by: Express` |

### 五、尚未完成的工作

- 五个业务场景的具体业务逻辑（转账、账单、卡片、订阅、跨场景联动）
- SQLite 数据库接入
- ECharts 图表
- 大模型接入（方案待定）
- 前端路由、组件拆分与状态管理
- 后端业务接口

---

## 第三阶段：SQLite 数据库与模拟数据初始化

日期：2026-10-21

- 新建 `backend/src/db/{connection,schema,seed,index}.js`：SQLite 文件库（better-sqlite3），6 张表 + 索引 + 约束。
- 新建 `backend/scripts/init-db.js`、`verify-db.js`：幂等初始化与独立临时库验证。
- 模拟数据：1 名用户「张三」、1 个 CNY 账户、1 张卡、58 笔交易（近 3 个月）、6 个订阅；金额一律整数分。
- 详细约定见 `docs/database-design.md`。

## 第四阶段：只读查询接口

日期：2026-10-21

- 新增 4 个只读接口：`GET /api/accounts`、`/api/transactions`（含 `month`/`limit`/`offset`）、`/api/cards`、`/api/subscriptions`。
- 单用户演示模式（服务端固定「张三」），全部参数化查询，卡片仅返回掩码卡号，错误不泄露 SQL/堆栈/路径。
- `node scripts/verify-api.js` 全部通过（21 项断言）。详细约定见 `docs/api.md`。

## 第五阶段：前端只读数据首页

日期：2026-10-21

### 一、本阶段创建 / 修改的文件

| 文件 | 说明 |
| ---- | ---- |
| `frontend/src/utils/format.js` | 新建：金额（分→元 + 千位分隔 + 两位小数）与日期（UTC→上海时区）格式化 |
| `frontend/src/api/index.js` | 新建：4 个只读接口的请求封装（统一校验响应、中文错误） |
| `frontend/src/composables/useAsyncData.js` | 新建：一次性只读请求的 loading/data/error 状态封装 |
| `frontend/src/components/SectionState.vue` | 新建：分区共用「加载 / 空 / 错误 + 重试」展示 |
| `frontend/src/components/AccountOverview.vue` | 新建：账户概览分区 |
| `frontend/src/components/TransactionList.vue` | 新建：交易流水分区（月份筛选 + 分页 + 竞态防护） |
| `frontend/src/components/CardList.vue` | 新建：银行卡分区 |
| `frontend/src/components/SubscriptionList.vue` | 新建：订阅与代扣分区 |
| `frontend/src/App.vue` | 重写：数据首页布局 + 品牌 + 「模拟银行环境」标识 + 五场景规划 |
| `frontend/src/style.css` | 重写：全局设计变量（深蓝/蓝/白）与共享样式（分区、徽章、按钮、状态） |

### 二、实现的功能

- **账户概览**：账户名、当前余额（分→元）、币种、状态（正常/冻结/已销户）。
- **交易流水**：
  - 月份筛选（默认当前上海月份，另有「全部月份」），切换月份回到第 1 页；
  - 每页 10 条，上一页 / 下一页，总条数来自 `meta.total`，据此控制按钮可用性；
  - 竞态防护：每次请求自增序号，仅最新请求写回，旧请求丢弃；
  - 收入显示 `+`（绿）/ 支出显示 `-`（红）；`posted`→「已入账」、`pending`→「待入账」；
  - 时间按 Asia/Shanghai 展示。
- **银行卡**：掩码卡号、卡类型、状态（正常/冻结/已注销）、单日限额（分→元）。
- **订阅与代扣**：商户、金额、周期（按月/按年）、下次扣费日期、状态（生效/暂停/已取消）；
  已取消的订阅显示「已取消，不再扣费」，不把历史日期当成仍将扣费。
- 每个分区均有独立的加载 / 空 / 错误 + 重试状态；未知状态显示兜底文字（不会误判为正常）。
- 保留品牌与「模拟银行环境 · 数据仅供演示」标识，响应式适配电脑与手机。
- 未实现的能力在「业务场景规划」中标注为「规划中」。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `npm run build` | ✅ 通过（25 模块，无报错） |
| 经 Vite 代理(5173) 访问 4 个只读接口 | ✅ 全部返回正确数据 |
| 账户余额字段 | ✅ `balance_cents=4233109` 渲染为 `¥42,331.09`（非硬编码） |
| 交易分页与月份 | ✅ 全部月份 total=58（6 页）；10 月 total=19（2 页，第 2 页 9 条）；9 月 23、8 月 16 |
| 浏览器可视布局 | ⚠️ 未做（当前为命令行环境，无浏览器；仅验证构建与代理数据链路） |

### 四、尚未完成的工作

- 月度统计 / 图表（本阶段按要求未做）
- 智能转账、卡片/订阅管理操作、跨场景联动（均为规划中，仅展示数据）
- 大模型接入（方案待定）
- 前端路由与状态管理（当前单页，未引入 Vue Router / Pinia）

---

## 第六阶段：交易月份筛选起点调整为「账户开户月份」

日期：2026-10-21

### 一、背景与改动

原月份选择器以「最近六个月」为范围。本次改为以**账户开户日期**为筛选起点，范围「开户月份 → 当前上海月份」。

- 新增业务日期字段（区别于 `created_at`）：
  - 账户 `opened_on`（开户日期）、银行卡 `issued_on`（开卡日期），均为 `YYYY-MM-DD`；
  - 演示数据统一为 `2026-08-01`（明确的模拟业务日期）。
- 增量迁移：`backend/src/db/migrate.js`（幂等），对存量库补列并回填 `2026-08-01`；不删库、不清空、不重建交易、不改余额。
- 查询接口 `GET /api/accounts`、`/api/cards` 返回 `opened_on` / `issued_on`。
- 前端 `TransactionList.vue`：根据接口返回的开户月份动态生成「年份 + 月份」选项（开户月 → 当前月），不写死 `2026-08`；保留「全部月份」、默认当前月、切换回第 1 页、分页与竞态防护；开户日期缺失或加载失败时给出明确提示，不回退到 `created_at`。

### 二、本阶段创建 / 修改的文件

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/db/schema.js` | accounts 增 `opened_on`、cards 增 `issued_on` |
| `backend/src/db/seed.js` | 种子数据写入 `opened_on` / `issued_on` = 2026-08-01 |
| `backend/src/db/migrate.js` | 新建：幂等增量迁移 + 回填 |
| `backend/src/db/index.js` | 初始化流程接入 migrate |
| `backend/src/db/connection.js` | 增加 `busy_timeout = 5000` |
| `backend/src/services/accounts.js`、`cards.js` | SELECT 返回业务日期字段 |
| `backend/scripts/verify-db.js`、`verify-api.js` | 增加业务日期断言 |
| `backend/scripts/verify-migrate.js` | 新建：迁移幂等性与数据不变验证 |
| `frontend/src/components/TransactionList.vue` | 年月双选择控件 + 开户月份起点 + 缺失/失败提示 |
| `docs/api.md`、`docs/database-design.md` | 补充业务日期字段与迁移说明 |

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-migrate.js` | ✅ 8/8 通过（补列、回填、幂等、数据不变） |
| `node scripts/verify-db.js` | ✅ 20/20 通过（含开户/开卡日期断言） |
| `node scripts/verify-api.js` | ✅ 23/23 通过（含 opened_on / issued_on 断言） |
| 开发库增量迁移 | ✅ `opened_on` / `issued_on` = 2026-08-01，余额 4233109 未变，交易 58、订阅 6 未变 |
| 运行中后端返回业务日期 | ✅ `/api/accounts` 含 `opened_on`、`/api/cards` 含 `issued_on` |
| `npm run build` | ✅ 通过（25 模块，无报错） |

---

## 第七阶段：月度账单分析基础能力

日期：2026-10-21

### 一、本阶段创建 / 修改的文件

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/services/analytics.js` | 新建：月度统计服务函数 `monthlyAnalytics`（可复用，供后续 AI 工具调用） |
| `backend/src/routes/analytics.js` | 新建：`GET /api/analytics/monthly`（仅参数校验 + 用户范围） |
| `backend/src/routes/index.js` | 注册 `/analytics` 路由 |
| `backend/scripts/verify-analytics.js` | 新建：独立临时库 + 已知金额小数据的验证脚本 |
| `frontend/src/composables/useMonthRange.js` | 新建：月份范围组合式函数（开户月份 → 当前月份，供交易流水与账单分析复用） |
| `frontend/src/components/TransactionList.vue` | 改用 `useMonthRange`，消除重复筛选逻辑（分页与竞态防护不变） |
| `frontend/src/components/MonthlyAnalytics.vue` | 新建：月度账单分析分区（统计卡片 + 分类表格 + 待入账提示） |
| `frontend/src/api/index.js` | 新增 `fetchMonthlyAnalytics` 请求封装 |
| `frontend/src/App.vue` | 引入月度账单分析分区 |
| `docs/api.md`、`docs/development-log.md` | 补充接口文档与本日志 |

### 二、统计口径

- 已入账：`status='posted'` 且 `transaction_at <= as_of`（截至请求时刻已发生）；`pending` 不计入，单独列出。
- 未来时间却标记 `posted` 的记录不计入已发生；按整个月全部记录聚合，不受分页影响。
- 按 Asia/Shanghai 自然月（左闭右开）；无记录返回零值与空分类。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-analytics.js` | ✅ 22/22 通过（收支/净额/分类准确、pending 隔离、月初与下月月初边界、未来排除、空月、非法月份 400、其他用户隔离） |
| `node scripts/verify-api.js` / `verify-db.js` / `verify-migrate.js` | ✅ 全部通过（无回归） |
| `npm run build` | ✅ 通过（28 模块，无报错） |
| Vite 代理(5173) 访问 `/api/analytics/monthly` | ✅ 正常返回数据 |

### 四、发现的数据异常（不修改数据）

开发库存在 **4 笔「未来时间却标记 posted」的模拟记录**（均为 2026-10-24 ~ 10-28 的支出，而今天是 10-21）：

| id | 分类 | 金额（分） | transaction_at |
| -- | ---- | ---- | ---- |
| 53 | 住房 | 8679 | 2026-10-24T00:17Z |
| 54 | 餐饮 | 3910 | 2026-10-24T01:27Z |
| 55 | 订阅扣费 | 3115 | 2026-10-28T04:05Z |
| 56 | 购物 | 30625 | 2026-10-28T09:48Z |

按口径这 4 笔（合计 46329 分）不计入 10 月已入账支出，已在统计中排除；未修改数据库。

---

## 第八阶段：数据一致性修复（未来 posted 交易）

日期：2026-10-21

### 一、问题

第七阶段发现的 4 笔「未来时间却标记 posted」交易（id 53-56，合计 46329 分）被计入账户余额，但月度统计按「截至请求时刻已发生」排除了它们，导致余额 4233109 分与已入账流水不一致（差额 46329 分）。

### 二、修复内容

- `backend/scripts/fix-future-posted.js`（新建）：一次性、可重复执行的修复脚本。
  - 先核对实际「未来 posted」记录是否与报告一致（按内容签名，不盲目按 id 修改），不符则停止；
  - 用 SQLite `backup()` API 创建一致性备份（正确处理 WAL）；
  - 在同一事务内将这 4 笔改为 `pending`，并按「期初余额 + 截至当前时刻已入账流水」重新核算余额（不简单加回固定金额）；
  - 重复执行不再改变余额，不删除任何交易。
- `backend/src/db/seed.js`：新增规则——未来时间（相对种子运行时刻）的交易统一标记为 `pending`，避免新库再出现未来 posted。
- `backend/scripts/verify-fix.js`（新建）：独立临时库验证首次修复、重复执行、首次初始化的一致性。

### 三、修复记录

- 一致性备份：`backend/data/backups/rongzhi.pre-fix-20261021123049906.db`
- 修复结果：余额 4233109 → 4279438 分；交易总数 58 不变；待入账 2 → 6 笔（69413 → 115742 分）；10 月已入账收入/支出/净额/13 笔不变；无未来 posted 残留。

### 四、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-fix.js` | ✅ 11/11 通过（首次修复余额/待入账/无未来 posted、重复执行不变、首次初始化余额一致） |
| `node scripts/verify-db.js` / `verify-api.js` / `verify-migrate.js` / `verify-analytics.js` | ✅ 全部通过（无回归） |
| 首次初始化（种子修复后）余额 | ✅ 4279438（与修复后开发库一致） |

---

## 第九阶段：只读 AI 助手（自然语言 → 模型工具调用 → 真实查询 → 回答与展示）

日期：2026-10-21

### 一、本阶段创建 / 修改的文件

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/config.js` | 修改：模块加载时自动从固定 `backend/.env` 读取密钥（不再要求调用方显式 `loadEnvFile`），供服务与冒烟脚本共享 |
| `backend/src/lib/ai-client.js` | 新建：可复用模型调用模块 `chatCompletions`（Chat Completions、`stream:false`、顶层 `thinking:{type:"disabled"}`、`max_tokens` 独立配置、超时覆盖请求+响应读取、不重试、脱敏错误 `AiError`） |
| `backend/src/services/assistant.js` | 新建：助手核心（两工具白名单、服务端固定用户、会话 + 过期 + 历史上限、工具调用循环、模型/工具执行上限、按「轮」裁剪历史） |
| `backend/src/routes/assistant.js` | 新建：`POST /api/assistant/chat` 路由 + 请求体校验（只允许 message/sessionId） |
| `backend/src/routes/index.js` | 修改：注册 `/assistant` 路由 |
| `backend/scripts/ai-check.js` | 修改：改用 `ai-client` 复用调用逻辑（去掉显式 loadEnvFile） |
| `backend/scripts/verify-assistant.js` | 新建：mock 模型确定性验证（44 项断言） |
| `backend/scripts/smoke-assistant-live.js` | 新建：真实 DeepSeek 冒烟测试（临时库，3 条问题，比对查询服务结果） |

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `frontend/src/api/index.js` | 修改：新增 `chatAssistant` 请求封装 |
| `frontend/src/components/AssistantPanel.vue` | 新建：AI 助手分区（消息列表 / 输入发送 / 示例问题 / 新对话 / 工具记录 / 结果卡片） |
| `frontend/src/App.vue` | 修改：在账户概览与月度分析之间引入助手分区 |

#### 文档

| 文件 | 说明 |
| ---- | ---- |
| `docs/api.md` | 补充 `POST /api/assistant/chat` 接口文档 |
| `docs/development-log.md` | 本日志 |
| `docs/ai-usage.md` | 新建：AI 用量记录（真实模型测试次数与 token） |

### 二、实现要点

- **只读两工具**：`get_accounts`（无参）、`get_monthly_analytics`（`month` YYYY-MM 严格校验，复用 `monthlyAnalytics`）。未开放转账/改余额/挂失/取消订阅。
- **安全边界**：模型只能通过工具拿数据，禁止传 `user_id`、SQL、文件路径、URL；未知工具 / 额外参数 / 非法 JSON / 非法月份均被拒；客户端不能提交 system、tool 结果、完整历史。
- **工具循环**：一条用户消息最多 4 轮模型请求、6 次工具执行；正确回传 `tool_call_id` 并保留 assistant tool_calls；达到上限返回 `incomplete:true`（不伪造成功）。
- **会话**：服务端生成（30 分钟过期 + 最多 8 轮历史），支持「这个月花了多少？→ 上个月呢？」追问；相对月份按服务端上海日期换算；同一会话同时只处理一个请求（409）。
- **前端**：只展示真实工具记录（名称 / 校验后参数 / 成功失败 / 后端查询时间）与结果卡片（整数分 + 前端格式化）；AI 文本不能覆盖卡片数值；纯文本渲染（无 v-html）；发送中禁用防重复；错误时不做假回答。

### 三、验证结果（真实执行）

#### mock 模型（`node scripts/verify-assistant.js`）

✅ **44/44 通过**：正常多工具往返、未知「transfer」工具拒绝且不写库、额外参数/非法月份/非法 JSON 拒绝、模型调用上限（4）、工具执行上限（6）、会话过期、上下文追问、并发锁、`parseChatBody` 伪造字段拒绝、HTTP 400 边界（临时库 + 独立端口）。

#### 回归脚本

✅ `verify-db.js` / `verify-api.js` / `verify-migrate.js` / `verify-analytics.js` / `verify-fix.js` 全部通过（无回归）。

#### 真实 DeepSeek（`node scripts/smoke-assistant-live.js`）

✅ **3/3 通过**，工具结果与查询服务逐一比对一致：

| 用户问题 | 工具调用 | 比对结果 |
| ---- | ---- | ---- |
| 我的账户余额是多少？ | get_accounts | ✅ balance=4279438 与账户服务一致 |
| 这个月支出最多的是哪一类？ | get_monthly_analytics(2026-10) | ✅ 收入1580000 / 支出209096 / 净1370904 一致 |
| 上个月呢？ | get_monthly_analytics(2026-09) | ✅ 收入1280000 / 支出193944 / 净1086056 一致（追问上下文生效） |

#### 前端构建

✅ `npm run build` 通过（30 模块，无报错）。

### 四、已知限制

- 助手功能依赖真实模型密钥，未配置时接口返回 503；**需重启后端**才能加载新配置与新增路由。
- 会话保存在内存，后端重启即失效；未做登录认证（沿用单用户演示模式）。
- 模型回答口径（如「支出最多分类」的金额四舍五入到分）以工具返回数据为准；卡片数值始终来自真实查询。
- 命令行环境无浏览器，前端分区仅验证了构建与接口数据链路，未做浏览器可视验收。

---

## 第十阶段：模拟小额转账及安全确认

日期：2026-10-21

### 一、本阶段创建 / 修改的文件

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/lib/shanghai.js` | 新增 `shanghaiNowParts`、`shanghaiDayRange`（上海自然日左闭右开边界） |
| `backend/src/db/schema.js` | `transactions` 增 `transfer_ref`；新增 `transfer_recipients`、`transfer_operations` 两张表及索引 |
| `backend/src/db/migrate.js` | 增量迁移：补 `transactions.transfer_ref` 列、唯一关联索引、`transfer_recipients` 为空时写入 4 条虚构收款人（幂等） |
| `backend/src/services/transfers.js` | 新建：转账服务（创建 / 查看 / 确认 / 取消、风险判定、日累计、防重复、审计） |
| `backend/src/routes/transfers.js` | 新建：转账路由（收款人 / 创建 / 查看 / 确认 / 取消 + 字段白名单校验） |
| `backend/src/routes/index.js` | 注册 `/transfers` 路由 |
| `backend/scripts/backup-db.js` | 新建：可复用一致性备份脚本（`db.backup()`） |
| `backend/scripts/verify-transfers.js` | 新建：独立临时库 61 项断言验证 |

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `frontend/src/utils/format.js` | 新增 `yuanToCents`（字符串拆分，避免浮点乘 100） |
| `frontend/src/api/index.js` | 新增 5 个转账接口请求封装 |
| `frontend/src/composables/useDataRefresh.js` | 新建：全局刷新信号，转账成功后联动刷新 |
| `frontend/src/components/TransferPanel.vue` | 新建：模拟转账分区（收款人选择 / 金额 / 备注 / 确认详情卡 / 回执） |
| `frontend/src/components/AccountOverview.vue`、`TransactionList.vue`、`MonthlyAnalytics.vue` | 监听刷新信号，转账成功后一致刷新 |
| `frontend/src/App.vue` | 引入转账分区，更新场景状态与说明 |

#### 文档

| 文件 | 说明 |
| ---- | ---- |
| `docs/api.md` | 新增模拟转账接口文档 |
| `docs/database-design.md` | 新增两张表、`transfer_ref`、迁移与验证说明 |
| `docs/security-design.md` | 新建：安全设计（身份 / 金额 / 风险 / 防重复 / 防篡改 / 未实现能力） |
| `docs/development-log.md` | 本日志 |

### 二、实现要点

- **风险判定（后端决定）**：`日累计成功转账 + 本次金额 ≤ 100000 分` 为黄色（待确认），超过为红色（需强验证，不执行）；非单笔判断。
- **状态机**：pending / needs_verification / completed / cancelled / expired / failed，除到期外不允许任意跳转。
- **防重复**：同一事务内扣款 + 入账流水 + 更新状态 + 审计；状态 CAS（`WHERE status='pending'`）+ `transfer_ref` 唯一索引双重保证；余额 `balance_cents >= ?` 守卫防止负数。
- **确认不可篡改**：确认只接受 `{ confirm: true }`，从数据库读原快照，不接受重新指定金额 / 收款人。
- **流水口径**：转账成功写入 `direction=expense`、`category=转账`、`transfer_ref=操作编号` 的已入账流水；月度「支出」为账户流出口径，包含转账，不描述为商户消费。
- **AI 助手保持只读**：工具白名单未增转账工具。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-transfers.js` | ✅ 61/61 通过（创建不扣款、黄色确认扣款入账、防重复、取消 / 过期 / 余额不足 / 异常账户、1000 元边界与累计跨过、上海跨日重置、确认时重新判累计、归属与篡改、红色无法普通确认、HTTP 字段校验、转账后余额与流水一致） |
| `node scripts/verify-db.js` | ✅ 通过（无回归） |
| `node scripts/verify-assistant-session.js` | ✅ 通过（无回归） |
| 开发库增量迁移（只读核对） | ✅ `transfer_recipients`、`transfer_operations` 存在，`transfer_ref` 列存在，4 条收款人、唯一索引就位，余额与流水未变 |
| `npm run build`（前端） | ✅ 通过（33 模块，无报错） |
| 浏览器可视验收 | ⚠️ 未做（命令行环境，仅验证构建与接口数据链路） |

### 四、一致性备份

- `backend/data/backups/rongzhi.pre-transfer-20261021132830203.db`（结构变更前创建）。

### 五、尚未实现

- 红色转账的**强验证**流程（本阶段只提示「需要强验证，本阶段尚未开放」，不执行）。
- **正式登录认证**（仍为单用户演示模式）。

### 六、重启与验收步骤

后端以 `npm run dev`（nodemon）运行会随源码改动自动重启并执行增量迁移，无需手动重启；
若以 `npm start` 运行则需重启以加载新增路由与迁移。前端 `npm run dev` 热更新。
验收：打开前端 → 「模拟转账」分区 → 选择收款人、输入金额 → 生成转账单 → 黄色点「确认转账」
（余额 / 流水 / 月度统计同步刷新），红色只显示强验证提示、无普通确认入口。

### 七、全轮实际耗时

约 17 分钟（21:24:22 → 21:41:06 +0800）。

## 第十一阶段：自然语言转账（AI 助手接入现有模拟转账）

本轮将自然语言入口接入已有模拟转账：用户自然语言描述转账 → AI 识别与必要追问 → 调用已有转账服务生成「待确认转账单」→ 聊天中展示真实确认卡 → 用户点击确认 → 调用现有确认接口执行 → 展示真实回执并刷新余额 / 流水 / 统计。手动转账入口保留为辅助入口。

### 一、修改与新增

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/lib/money.js` | 新建：`yuanToCents` 服务端元 → 整数分（字符串拆分，拒绝负数 / 零 / 超两位小数 / 科学计数法 / 超出安全范围） |
| `src/services/transfers.js` | `createTransfer` 增加可选 `fromAccountId`（默认仍自动选唯一账户，校验 / 扣款 / 审计逻辑不变） |
| `src/services/assistant.js` | 工具白名单新增 `search_transfer_recipients`、`prepare_transfer`、`get_transfer_status`；更新系统提示（支持生成转账单，执行需界面确认）；单条消息最多一张单；会话维护待确认单引用，修改请求自动取消旧单 |
| `scripts/verify-assistant-transfer.js` | 新建：mock 模型 + 独立临时库验证（72 项检查） |
| `scripts/smoke-assistant-transfer-live.js` | 新建：真实模型冒烟（3 条用户消息，独立临时库，不自动确认） |

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/components/TransferConfirmCard.vue` | 新建：共享确认卡（手动入口与聊天入口复用同一套确认 / 取消 / 回执规则，挂载时回读数据库最新状态） |
| `src/components/TransferPanel.vue` | 改用共享确认卡，保留手动入口作为辅助入口 |
| `src/components/AssistantPanel.vue` | 新增收款人匹配、转账确认卡、转账状态卡渲染；确认后联动刷新；更新示例与说明文案 |

#### 文档

| 文件 | 说明 |
| ---- | ---- |
| `docs/api.md` | 新增 AI 工具白名单与转账对话行为说明 |
| `docs/security-design.md` | 更新「AI 助手安全边界」 |
| `docs/ai-usage.md` | 新增真实模型转账冒烟用量 |
| `docs/development-log.md` | 本日志 |

### 二、实现要点

- **复用转账服务**：`prepare_transfer` 直接调用 `createTransfer`，确认按钮直接调用 `POST /api/transfers/:refNo/confirm`，未重写扣款 / 权限 / 审计逻辑。
- **金额转换**：`amount_yuan` 字符串 → 整数分，服务端字符串拆分，不浮点乘 100。
- **单条消息一张单**：`prepare_transfer` 在单条用户消息内最多成功一次，重复调用被拒。
- **修改请求**：会话记录当前待确认单引用，再次 `prepare_transfer` 时取消旧单（幂等），旧确认卡不可再执行。
- **不开放扣款工具**：白名单无 `confirm_transfer`；「确认 / 我同意 / 跳过验证」等文字不触发扣款。
- **确认卡从结构化数据渲染**：不解析 AI 文字里的金额 / 操作编号；卡片挂载时回读数据库最新状态，过期 / 取消 / 已完成不可再执行。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-assistant-transfer.js`（mock） | ✅ 72/72 通过 |
| `node scripts/verify-transfers.js` | ✅ 61/61 通过（无回归） |
| `node scripts/verify-assistant.js` | ✅ 通过（无回归） |
| `node scripts/verify-assistant-session.js` | ✅ 通过（无回归） |
| `node scripts/verify-db.js` | ✅ 通过（无回归） |
| `node scripts/smoke-assistant-transfer-live.js`（真实模型） | ✅ 通过（3 条消息；prompt 16960 / completion 831 / total 17791） |
| `npm run build`（前端） | ✅ 通过（35 模块，无报错） |
| 浏览器可视验收 | ⚠️ 未做（命令行环境，仅验证构建与接口数据链路） |

### 四、已知限制

- 红色转账的强验证流程仍未实现（只提示，不执行）。
- 正式登录认证仍未实现（单用户演示模式）。
- 真实模型修改请求时，回复文字可能仍称旧单「待确认」（模型未重新查询旧单状态）；界面确认卡以数据库为准，会显示旧单已取消。

### 五、重启与验收步骤

后端以 `npm run dev`（nodemon）运行会随源码改动自动重启并执行增量迁移；若以 `npm start` 运行则需重启。前端 `npm run dev` 热更新。
验收：打开前端 → 「AI 助手」分区 → 输入「给李雷转100元，备注还饭钱」→ AI 生成待确认转账单并展示确认卡 → 黄色点「确认转账」（余额 / 流水 / 月度统计同步刷新）；红色只显示强验证提示；「手动转账」分区仍可作为辅助入口。

### 六、全轮实际耗时

约 15 分钟（21:51:09 → 22:05:56 +0800）。

---

## 第十二阶段：修复自然语言转账「旧单状态文案与数据库不一致」

日期：2026-10-21

### 一、问题

改单时（如把 100 元待确认转账改为 200 元），后端已把旧单取消、新建新单，但模型回复文字仍可能称旧单「待确认」——因为模型没有重新查询旧单状态，而是凭记忆推断。这导致「AI 文字、两张卡片、数据库」三者不一致。根因是**状态文案由模型生成**，而非由后端依据真实结果生成。

### 二、修复方式（结构化 + 确定性文案，不靠加强提示词）

1. **工具结果返回结构化旧 / 新单状态**：`prepare_transfer` 返回新增 `previous`（旧单 `ref_no` + 服务端读取的真实 `status` + `cancelled`）与 `notice`（后端生成的确定性说明），`status` 一律由服务端 `cancelTransfer` / 数据库读取，不由模型推断。
2. **确定性文案由后端生成**：新增 `buildTransferNotice(previous, newRefNo)`，按旧单真实状态生成「已取消 / 已完成未取消 / 已过期未取消 / 需强验证未取消 / 已失败未取消」等固定文案。
3. **创建失败如实说明**：新单创建失败时抛出错误并附加「原待确认转账单（…）未变更」，绝不声称新单已生成；旧单已完成时 `previous.status='completed'`、`cancelled=false`，文案为「已完成，未取消」。
4. **前端旧卡自动回读**：新增 `useTransferSignal`（模块级 `ref` + `version`），改单成功后通知旧单 `ref_no`，已挂载的共享确认卡 `watch(version)` 自动回读数据库最新状态，无需手动刷新即可显示「已取消」；后端仍以状态 CAS 拒绝确认已取消的旧单（不只靠前端禁用按钮）。
5. **系统提示收敛**：规则改为「查询状态用 get_transfer_status、以数据库为准；描述改单结果以 `previous` / `notice` 为准，不要凭记忆猜测旧单状态」。

### 三、本阶段创建 / 修改的文件

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/services/assistant.js` | `prepare_transfer` 返回 `previous` / `notice`；创建失败附加「原单未变更」；新增 `refTail` / `buildTransferNotice`；更新系统提示规则 5 |
| `backend/scripts/verify-assistant-transfer.js` | 新增 M/N/O 三组断言（结构化状态正确、创建失败如实说明、已完成不可改 / 取消） |
| `frontend/src/composables/useTransferSignal.js` | 新建：转账单状态变更信号 |
| `frontend/src/components/TransferConfirmCard.vue` | 确认 / 取消成功后 `notifyChange`；`watch(version)` 自动回读 |
| `frontend/src/components/AssistantPanel.vue` | 渲染 `notice` 权威文案；改单后通知旧单卡片回读；新增 `.transfer-notice` 样式 |
| `docs/development-log.md` | 本日志 |

### 四、验证结果（真实执行，mock 模型 + 临时库）

| 验证项 | 结果 |
| ------ | ---- |
| `node scripts/verify-assistant-transfer.js`（mock） | ✅ 80/80 通过（含新增 M/N/O） |
| 其中 M：改单返回结构化旧单（cancelled）+ 新单（pending + 金额 20000 分）+ 确定性文案 | ✅ 即使模型回复文字给出错误旧状态，结构化状态仍正确；改单本身不扣款；旧单确认被拒且余额不变 |
| 其中 N：新单创建失败（余额不足） | ✅ error 说明「创建失败 + 余额不足 + 原单未变更」，旧单仍待确认，未生成新单 |
| 其中 O：旧单已完成 | ✅ `previous.status=completed`、文案「已完成，未取消」、旧单仍 completed、不可取消 |
| `node scripts/verify-transfers.js` | ✅ 61/61 通过（无回归） |
| `node scripts/verify-assistant.js` | ✅ 通过（无回归） |
| `node scripts/verify-assistant-session.js` | ✅ 通过（无回归） |
| `node scripts/verify-db.js` | ✅ 通过（无回归） |
| `npm run build`（前端） | ✅ 通过（36 模块，无报错） |
| 开发库业务数据 | 未修改；未调用收费模型 |
| 浏览器可视验收 | ⚠️ 未做（命令行环境，仅验证构建与接口数据链路） |

### 五、网页验收步骤

1. 打开前端「AI 助手」分区，输入「给李雷转100元」，生成第一张待确认转账单（记录其操作编号 A）。
2. 继续输入「改成给韩梅梅转200元」：
   - 顶部出现黄色确定性提示「已取消原待确认转账单（A…），并生成新的待确认转账单（B…）」；
   - 新单卡片显示「待确认转账」，金额 200 元；
   - **旧单卡片 A 无需手动刷新**，自动变为「已取消」，且「确认转账 / 取消」按钮消失、不可再执行。
3. 点击新单 B 的「确认转账」：显示成功回执，余额 / 流水 / 月度统计同步刷新，且仅扣 200 元（不再扣 100 元）。
4. 反向核对：若旧单已「已完成」，改单时提示为「已完成，未取消」，旧单不会被取消。
5. 「手动转账」分区仍可作为辅助入口，确认 / 取消 / 回执与聊天入口一致。

### 六、已知限制

- 红色转账强验证流程、正式登录认证仍未实现（延续既有范围，本轮不扩展）。

---

## 第十三阶段：人工验收里程碑 + 代码基线 / 数据库备份

日期：2026-10-21

本轮不新增业务功能，只做版本记录与备份。

### 一、已人工验收（用户网页验收通过）

- 数据查询、月份筛选与分页；
- 月度账单分析及只读 AI 查询；
- 手动模拟小额转账与红色拦截；
- 自然语言生成转账单；
- 修改请求后旧单取消、新单正确（旧卡自动显示已取消，无需刷新）；
- 聊天文字「确认」不扣款；
- 确认卡按钮执行后只扣一次并同步刷新余额 / 流水 / 统计。

### 二、仍未完成（区分边界，本轮不扩展）

- 红色转账强验证流程；
- 正式登录认证；
- 完整卡片管理、订阅管理；
- 跨场景联动；
- 最终参赛材料。

### 三、代码基线（本地 Git）

- 在项目根目录 `git init` 初始化本地仓库（此前非 Git 仓库）。
- 新增根 `.gitignore`，增量完善 `backend/.gitignore`：排除 node_modules、dist、`.env` 及 `.env.*.local`（保留 `.env.example`）、SQLite 数据库及 WAL/SHM/journal、数据库备份目录、日志与临时文件。
- 精确暂存 84 个文件（源码 / 静态资源 / 配置模板 / package.json 与锁文件 / 脚本 / README / 项目文档），不含密钥、数据库、备份、依赖与构建产物。
- **未提交**：本机未配置 Git 作者身份（`user.name` / `user.email` 均为空），按约定不编造姓名邮箱、不修改全局配置，提交待用户补充作者身份后执行。基线说明拟为：「保存已验收的账单查询、只读AI及自然语言模拟转账版本」。

### 四、数据库一致性备份

- 备份脚本：复用 `backend/scripts/backup-db.js`（SQLite `db.backup()`，正确处理 WAL，不改动原库）。
- 备份路径：`backend/data/backups/rongzhi.pre-transfer-20261021154839214.db`。
- 只读独立连接校验：`PRAGMA integrity_check` = `ok`；备份与当前库一致——账户余额 4199438 分、交易 61 笔、转账操作 4 条、收款人 4 条（当前余额已随用户测试变化，以实际值核对，未用历史固定值）。

### 五、源码 ZIP 快照

- 路径：`rongzhi-agent-source-20261021235053.zip`（项目根目录）。
- 内容：与暂存基线一致的 84 个文件，已确认不含 `.env`、`data/`、`node_modules`、`dist`、数据库或备份文件。

---

## 第十四阶段：红色转账强验证（交易密码 + 动态验证码）

日期：2026-10-22

本轮实现红色转账单（当日累计过线）的**强验证**：交易密码 + 手机验证器 TOTP 动态验证码，集成进共享确认卡。

### 一、新增 / 修改

- `backend/src/lib/totp.js`：RFC 6238 TOTP（HMAC-SHA1、6 位、30 秒、±1 窗口）+ base32 + otpauth URI。
- `backend/src/lib/crypto-util.js`：scrypt 密码哈希（随机盐 + `timingSafeEqual`）、AES-256-GCM 认证加密。
- `backend/src/lib/verification-key.js`：加密主密钥与数据库分离（`backend/data/.verification-key`，受限文件）。
- `backend/src/lib/rate-limit.js`：请求级限流（与失败计数分离）。
- `backend/src/db/schema.js`：新增 `verification_bindings` / `totp_used_steps` / `verification_failures` 三表。
- `backend/src/services/verification.js`：绑定（拒绝覆盖）、锁定、两步强验证（凭据校验独立提交，
  失败计数不被回滚吞掉；消费时间步 + 扣款 + 流水 + 状态 + 审计同事务）。
- `backend/src/services/transfers.js`：抽出 `finalizeTransfer` 共用扣款核心；`needs_verification` 可过期 / 可取消。
- `backend/src/routes/verification.js` + `routes/transfers.js`：`GET /verification/status`、
  `POST /transfers/:refNo/verify`（限流 + 字段白名单 + 状态码映射）。
- `backend/scripts/bind-verification.js`：一次性本地交互绑定命令（隐藏输入 + 双重确认密码、随机 TOTP 密钥、
  临时二维码、验证码通过后启用绑定、清理临时明文）；修复 Windows PowerShell 交互：显式 TTY 守卫 + raw mode
  读取 `data` 事件，处理退格 / 粘贴 / CR/LF/CRLF / Ctrl+C / ANSI 控制序列，全程不回显，异常恢复终端状态。
- `backend/scripts/verify-bind-interaction.js`：交互输入状态机单元校验（13 项，纯逻辑 + 伪造 stdin 流）。
- `frontend`：`TransferConfirmCard.vue` 红色表单（密码 + 6 位验证码 + 「验证并确认转账」+ 取消；
  未绑定 / 锁定 / 剩余次数状态；提交后清空输入）；`api/index.js` 新增 `fetchVerificationStatus` / `verifyTransfer`。

### 二、安全规则

- 防重放：TOTP 时间步 `UNIQUE(user_id, step)` 消费，跨单 / 并发 / 重启不可复用；绑定码同样消费。
- 失败锁定：连续 5 次错误锁 15 分钟（跨单 / 重启不失效）；失败计数独立提交，不被回滚吞掉。
- 凭据保护：密码 scrypt 哈希；TOTP 密钥 AES-256-GCM 加密，密钥分离存储；审计不落密码 / 验证码 / 密钥。
- 未绑定 / 缺密钥 / 解密失败 → 红色单保持阻断；黄色单不可走强验证接口；普通确认不可绕过红色。
- AI 边界不变：仍无任何「执行转账 / 校验密码 / 校验验证码」模型工具。

### 三、自动测试（命令行，与人工验收区分）

| 项目 | 结果 |
| ---- | ---- |
| `node scripts/verify-strong-verification.js` | ✅ 73/73（含 RFC 6238 已知向量、防重放、锁定、回滚、黄色不绕过） |
| `node scripts/verify-transfers.js` | ✅ 61/61（黄色流程无回归） |
| `node scripts/verify-assistant-transfer.js` | ✅ 通过（NL 转账 / 改单无回归） |
| `node scripts/verify-assistant.js` | ✅ 通过（无回归） |
| `node scripts/verify-bind-interaction.js` | ✅ 13/13（隐藏输入状态机：退格 / 粘贴 / CR/LF/CRLF / Ctrl+C / ANSI 序列 / 非 TTY 拒绝） |
| `npm run build`（前端） | ✅ 通过（dist/index.html 0.46 kB / css 17.48 kB / js 100.10 kB） |
| 收费模型 | ✅ 未调用（仅本地模拟） |

### 四、人工验收（用户已确认，与自动测试区分）

本轮由用户在本地网页 + 终端人工验收，与上述命令行自动测试明确区分：

1. 绑定验证器成功（本地 `bind-verification.js`，Windows PowerShell 交互式终端）。
2. 红色转账单生成时不扣款。
3. 错误凭据被拦截，余额不变。
4. 正确交易密码 + TOTP 可执行转账。
5. 只扣款一次，余额、流水、月度统计同步刷新。

### 五、一致性备份

- 结构变更前备份：`backend/data/backups/rongzhi.pre-transfer-20261022042058042.db`（复用 `backup-db.js`）。

### 六、绑定命令（用户本人执行）

```
cd backend && node scripts/bind-verification.js
```

扫码步骤：运行后按提示两次输入交易密码（≥8 位，隐藏输入）→ 在系统临时目录生成临时二维码
（`tmpdir()` 下的 `rongzhi-verification-*.png`，未暴露给 Vite / Express 静态服务）→ 用手机验证器（如 Google Authenticator /
Microsoft Authenticator）扫码，验证器名「融智 Agent」、账户为演示账户 → 输入当前 6 位动态码验证通过后
绑定启用；完成 / 取消 / 失败均清理二维码与临时明文。已有绑定拒绝覆盖，无快捷重置。

### 七、网页验收步骤

1. 启动后端 + 前端，先用本地命令完成一次绑定（见上）。
2. 在「手动转账」或「AI 助手」发起一笔使当日累计 >¥1000 的转账，生成**红色**单。
3. 红色卡显示收款人 / 掩码账户 / 付款账户 / 金额 / 备注 / 红色原因，以及交易密码 + 6 位验证码输入框与「验证并确认转账」按钮。
4. 输入正确密码 + 验证器当前动态码 → 显示成功回执，余额 / 流水 / 月度统计同步刷新，只扣一次。
5. 反向核对：未绑定时显示「尚未绑定验证器」且无可执行按钮；密码或验证码错误提示失败并显示剩余次数；
   连续 5 次错误锁定 15 分钟并显示解锁时间；黄色单仍走普通确认。
6. 同一验证码不可重复用于第二笔红色单；已取消 / 已过期的红色单不可再验证。

### 八、已知限制

- 尚未实现正式登录认证与多用户隔离；TOTP 时间步窗口为 ±1（约 90 秒）；仅本地绑定命令，无 Web 绑定 / 重置。
- 强验证交互的自动化覆盖为输入状态机单元测试（非真实 TTY 端到端）；真实 PowerShell 交互由用户人工验收。

---

## 第十五阶段：银行卡查询、临时冻结 / 解冻，并接入自然语言助手

日期：2026-10-22

本轮实现银行卡查询、临时冻结（黄色，需点击确认）与解冻（红色，需交易密码 + TOTP 强验证），
并接入自然语言助手。正式挂失 / 销卡 / 补卡 / 调额本阶段**不实现**，遇到时明确说明不支持并询问是否改用临时冻结。
冻结 / 解冻仅改变卡片状态 `active ↔ frozen`，不改变余额、交易流水、订阅与日限额。

### 一、新增 / 修改

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/services/card-operations.js` | 新建：银行卡操作服务（创建 / 查看 / 确认 / 取消，乐观锁版本 CAS，风险判定，状态机校验，审计） |
| `src/routes/card-operations.js` | 新建：银行卡操作路由（创建 / 查看 / 确认 / 取消 / 强验证；字段白名单 + 限流 + 状态码映射） |
| `src/routes/index.js` | 修改：注册 `/card-operations` 路由 |
| `src/services/verification.js` | 修改：新增 `verifyAndConfirmCardUnfreeze`，复用转账强验证（凭据 / TOTP / 防重放 / 失败锁定） |
| `src/services/assistant.js` | 修改：工具白名单新增 `get_cards` / `prepare_card_operation` / `get_card_operation_status`；`buildCardOpNotice`；会话 `pendingCardOpRef` + 单消息去重 |
| `src/db/schema.js` | 修改：`cards.version` 列 + `card_operations` 表 + 索引 |
| `src/db/migrate.js` | 修改：`cards.version` 回填 1 + 新建 `card_operations` 表（幂等） |
| `scripts/verify-card-operations.js` | 新建：独立临时库 78 项断言验证 |
| `scripts/verify-migrate.js` | 修改：新增 `version` 回填断言；修复既有 fixture 缺 `transfer_recipients`（此前遗留，非本轮引入） |

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/components/CardOperationConfirmCard.vue` | 新建：共享银行卡操作确认卡（冻结确认 / 解冻强验证 / 取消 / 回执，挂载回读最新状态） |
| `src/components/CardList.vue` | 修改：银行卡分区新增冻结 / 解冻辅助入口（与聊天入口共用同一确认卡） |
| `src/components/AssistantPanel.vue` | 修改：渲染 `get_cards` / `prepare_card_operation` / `get_card_operation_status` 结果卡 + 改单信号 |
| `src/composables/useCardOpSignal.js` | 新建：银行卡操作状态变更信号（改单后旧卡自动回读） |
| `src/api/index.js` | 修改：新增银行卡操作接口请求封装 |
| `src/App.vue` | 修改：场景状态更新为「查询/冻结/解冻已实现」+ 说明文案 |

#### 文档

| 文件 | 说明 |
| ---- | ---- |
| `docs/api.md` | 新增银行卡操作接口文档 + AI 工具白名单扩为 8 个 |
| `docs/database-design.md` | 新增 `card_operations` 表、`cards.version`、索引与迁移说明 |
| `docs/security-design.md` | 新增银行卡状态机 / 版本 CAS / 跨业务强验证复用 / 无客户端 verified 布尔 |
| `docs/development-log.md` | 本日志 |

### 二、实现要点

- **查询**：复用现有 `listCards` 服务与真实数据，仅返回掩码卡号、卡类型、状态、日限额。
- **冻结（黄色）**：创建操作单不改变卡片状态，`active → frozen`，用户在确认卡点击「确认冻结」执行；
  确认接口只接受 `{ confirm: true }`。
- **解冻（红色）**：`frozen → active`，需交易密码 + TOTP 强验证，复用转账强验证同一套
  （`totp_used_steps` 跨业务防重放、`verification_failures` 跨业务失败锁定），不另起第二套规则。
- **版本 CAS**：卡片状态更新 `WHERE id=? AND status=? AND version=?`；建单后卡片被改动（含「正常→冻结→正常」）
  的旧单不可覆盖新状态；重复确认幂等。
- **操作单与转账区分**：编号前缀 `card-op-`、独立 `pendingCardOpRef`、取消 / 过期逻辑互不影响。
- **AI 边界**：只开放 `get_cards` / `prepare_card_operation` / `get_card_operation_status`，不开放任何执行 /
  强验证工具；聊天「确认 / 我同意」不改卡片状态；多卡时列出掩码选项不擅自选第一张；「挂失」等明确说明不支持。
- **前端共用**：聊天入口与卡片列表辅助入口共用同一确认卡与后端确认规则。

### 三、自动测试（命令行，与人工验收区分）

| 项目 | 结果 |
| ---- | ---- |
| `node scripts/verify-card-operations.js` | ✅ 78/78（创建不改状态、归属/状态流转、版本 CAS 含「正常→冻结→正常」、冻结确认/解冻强验证/取消/过期/重复幂等、跨业务防重放与失败锁定） |
| `node scripts/verify-strong-verification.js` | ✅ 73/73（无回归） |
| `node scripts/verify-transfers.js` | ✅ 61/61（无回归） |
| `node scripts/verify-assistant-transfer.js` | ✅ 通过（NL 转账 / 改单无回归） |
| `node scripts/verify-assistant.js` | ✅ 通过（无回归） |
| `node scripts/verify-db.js` | ✅ 通过（无回归） |
| `node scripts/verify-migrate.js` | ✅ 9/9（含 version 回填断言） |
| `npm run build`（前端） | ✅ 通过（39 模块，dist/index.html 0.46 kB / css 20.87 kB / js 109.37 kB） |
| 收费模型 | ✅ 未调用（仅本地模拟 + mock 模型） |
| 开发库业务数据 | ✅ 未修改；未在开发库自动冻结 / 解冻 |

### 四、一致性备份

- 结构变更前备份：`backend/data/backups/rongzhi.pre-transfer-20261022051915653.db`（复用 `backup-db.js`，SQLite `db.backup()` 正确处理 WAL）。

### 五、已知限制

- 正式挂失 / 销卡 / 补卡 / 调额未实现（仅临时冻结 / 解冻，仅改卡片状态）。
- 无银行卡交易授权或真实扣款引擎（本阶段为模拟边界）。
- 正式登录认证与多用户隔离仍未实现（单用户演示模式）。

### 六、重启与验收步骤

后端以 `npm run dev`（nodemon）运行会随源码改动自动重启并执行增量迁移；若以 `npm start` 运行则需重启以加载
新增路由与 `cards.version` 迁移。前端 `npm run dev` 热更新。

验收：
1. 打开前端 → 「银行卡」分区查看掩码卡号与状态；卡片行提供「冻结」辅助入口。
2. 「AI 助手」输入「我有哪些银行卡？」→ 列出掩码卡号选项。
3. 输入「冻结尾号 1234 的卡」→ 生成冻结操作单（待确认，卡片状态不变）→ 确认卡点「确认冻结」→ 状态变「冻结」，卡片列表同步刷新。
4. 输入「把刚才冻结的卡解冻」→ 生成解冻单（需强验证）→ 输入交易密码 + TOTP 动态码 → 「验证并确认解冻」→ 状态变「正常」。
5. 反向核对：聊天文字「确认」不改状态；「挂失」明确提示不支持并询问是否改用临时冻结；同一验证码不可复用。

---

## 第十六阶段：修复 AI 助手回答中的 Markdown 表格显示

日期：2026-10-22

本轮仅修复助手回答的**展示层**：此前回答中的 Markdown 表格以原始 `| 卡号 | 类型 | …` 纯文本显示，
现在渲染为按列对齐的真实表格。不改变银行卡、转账或强验证业务逻辑；不修改数据库、不调用收费模型。

### 一、新增 / 修改

| 文件 | 说明 |
| ---- | ---- |
| `frontend/src/utils/markdown.js` | 新建：markdown-it 解析（html:false 转义原始 HTML）→ DOMPurify 严格白名单净化；表格对齐 class 化 + 金额列右对齐 + 横向滚动容器 |
| `frontend/src/components/MarkdownContent.vue` | 新建：可复用助手回答展示组件（段落 / 换行 / 列表 / 加粗 / 代码块 / 表格），v-html 只接收净化结果 |
| `frontend/src/components/AssistantPanel.vue` | 修改：助手文本改用 `MarkdownContent`；用户消息仍按纯文本展示；工具结果卡 / 确认按钮 / 服务端状态说明职责不变 |
| `frontend/scripts/verify-markdown.mjs` | 新建：本地固定文本 + 安全净化验证（32 项断言，jsdom + dompurify） |
| `frontend/package.json` | 修改：新增依赖 `markdown-it@^15.0.3`、`dompurify@^3.4.17`；devDependency `jsdom@^30.1.3`（仅验证脚本用，不进构建产物） |
| `docs/development-log.md` | 本日志 |

### 二、实现要点

- **解析与净化分离**：markdown-it 关闭 `html`（原始 HTML 一律转义）、关闭 `linkify`、开启 `breaks`；
  DOMPurify 提供严格 `ALLOWED_TAGS` / `ALLOWED_ATTR` 白名单，仅保留文本、列表、代码、表格与链接标签，
  禁止脚本 / 事件属性 / 表单 / 按钮 / iframe / 图片 / 可执行链接（`javascript:` / `data:` / `vbscript:` 由
  DOMPurify 默认 URI 校验阻断）。
- **表格**：表头 `:---`/`:---:` 对齐转为受控 class（不保留内联 style）；整列数据格均为金额/数值时右对齐
  （可靠识别），否则统一左对齐，不改动模型数值；外层 `div.md-table-scroll` 横向滚动，手机宽度不撑宽整页。
- **复用**：无现成 Markdown 依赖，选用 `markdown-it + dompurify`，不引大型 UI 库、不用正则自研解析器。
- **职责隔离**：仅助手文本走 `MarkdownContent`；用户消息纯文本，工具结果卡 / 确认按钮 / 状态说明不经
  模型生成的 HTML 创建业务入口。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ---- | ---- |
| `node scripts/verify-markdown.mjs` | ✅ 32/32（银行卡表格、多行表格、金额列右对齐、显式对齐、普通文本/换行/列表/加粗/代码块、不完整表格回退、恶意 HTML/事件属性/图片/javascript·data·链接阻断、安全 http 链接保留并带 rel） |
| `npm run build`（前端） | ✅ 通过（62 模块；dist js 239.81 kB，因打包 markdown-it + dompurify 增大） |
| 浏览器可视验收（电脑/手机宽度） | ⚠️ 未做（命令行环境，无浏览器；仅验证构建与 Node 渲染/净化） |
| 收费模型 / 数据库 / 业务逻辑 | ✅ 未调用、未修改、未改动 |

### 四、已知限制

- 表格金额列右对齐为「整列数据格均为数值/金额」的可靠启发式；混有非数值格的列统一左对齐。
- 浏览器端实际渲染（Vite 打包后 `createDOMPurify(window)` 路径）已随构建与 Node 同一模块路径验证，
  但未做真实浏览器可视验收。

## 第十七阶段：修复连续输入与焦点 + 服务端持久化当前对话

日期：2026-10-22

本轮只修两件事：**发送消息后不能直接继续输入**、**刷新页面后聊天记录丢失**。不改变账户 / 银行卡状态区分，
不改变转账或强验证业务规则，不修改开发库业务数据，不调用收费模型。

### 一、新增 / 修改

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/db/schema.js` | 修改：新增 `chat_sessions`（模型上下文 + 会话元数据）、`chat_messages`（用户可见消息）、`chat_state`（当前对话指针）三张表及索引 |
| `backend/src/services/assistant.js` | 修改：会话持久化（单事务写会话 + 消息 + 指针，200 条上限、7 天保留、损坏 JSON 容错）；`getCurrent` 只读恢复、`newConversation` 切换对话、`purgeExpiredSessions` |
| `backend/src/routes/assistant.js` | 修改：新增 `GET /api/assistant/current`（只读恢复）、`POST /api/assistant/new`（新建对话，均不校验密钥、不调模型） |
| `frontend/src/api/index.js` | 修改：新增 `fetchCurrentChat` / `newConversation` |
| `frontend/src/components/AssistantPanel.vue` | 修改：单行输入改为 `textarea`；中文输入法 composition 守卫（IME 回车不发送）+ Shift+Enter 换行；发送后 `nextTick` 聚焦、等待中仍可起草、回复/失败不清空等待期草稿；挂载时 `loadCurrent` 恢复 + 加载 / 失败重试 / 过期 / 欢迎态 |
| `backend/scripts/verify-assistant.js` | 修改：6.2 过期会话沿用同一 `sessionId`（可见历史保留，上下文重新开始） |
| `backend/scripts/verify-chat-persistence.js` | 新建：mock 模型 + 临时库验证持久化（35 项断言） |
| `docs/api.md` / `docs/database-design.md` / `docs/development-log.md` | 文档同步 |

### 二、实现要点

- **连续输入与焦点**：Enter 发送、Shift+Enter 换行；`compositionstart/end` + `isComposing`/`keyCode 229` 守卫，
  中文输入法选词回车不发送；发送后清空输入并用 `ref + nextTick` 恢复焦点；等待回复期间不禁用输入（可起草但不可并行提交）；
  回复/失败只清空已发送内容，不覆盖等待期新起草的草稿；回复返回不抢其他输入框 / 验证表单焦点。
- **服务端持久化**：区分 part A（`chat_messages` 用户可见消息、工具记录、时间、`ref_no` 引用）与
  part B（`chat_sessions.messages_json` 模型上下文 + 会话元数据）。刷新经只读 `GET /current` 恢复，不调收费模型、不重发；
  后端重启后仍能恢复（读库而非内存）。
- **安全与归属**：演示用户服务端确定（不接受客户端 `userId` / 伪造历史）；system 提示每次按当前上海时间由服务端生成、不持久化；
  不持久化交易密码 / 验证码 / TOTP 密钥 / 模型密钥 / 敏感请求体；不使用 localStorage 存聊天。
- **一致性**：操作卡以 `ref_no` 回读业务库**最新状态**，不沿用历史快照；刷新不重建会话、不伪造历史；
  旧迟到响应不污染新会话（`setCurrentSession` 前校验当前会话）；过期会话历史仍可查看并提示上下文重新开始。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ---- | ---- |
| `node backend/scripts/verify-chat-persistence.js` | ✅ 35/35（两轮恢复、重启上下文、过期、tool 配对+归属、新建隔离、只读不伪造、操作卡回读、无凭据、上限+保留+损坏 JSON） |
| `node backend/scripts/verify-assistant.js` | ✅ 通过（含 6.2 过期沿用同一 sessionId） |
| `node backend/scripts/verify-card-operations.js` | ✅ 78/78 |
| `node backend/scripts/verify-transfers.js` | ✅ 61/61 |
| `node backend/scripts/verify-strong-verification.js` | ✅ 73/73 |
| `node backend/scripts/verify-migrate.js` / `verify-db.js` | ✅ 通过 |
| `node frontend/scripts/verify-markdown.mjs` | ✅ 32/32 |
| `npm run build`（前端） | ✅ 通过（62 模块；dist js 240.97 kB） |
| 后端运行状态 | ✅ `GET /api/health` 正常；`GET /api/assistant/current` 返回空会话（新表 / 端点已随 nodemon 自动重启生效） |
| 收费模型 / 开发库业务数据 | ✅ 未调用、未修改 |
| 浏览器可视验收（连续输入 / 刷新恢复） | ⚠️ 未做（命令行环境无浏览器；已通过 Node 级验证 + 构建，人工验收步骤见交付报告） |

### 四、已知限制

- 焦点与中文输入法行为已按规范实现并通过代码级校验，但真实浏览器交互（IME 组合、刷新恢复）需人工验收确认。
- 历史消息为查询时快照，操作卡状态以业务库最新值为准（设计如此，非缺陷）。

## 第十八阶段：交易流水入账状态筛选 + 翻页位置稳定

日期：2026-10-22

本轮只做两件事：交易流水增加「全部 / 已入账 / 待入账」入账状态筛选；修复翻页时整页向上跳动。

### 一、根因

- 翻页跳动：`TransactionList` 加载时用 `v-if="loading"` 整体替换「列表 + 分页区」为一行「加载中…」，导致该段高度骤降约整页，整页阅读模式下视口被钳制后上跳（落到月度分析附近）。
  按钮为原生 `<button>`（无 href / 表单提交），组件内无 `scrollIntoView` / `scrollTo` / `focus` / 自动滚动 watch；助手的 `focusInput` / `scrollToBottom` 只作用于其自身流程，不被流水请求间接触发。

### 二、修改文件

| 文件 | 说明 |
| ---- | ---- |
| `backend/src/services/transactions.js` | `listTransactions` 增加 `status` 条件（与 COUNT 同 `WHERE`，参数化） |
| `backend/src/routes/transactions.js` | `GET /api/transactions` 增加可选 `status`：仅 `posted` / `pending`；非法值 / 重复参数（数组）/ `status[]=` 均 400 |
| `frontend/src/api/index.js` | `fetchTransactions` 增加 `status` 参数 |
| `frontend/src/components/TransactionList.vue` | 增加「全部 / 已入账 / 待入账」下拉；任一筛选变化回第 1 页；`meta.total` 来自后端；竞态防护保留；翻页稳定：外层 `min-height` 预留完整页高度 + 分页区常驻 + 加载中禁用翻页按钮 |
| `backend/scripts/verify-api.js` | 扩展状态筛选断言（含 posted/pending 正确 total、月份组合、跨页完整筛出、非法参数 400、他用户隔离） |
| `docs/api.md` | 补充 `GET /api/transactions` 的 `status` 参数说明 |

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ---- | ---- |
| `node backend/scripts/verify-api.js` | ✅ 34/34（含状态筛选 13 项 + 原有回归） |
| `npm run build`（前端） | ✅ 通过（62 模块） |
| 浏览器可视验收（翻页位置 / 桌面与手机宽度） | ⚠️ 未做（命令行环境无浏览器） |

## 第十九阶段：三区域筛选展示（流水文案 / 银行卡卡种 / 订阅状态）

日期：2026-10-22

本轮仅做前端展示层筛选，不引入新依赖、不改后端 / 数据库 / 业务数据；银行卡与订阅接口本就返回完整列表（无分页），故用 Vue `computed` 在完整数据上过滤。

### 一、字段与状态映射

- 交易流水：状态筛选文案「未入账」→「待入账」（`pending` 参数与筛选逻辑不变）。
- 银行卡：`card_type` 字段，映射 `借记卡` / `信用卡`（固定选项）；其它出现的卡种按实际字段补充为选项；
  未知 / 空卡种在「全部」中展示并兜底「其他卡种」，不归为借记卡 / 信用卡。状态仍按 `active/frozen/cancelled` 展示（`statusText` 不变）。
- 订阅：`status` 字段枚举 `active`（生效）/ `paused`（暂停）/ `cancelled`（已取消），映射固定选项；
  未知状态仅在「全部」中展示并兜底「未知状态」，不按商户名 / 扣费日期 / 金额猜测。

### 二、修改文件

| 文件 | 说明 |
| ---- | ---- |
| `frontend/src/components/TransactionList.vue` | 状态筛选选项「未入账」→「待入账」 |
| `frontend/src/components/CardList.vue` | 新增「全部 / 借记卡 / 信用卡」卡种筛选（`computed` 前端过滤），空结果提示「该卡种暂无银行卡」，冻结 / 解冻后保留选择并回读最新状态 |
| `frontend/src/components/SubscriptionList.vue` | 新增「全部 / 生效 / 暂停 / 已取消」状态筛选（`computed` 前端过滤），空结果提示「该状态下暂无订阅」，已取消仍显示「已取消，不再扣费」 |

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ---- | ---- |
| `npm run build`（前端） | ✅ 通过（62 模块） |
| 浏览器可视验收（三区域切换 / 空结果 / 手机宽度） | ⚠️ 未做（命令行环境无浏览器，见交付报告） |

---

## 第二十阶段：订阅与代扣管理（暂停 / 恢复 / 取消 + 自然语言入口）

日期：2026-10-22

本轮实现订阅管理操作：暂停（黄色，需点击确认）、取消（黄色，需点击确认）、恢复（红色，需交易密码 + TOTP 强验证），
并接入自然语言助手。已取消订阅为终态，本轮不重开；订阅操作仅改变订阅状态 `active ↔ paused / → cancelled`，
不改变余额、交易流水、银行卡状态、金额、周期或原扣费日期，不取消真实商户合约、不触发真实扣款。

### 一、新增 / 修改

#### 后端（backend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/db/schema.js` | 修改：`subscriptions.version` 列 + `subscription_operations` 表（含 `action` / `from_status` / `to_status` / `subscription_version` / `risk_level` / `status`）+ 3 索引；`chat_sessions.pending_subscription_op_ref` 列 |
| `src/db/migrate.js` | 修改：`subscriptions.version` 回填 1 + 新建 `subscription_operations` 表（幂等） |
| `src/services/subscription-operations.js` | 新建：订阅操作服务（创建 / 查看 / 确认 / 取消、乐观锁版本 CAS、风险判定、状态机校验、审计） |
| `src/routes/subscription-operations.js` | 新建：订阅操作路由（创建 / 查看 / 确认 / 取消 / 强验证；字段白名单 + 限流 + 状态码映射） |
| `src/routes/index.js` | 修改：注册 `/subscription-operations` 路由 |
| `src/services/verification.js` | 修改：新增 `verifyAndConfirmSubscriptionResume`，复用转账 / 解冻同一套强验证（凭据 / TOTP / 防重放 / 失败锁定） |
| `src/services/assistant.js` | 修改：工具白名单新增 `get_subscriptions` / `prepare_subscription_operation` / `get_subscription_operation_status`；`buildSubscriptionOpNotice`；会话 `pendingSubscriptionOpRef` + 单消息去重 |
| `scripts/verify-subscription-operations.js` | 新建：独立临时库 84 项断言验证 |

#### 前端（frontend/）

| 文件 | 说明 |
| ---- | ---- |
| `src/components/SubscriptionOperationConfirmCard.vue` | 新建：共享订阅操作确认卡（暂停 / 取消确认、恢复强验证、回执，挂载回读最新状态） |
| `src/components/SubscriptionList.vue` | 修改：订阅分区新增暂停 / 恢复 / 取消辅助入口（与聊天入口共用同一确认卡），保留状态筛选与「扣费日期待更新」文案 |
| `src/components/AssistantPanel.vue` | 修改：渲染 `get_subscriptions` / `prepare_subscription_operation` / `get_subscription_operation_status` 结果卡 + 改单信号 |
| `src/composables/useSubscriptionOpSignal.js` | 新建：订阅操作状态变更信号（改单后旧卡自动回读） |
| `src/api/index.js` | 修改：新增订阅操作接口请求封装 |

#### 文档

| 文件 | 说明 |
| ---- | ---- |
| `docs/api.md` | 新增订阅操作接口文档 + AI 工具白名单扩为 11 个 |
| `docs/database-design.md` | 新增 `subscription_operations` 表、`subscriptions.version`、`chat_sessions.pending_subscription_op_ref`、索引 / 迁移 / 验证说明 |
| `docs/security-design.md` | 新增订阅状态机 / 版本 CAS / 强验证扩展到订阅恢复 |
| `docs/development-log.md` | 本日志 |

### 二、实现要点

- **风险与状态机（后端判定）**：暂停 / 取消为黄色（普通确认），恢复为红色（交易密码 + TOTP 强验证）；
  合法流转 `active → paused`、`paused → active`、`active|paused → cancelled`；`cancelled` 为终态；未知状态一律拒绝。
- **操作单 + 版本 CAS**：创建（prepare）不改变订阅状态，写入建单时 `subscription_version` 快照；
  订阅状态更新 `WHERE id=? AND version=?`；建单后订阅被改动（含「生效→暂停→生效」回环）的旧单不可覆盖新状态；
  变更 + 完成操作 + 审计同事务；重复请求不重复执行。
- **强验证复用**：恢复复用转账 / 解冻同一套凭据保护 / TOTP / `totp_used_steps` 防重放 / `verification_failures` 失败锁定，
  跨业务共享，不另起第二套规则；普通确认接口不可绕过红色。
- **凭据保护**：密码 / 验证码仅经专用验证接口，不进入模型、历史或日志。
- **AI 边界**：只开放查询 / 准备 / 状态三工具，不开放任何执行 / 强验证工具；多个订阅匹配或指向不明确时先澄清；
  单条消息最多一张订阅操作单；重复工具调用不重复建单；聊天「确认」文字不触发状态变更。
- **文案与刷新**：状态文案由服务端真实结果生成（`buildSubscriptionOpNotice`），不靠模型推断；执行后订阅列表与聊天历史
  操作卡回读最新状态；恢复聊天时重新读取真实订阅状态；保留状态筛选 / Markdown 渲染 / 输入焦点 / 会话持久化。
- **模拟边界**：暂停 / 取消 / 恢复仅改变订阅状态，不改变余额 / 历史 / 金额 / 周期 / 原扣费日期；暂停 / 取消后不再提示
  「即将扣费」；恢复后若原扣费日期已过仅显示「扣费日期待更新」，不编造日期。

### 三、验证结果（真实执行）

| 验证项 | 结果 |
| ---- | ---- |
| `node scripts/verify-subscription-operations.js` | ✅ 84/84（创建不改状态、归属/状态流转、版本 CAS 含「生效→暂停→生效」、暂停/取消确认与恢复强验证/取消/过期/重复幂等、越权/篡改/未知状态/订阅被删/事务回滚、多订阅澄清/模型重复建单、聊天「确认」不执行、跨业务防重放与失败锁定、HTTP 端到端） |
| `node scripts/verify-card-operations.js` | ✅ 78/78（无回归） |
| `node scripts/verify-strong-verification.js` | ✅ 73/73（无回归） |
| `node scripts/verify-transfers.js` | ✅ 61/61（无回归） |
| `node scripts/verify-assistant-transfer.js` | ✅ 通过（无回归） |
| `node scripts/verify-assistant.js` | ✅ 通过（无回归） |
| `node scripts/verify-chat-persistence.js` | ✅ 35/35（无回归） |
| `node scripts/verify-migrate.js` / `verify-db.js` | ✅ 通过（无回归） |
| `npm run build`（前端） | ✅ 通过（65 模块） |
| 收费模型 | ✅ 未调用（仅本地模拟 + mock 模型） |
| 开发库业务数据 | ✅ 未修改；未在开发库自动暂停 / 取消 / 恢复订阅 |
| 浏览器可视验收 | ⚠️ 未做（命令行环境，仅验证构建与接口数据链路） |

### 四、一致性备份

- 结构变更前备份（复用 `backup-db.js`，SQLite `db.backup()` 正确处理 WAL）。

### 五、已知限制

- 已取消订阅为终态，本轮未实现「重新开通 / 恢复」；正式登录认证与多用户隔离仍未实现（单用户演示模式）。
- 恢复后原扣费日期的「更新」为占位展示（「扣费日期待更新」），不模拟新的扣费计划。

### 六、重启与验收步骤

后端以 `npm run dev`（nodemon）运行会随源码改动自动重启并执行增量迁移；若以 `npm start` 运行则需重启以加载
新增路由与 `subscriptions.version` / `subscription_operations` 迁移。前端 `npm run dev` 热更新。

验收：
1. 打开前端 → 「订阅与代扣」分区查看订阅列表与状态筛选；每行提供「暂停 / 取消」（生效）或「恢复 / 取消」（暂停）按钮。
2. 点「暂停」→ 生成待确认暂停单（订阅状态不变）→ 确认卡点「确认暂停」→ 状态变「暂停」，列表同步刷新；日期文案变为「已暂停，不自动扣费」。
3. 点「恢复」→ 生成需强验证恢复单 → 输入交易密码 + TOTP 动态码 → 「验证并确认恢复」→ 状态变「生效」；若原扣费日期已过则显示「扣费日期待更新」。
4. 点「取消」→ 确认卡点「确认取消」→ 状态变「已取消」，该行不再出现操作按钮。
5. 「AI 助手」输入「暂停爱奇艺会员的自动续费」→ AI 生成暂停操作单并在聊天中展示确认卡（与列表入口共用同一确认卡）；
   输入「确认」等文字不触发状态变更；多个匹配时先澄清；执行后列表与聊天操作卡回读最新状态。

### 七、全轮实际耗时

（见最终交付报告）

