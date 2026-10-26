# CloudBase 持久库适配 · 本地验证记录

日期：2026-10-25  
分支 / 工作目录：`feature/cloudbase-persistent-db` / `rongzhi-agent-cloudbase`  
本轮未执行云端建表、部署，未调用真实模型；未读取真实密钥；未提交、未推送。

## 证据分级

| 级别 | 本轮证据 | 能证明 | 不能证明 |
| ---- | ---- | ---- | ---- |
| SQLite 本地回归 | 43 个 `verify-*.js` + 前端构建 | 原有本地功能未回归 | 云端 RPC |
| PGlite SQL | `npm run cloud:verify:sql` 28 PASS / 0 FAIL | 安装 / 升级幂等、权限、事务回滚、清理、演示数据幂等 | CloudBase 网关 / 令牌 / 多连接并发 |
| PGlite 定向回归 | `npm run cloud:verify:races` 28 PASS / 0 FAIL / 3 SKIP | 锁定竞态、日累计顺序复核、会话版本合并、时间步不残留、过期视图、样例账期 | 真实多连接并发（明确 SKIP） |
| PGlite RPC 桩 + 真实 Node 路由 | `npm run cloud:verify:api` 63 PASS / 0 FAIL | 云端模式 API 契约、业务原子性、幂等、TOTP、会话、任务、统计 | 真实 CloudBase 网关与 AccessToken |
| mock 模型 + PGlite RPC 桩 + 真实 Express 路由 | `npm run cloud:verify:assistant` 48 PASS / 0 FAIL | 19 工具契约、查询、多轮建单、越权拒绝、敏感信息隔离、状态交错、AI 开关 | 真实模型行为与平台网络 |
| 真实 CloudBase | 本轮未执行（按约束不建表 / 不部署） | — | 需部署后单独记录 |

> 前置任务中的 HTTPS RPC 验收结果为 PASS 78 / FAIL 0 / SKIP 2（仅跳过 anon/authenticated 真实令牌）；
> 该结果属于 RPC 能力验收，不等同于本轮业务持久化适配的云端验收。

## 本轮六项修正的定向结果

| # | 修正 | 结果 | 证据级别 |
| - | ---- | ---- | ---- |
| 1 | 强验证失败计数原子更新 / 锁定保护 / 业务提交锁定复核 | 晚到失败不清锁、锁定后提交被阻断、被阻断单不扣款且不消费时间步 | PGlite 受控顺序；真实多连接 SKIP |
| 2 | 转账用户级 advisory lock + 完成后重新计算日累计 | 同账户、不同付款账户的受控顺序竞争均在第二单升级为强验证 | PGlite 受控顺序；真实多连接 SKIP |
| 3 | 会话保存版本检查 + 合并 + turn_id 去重 | 旧上下文保存返回 merged，保留第一 / 第二 / 第三轮；重复提交不重复写 | PGlite 受控交错；真实同时保存 SKIP |
| 4 | 业务失效不残留 TOTP 时间步 | 卡 stale、转账 expired、订阅 stale、还款 stale 均不写时间步，保留失效审计 | PGlite SQL |
| 5 | 过期只读视图 / 锁后重新取时间 / 任务对账 | 四类操作单 GET 返回 expired 且不写库；确认 / 验证落库 expired；任务回到等待选择 | 真实 Node 路由 + PGlite RPC 桩 |
| 6 | 样例账期 | 已结清 / 已出账未还 / 未出账三张账单，消费按 posted_at 归属且早于出账 | PGlite SQL |

## 已覆盖

- 账户、流水（月份 / 状态 / 账户筛选、逐笔结余与信用可用额度）、月度统计（收入 / 支出 / 还款单列 / 待入账）。
- 银行卡冻结 / 解冻（版本 CAS、强验证）。
- 订阅暂停 / 恢复 / 取消 / 更换扣款来源。
- 转账黄色确认、红色强验证、当日累计升级、幂等、防重放、过期。
- 信用卡账单查询、指定账单 / 全部已入账还款、冲抵明细、付款流水。
- 助手会话保存 / 当前恢复 / 历史列表 / 切换 / 新建。
- 订阅审查任务创建、只读节点、选择订阅、确认、对账、暂停 / 继续 / 取消。
- 强验证绑定状态、失败锁定、时间步跨单防重放。
- 审计：业务写操作在同事务写入 `rongzhi_bank_audit_logs`；回滚时不残留确认审计。
- 权限：anon / authenticated 不能执行 RPC 或访问业务表；本项目对象上 service_role 也不能直接读写业务表（但平台管理员密钥的整体权限不以该撤权为界）。
- 强验证锁定：晚到失败不清锁；锁定后已通过凭据检查的提交被业务 RPC 重新复核并阻断；失败计数使用行锁原子更新。
- 日累计：转账创建 / 确认 / 验证均接入用户级 advisory lock，完成前重新计算上海当日累计；受控顺序覆盖同账户与不同付款账户。
- 会话保存：版本检查 + 合并 + `turn_id` 去重；可见消息 / 模型上下文 / 当前指针在行锁内一致。
- 时间步：卡 / 转账 / 订阅 / 还款在业务失效（stale / expired / 失败）时不写 `totp_used_steps`，并保留失败审计。
- 过期视图：四类操作单只读查询返回 expired 但不写库；确认 / 验证在锁内重新读取时间；最近任务按有效状态对账。
- 样例账期：三张账单（已结清 / 已出账未还 / 未出账），消费按 `posted_at` 归属，出账时间晚于账期内消费。

## 明确跳过 / 未验证

- 真实 CloudBase 持久库建表与运行（本轮禁止执行）。
- 真实多连接并发：`cloud:verify:races` 中失败计数、两单日累计竞争、会话同时保存三项明确 SKIP；
  单连接 PGlite 只做受控顺序 / 交错，不能冒充真实并发。
- 真实模型调用：本轮使用 mock 模型验证工具循环，未调用真实 DeepSeek；真实模型的理解 / 注入防御需部署后复验。
- Service Role API Key 的平台实际权限范围：本地无法证明；按管理员密钥对待，详见部署文档。
- 浏览器可视化验收：本轮只做构建与 Node 级验证。

## 复现命令

```powershell
cd backend
npm ci
npm run cloud:verify:sql
npm run cloud:verify:races
npm run cloud:verify:api
npm run cloud:verify:assistant
# 或：npm run cloud:verify（全部）
# 备注：assistant 只用 mock 模型；SQLite verify-public-demo 需先构建 frontend/dist
# 原有 SQLite 回归
Get-ChildItem scripts/verify-*.js | ForEach-Object { node $_.FullName }

cd ../frontend
npm ci
npm run build
```

## 本轮实际结果

- `cloud:verify:sql`：PASS 28 / FAIL 0 / SKIP 0
- `cloud:verify:races`：PASS 28 / FAIL 0 / SKIP 3
- `cloud:verify:api`：PASS 63 / FAIL 0 / SKIP 0
- `cloud:verify:assistant`：PASS 48 / FAIL 0 / SKIP 0（mock 模型）
- SQLite `verify-*.js`：43 / 43 通过（`verify-public-demo` 需先构建 `frontend/dist`）
- 前端构建：成功
- 未执行：真实 CloudBase SQL / 部署 / 真实模型调用
