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

