# 融智 Agent

银行 AI 智能体竞赛项目（**单用户演示版**）。所有银行业务均为模拟数据，不接入真实银行账户；
演示用户固定为「张三」，尚未实现正式登录认证与多用户隔离。

## 项目状态

五个业务场景均已通过用户网页验收：

| # | 场景 | 状态 |
| - | ---- | ---- |
| 1 | 智能转账 | ✅ 已实现（手动 + 自然语言；黄色普通确认 / 红色交易密码 + 验证器 TOTP 强验证） |
| 2 | 账单分析 | ✅ 已实现（月度收支 / 分类统计 + 只读 AI 查询） |
| 3 | 银行卡管理 | ✅ 已实现（查询 / 临时冻结（黄色）/ 解冻（红色强验证）） |
| 4 | 订阅与代扣管理 | ✅ 已实现（暂停 / 取消（黄色）/ 恢复（红色强验证）） |
| 5 | 跨场景联动 | ✅ 已实现（**受限**：仅「订阅审查」一条任务链） |

## 技术栈

| 模块 | 技术 |
| ---- | ---- |
| 前端 | Vue 3 + Vite 8 |
| 后端 | Node.js + Express 5（ES Modules） |
| 数据库 | SQLite（better-sqlite3，WAL 模式） |
| 助手文本渲染 | markdown-it + DOMPurify（严格白名单净化） |
| 大模型 | DeepSeek（可选，仅自然语言助手使用） |

> 图表库（ECharts 等）**未使用**：月度账单分析以「统计卡片 + 分类表格」呈现，不依赖图表库，
> 亦非部署前置条件，请勿将其列为缺项。

## 目录结构

```
rongzhi-agent/
├── frontend/            # Vue 3 + Vite（含 /api 代理到 localhost:3000）
│   ├── src/components/  # 分区组件（账户/转账/助手/账单/流水/卡片/订阅/任务）
│   ├── scripts/         # verify-markdown.mjs（Markdown 渲染与净化验证）
│   └── vite.config.js   # 开发端口与 /api 代理
├── backend/             # Node.js + Express 5（ESM）
│   ├── src/
│   │   ├── index.js     # 服务入口（GET /api/health）
│   │   ├── db/          # 连接 / 建表 / 迁移 / 种子数据
│   │   ├── routes/      # HTTP 层
│   │   ├── services/    # 业务 / 查询 / AI 助手 / 强验证
│   │   └── lib/         # TOTP / 加密 / 密钥 / 限流 / 金额 / 时间
│   ├── scripts/         # 初始化 / 备份 / 绑定 / 验证（verify-*）
│   └── data/            # SQLite 库与主密钥（均不入 Git，见 .gitignore）
└── docs/                # API / 数据库 / 安全 / AI 用量 / 开发日志
```

## 已实现能力

- **只读查询**：账户概览、交易流水（月份 + 入账状态筛选 + 分页）、银行卡（卡种筛选）、订阅（状态筛选）、月度账单分析。
- **智能转账**：手动入口与自然语言入口共用同一套「操作单 + 版本 CAS + 同事务审计」；当日累计 ≤ ¥1000 为黄色（界面确认），
  超过为红色（交易密码 + TOTP 强验证）；防重复、防篡改、余额守卫。
- **银行卡管理**：临时冻结（黄色确认）、解冻（红色强验证）；仅改卡片状态，不改余额 / 流水 / 订阅 / 日限额。
- **订阅与代扣管理**：暂停、取消（黄色确认）、恢复（红色强验证）；仅改订阅状态，不触发真实扣款。
- **AI 助手**：自然语言 → 模型工具调用 → 真实查询 → 结构化结果卡；工具白名单仅含查询与「准备操作单」，
  不含任何执行 / 校验密码 / 校验验证码工具；回答经 markdown-it + DOMPurify 渲染。
- **跨场景任务**：唯一一条链「分析某月支出 → 列出生效订阅 → 用户选择一项 → 生成暂停单 → 界面确认 → 核验 → 回执」，
  由服务端白名单节点图驱动，不执行模型生成的任意代码 / SQL / URL。
- **强验证**：交易密码（scrypt）+ 手机验证器 TOTP（RFC 6238，AES-256-GCM 加密存储），跨业务防重放、失败锁定（5 次锁 15 分钟）。
- **聊天持久化**：会话与消息落库，刷新 / 后端重启后可经只读接口恢复。

