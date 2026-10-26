# CLAUDE.md

银行 AI 智能体竞赛项目「融智 Agent」。前端 Vue 3 + Vite；后端 Node.js + Express 5（ESM）；数据库本地默认 SQLite（better-sqlite3，WAL），公网可选 CloudBase PostgreSQL 固定 RPC（`DB_MODE=cloudbase`）。单用户演示（张三），全部为模拟数据。

## 必要命令
- 后端：`cd backend && npm run dev`（端口 3000）或 `npm start`
- 前端：`cd frontend && npm run dev`（默认 5173，用户当前用 5174）
- 初始化数据库：`cd backend && npm run db:init`
- 前端构建：`cd frontend && npm run build`
- 验证（均用独立临时库，不碰开发库）：`cd backend && node scripts/verify-*.js`；前端 `cd frontend && node scripts/verify-markdown.mjs`
- CloudBase 适配验证（本地 PGlite / RPC 桩，不连云端）：`cd backend && npm run cloud:verify`（SQL + RPC 桩 + mock 模型助手）
- CloudBase 初始化 / 绑定：`npm run cloud:init` / `npm run cloud:bind-verification`（需后端环境变量）
- 比赛安全 / DAG / 沙箱定向验证：`cd backend && npm run verify:competition`
- 审计接口默认关闭；启用需 `AUDIT_ACCESS_TOKEN`，禁止把令牌或密钥写入日志 / 文档。

## 铁律
- 不读取 / 打印 / 复制 `backend/.env` 真实密钥；`.verification-key` 严禁提交。
- 不修改开发库业务数据；需要迁移时先做 SQLite 一致性备份。
- 不终止、不重复启动用户已运行的 3000 / 5174 服务。
- 不调用收费模型；除非用户明确要求，否则不自动 `git commit`。
- 业务 AI 只做查询与「准备操作单」，不直接执行；任何状态变更须经界面确认。
- 密码 / 验证码仅经专用接口，不进入模型、历史或日志。

## 开发约定
- 金额用整数分 `*_cents`；时间存 UTC ISO 8601，展示按 Asia/Shanghai（+8）。
- 写操作走「操作单 + 版本 CAS + 同事务审计」，重复请求不重复执行。
- 强验证（交易密码 + TOTP）跨业务共享，防重放、失败锁定与限流，普通确认不能绕过。

## 验证与汇报
- 按影响范围运行相关 `verify-*.js` + `npm run build`；浏览器未实测须如实注明。
- 完成即停止等待验收，简短如实汇报修改文件、验证结果、重启需求与耗时。
