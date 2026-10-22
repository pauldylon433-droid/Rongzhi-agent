# 融智 Agent

银行 AI 智能体竞赛项目。所有银行业务均使用模拟数据，不接入真实银行账户。

## 项目目标

实现一个银行 AI 智能体，覆盖以下五个场景：

1. 智能转账
2. 账单分析
3. 卡片管理
4. 订阅与代扣管理
5. 跨场景任务联动

## 技术方案（暂定）

| 模块     | 技术                         |
| -------- | ---------------------------- |
| 前端     | Vue 3 + Vite                 |
| 后端     | Node.js + Express            |
| 数据库   | SQLite（better-sqlite3）     |
| 图表     | ECharts（尚未接入）          |
| 大模型   | DeepSeek（已预留配置，功能待接入） |

## 目录结构

```
rongzhi-agent/
├── frontend/        # 前端项目（Vue 3 + Vite）
│   ├── src/         # 页面与组件源码
│   ├── index.html   # 页面入口
│   └── vite.config.js  # 含 /api 代理配置
├── backend/         # 后端项目（Node.js + Express）
│   ├── src/
│   │   ├── index.js        # 服务入口，含 GET /api/health
│   │   ├── db/             # 数据库连接 / 建表 / 种子数据
│   │   ├── routes/         # 路由（HTTP 层）
│   │   ├── services/       # 查询逻辑（SQL 层）
│   │   └── lib/            # 通用工具（时间等）
│   ├── scripts/     # init-db.js（初始化）、verify-db.js、verify-api.js（验证）
│   └── data/        # SQLite 数据库文件（已加入 .gitignore）
└── docs/            # 项目文档
```

## 已实现功能

- 前端只读数据首页（账户概览 / 交易流水 / 银行卡 / 订阅与代扣，含月份筛选与分页）
- 后端健康检查接口 `GET /api/health`
- 前端四个数据分区通过 `/api` 代理真实请求后端
- Vite 开发服务器将 `/api` 请求代理到 `http://localhost:3000`
- SQLite 文件数据库（6 张基础表）+ 可重复执行的模拟数据初始化脚本
- 只读数据查询接口：`/api/accounts`、`/api/transactions`、`/api/cards`、`/api/subscriptions`

## API 接口

- `GET /api/health` — 健康检查
- `GET /api/accounts` — 账户列表
- `GET /api/transactions` — 交易流水（支持 `month`、`limit`、`offset`）
- `GET /api/cards` — 银行卡列表（仅掩码卡号）
- `GET /api/subscriptions` — 订阅与代扣列表

> 单用户演示模式：服务端固定演示用户「张三」，尚未实现登录认证。详细约定见 `docs/api.md`。

## 大模型接入配置（DeepSeek）

后端已预留 DeepSeek 配置与独立连接检查，尚未接入业务功能（聊天页面未开发）。

### 1. 配置密钥

1. 复制模板 `backend/.env.example` → `backend/.env`（项目已生成空模板）。
2. 在 `backend/.env` 中填入真实密钥：

   ```
   DEEPSEEK_API_KEY=你的真实密钥
   DEEPSEEK_BASE_URL=https://api.deepseek.com
   DEEPSEEK_MODEL=deepseek-v4-pro
   ```

> `.env` 已加入 `.gitignore`，不会提交到版本控制；`.env.example` 保留可提交。
> 密钥只在后端使用，不下发前端；未配置密钥时，数据库与查询接口不受影响。

### 2. 连接测试

```bash
cd backend
npm run ai:check
```

- 未填密钥：提示填写，不发请求。
- 已填密钥：通过官方 Chat Completions 接口发起一次最小对话（仅发送「请回复：连接成功」），确认模型真正返回文本。
- 日志仅输出成功状态、模型名与简短回复；失败时输出脱敏后的状态码与中文说明。

## 启动方式

### 环境要求

- Node.js（建议 18 及以上，已确认 v24.21.0）
- npm

### 1. 安装依赖

```bash
# 后端
cd backend
npm install

# 前端（新开终端，回到项目根目录）
cd ../frontend
npm install
```

### 2. 初始化数据库（首次）

```bash
cd backend
npm run db:init
```

> 数据库文件保存为 `backend/data/rongzhi.db`（已加入 .gitignore）。
> 重复执行不会重复插入、不会清空已有数据。表结构与模拟数据说明见 `docs/database-design.md`。

### 3. 启动后端（端口 3000）

```bash
cd backend
npm run dev       # 开发模式（nodemon 自动重启）
# 或
npm start         # 直接启动
```

### 4. 启动前端（端口 5173）

```bash
cd frontend
npm run dev
```

### 5. 访问

- 前端首页：http://localhost:5173/
- 后端健康检查：http://localhost:3000/api/health

打开首页即可看到四个只读数据分区（账户 / 交易 / 卡片 / 订阅），数据来自后端只读接口。

### 6. 验证（可选）

```bash
cd backend
node scripts/verify-db.js    # 数据库验证（独立临时库）
node scripts/verify-api.js   # 接口验证（独立临时库 + 独立端口）
```