## 模拟边界与未实现项

- **未实现正式登录认证**：单用户演示模式，服务端固定「张三」，不接受客户端切换用户，无多用户隔离。
- **不接入真实银行**：账户、交易、卡片、订阅、转账、强验证全部为模拟，不连真实支付通道 / 账户。
- **银行卡**：正式挂失 / 销卡 / 补卡 / 调额未实现（仅临时冻结 / 解冻）。
- **订阅**：已取消为终态，不支持重新开通；恢复后若原扣费日期已过，仅显示「扣费日期待更新」，不模拟新的扣费计划。
- **跨场景**：仅「订阅审查」一条任务链，其余任务组合明确「不支持」，无通用工作流编排。
- **AI 边界**：模型只做查询与「准备操作单」，不直接执行任何状态变更；一切写操作须经界面确认（或强验证）。
- **浏览器可视验收**：本项目开发环境为命令行，前端交互未做真实浏览器自动可视验收（已做构建 + Node 级验证，
  网页流程由用户人工验收，见 `docs/development-log.md`）。

## 环境要求

- Windows 10 / 11，PowerShell（5.1 或 7）。
- Node.js **≥ 20.12**（后端用内置 `process.loadEnvFile` 读取 `.env`；已验证 **v24.21.0**）。
- npm（已验证 **11.19.0**）。
- （可选）手机验证器 App：Google Authenticator / Microsoft Authenticator，仅用于红色强验证。

## 快速开始（Windows PowerShell）

以下命令均为跨 Shell 的 npm / node 命令，可直接在 PowerShell 中执行。

### 1. 安装依赖

```powershell
cd backend
npm ci

cd ../frontend
npm ci
```

> `npm ci` 依 `package-lock.json` 精确安装。后端 `better-sqlite3` 为原生模块，`npm ci` 会优先下载
> 对应 Node 版本的预编译二进制；若该版本无预编译产物，则回退到 `node-gyp` 本地编译（需 Visual Studio Build Tools）。

### 2. 配置（可选，仅自然语言助手需要）

未配置 AI 密钥时，除「自然语言助手」外的全部功能仍可正常使用（见下文「无 AI 密钥时的功能范围」）。

```powershell
cd backend
Copy-Item .env.example .env
# 编辑 backend/.env，填入真实密钥：
#   DEEPSEEK_API_KEY=你的真实密钥
#   DEEPSEEK_BASE_URL=https://api.deepseek.com
#   DEEPSEEK_MODEL=deepseek-v4-pro
```

> `.env`、`.verification-key`、数据库文件与备份目录均已加入 `.gitignore`，不会进入 Git 或源码包。

### 3. 首次初始化数据库

```powershell
cd backend
npm run db:init
```

> 生成 `backend/data/rongzhi.db`，建表 + 写入模拟数据（1 用户 / 1 账户 / 58 笔交易 / 1 卡 / 6 订阅）。
> 重复执行**不会**重复插入、不会清空已有数据。

### 4. 增量迁移

后端启动与 `db:init` 均会**自动执行幂等增量迁移**（补列 + 回填，不删库、不清空、不改余额），无需单独命令。
结构变更前建议先做一致性备份（见下）。

### 5. 一致性备份

```powershell
cd backend
node scripts/backup-db.js
```

> 使用 SQLite `db.backup()`（正确处理 WAL）生成一致性快照，不改动原库；
> 默认输出到 `backend/data/backups/rongzhi.pre-transfer-<时间戳>.db`。

### 6. （可选）绑定强验证器

红色转账 / 解冻 / 恢复订阅需要「交易密码 + 手机验证器 TOTP」。首次使用前由用户本人在**交互式终端**执行：

```powershell
cd backend
node scripts/bind-verification.js
```

按提示：两次输入交易密码（≥ 8 位，不回显）→ 在系统临时目录生成二维码（可自动打开）→ 用手机验证器扫码
（名称「融智 Agent」）→ 输入当前 6 位动态码。成功后绑定启用；已绑定拒绝覆盖，不提供快捷重置。
绑定过程会创建 / 复用加密主密钥 `backend/data/.verification-key`（不入 Git，见「备份与恢复」）。

### 7. 启动后端（端口 3000）

```powershell
cd backend
npm run dev        # 开发模式（nodemon 自动重启并执行迁移）
# 或
npm start          # 直接启动
```

> 后端默认端口 `3000`（`PORT` 环境变量可覆盖）。**须先完成 `npm run db:init`**（否则因找不到演示用户而退出）。

### 8. 启动前端（默认 5173，当前环境 5174）

```powershell
cd frontend
npm run dev
```

> `vite.config.js` 默认端口为 **5173**；若该端口被占用，Vite 会自动顺延到 5174 等。
> 本机当前实际使用 **5174**。**请以启动输出打印的端口为准**，不要写死。

### 9. 访问

- 前端首页：`http://localhost:<前端实际端口>/`（默认 5173，本机 5174）
- 后端健康检查：`http://localhost:3000/api/health`

### 10. 测试与构建

自动验证（**全部本地 mock / 独立临时库，不调用收费模型、不碰开发库**）：

```powershell
cd backend
node scripts/verify-db.js
node scripts/verify-api.js
node scripts/verify-analytics.js
node scripts/verify-migrate.js
node scripts/verify-fix.js
node scripts/verify-transfers.js
node scripts/verify-assistant.js
node scripts/verify-assistant-session.js
node scripts/verify-assistant-transfer.js
node scripts/verify-strong-verification.js
node scripts/verify-bind-interaction.js
node scripts/verify-card-operations.js
node scripts/verify-chat-persistence.js
node scripts/verify-subscription-operations.js
node scripts/verify-agent-tasks.js

cd ../frontend
node scripts/verify-markdown.mjs
npm run build
```

> 上述脚本均使用 mock 模型与独立临时库，可重复执行、不修改开发库业务数据。

## 无 AI 密钥时的功能范围

本项目只读取 `backend/.env.example` 模板与配置源码（`backend/src/config.js`），不读取真实 `.env` 或主密钥。

- **不依赖 AI 密钥、始终可用**：全部只读查询（账户 / 流水 / 账单分析 / 卡片 / 订阅）、手动模拟转账、
  银行卡临时冻结 / 解冻、订阅暂停 / 恢复 / 取消、强验证与验证器绑定、聊天会话恢复（`GET /api/assistant/current`）与
  新建（`POST /api/assistant/new`）。
- **依赖 AI 密钥（未配置时 `POST /api/assistant/chat` 返回 503）**：自然语言助手对话，以及经助手发起的转账 /
  卡片操作 / 订阅操作 / 跨场景任务启动。
- **真实模型调用（手动可选，不混入默认自动测试）**：
  - `cd backend; npm run ai:check` —— 连接检查（最小对话，不发送银行数据）。
  - `node scripts/smoke-assistant-live.js`、`node scripts/smoke-assistant-transfer-live.js` —— 真实 DeepSeek 冒烟。

## 备份与恢复

**恢复不仅需要数据库文件，还必须具备独立的加密主密钥。**

- 数据库：`backend/data/rongzhi.db`（含 WAL/SHM）。
- 加密主密钥：`backend/data/.verification-key`（base64 32 字节；也可用环境变量 `VERIFICATION_KEY` 提供）。
  已绑定验证器的 TOTP 密钥用 AES-256-GCM 以此主密钥加密，**换一台机器 / 丢失该密钥则已绑定的验证器无法解密**，
  红色转账 / 解冻 / 恢复订阅将保持阻断。

因此备份时需同时保存数据库（用 `node scripts/backup-db.js`）与 `backend/data/.verification-key`；两者缺一不可。
恢复后如需在新环境重新绑定，须由用户本人再次运行 `node scripts/bind-verification.js`（本项目不执行、也不提供真实重新绑定）。

**凭据与密钥不入版本控制、不进公开源码包**：`.env`、`.verification-key`、`*.db` / `*.db-wal` / `*.db-shm`、
`data/backups/`、`node_modules/`、`dist/` 均已由 `.gitignore` 排除。

## 文档索引

- `docs/api.md` —— 全部 HTTP 接口与 AI 工具白名单
- `docs/database-design.md` —— 表结构、迁移与种子数据
- `docs/security-design.md` —— 身份 / 金额 / 风险 / 防重放 / 防篡改 / AI 边界
- `docs/ai-usage.md` —— 真实模型调用用量记录
- `docs/development-log.md` —— 分阶段开发记录与验证结果
