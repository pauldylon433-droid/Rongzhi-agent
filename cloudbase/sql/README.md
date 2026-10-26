# CloudBase PostgreSQL 脚本（v1）

所有对象位于 `public` schema，统一使用 `rongzhi_bank_*` 前缀，与慧眼及其它项目对象隔离。
脚本只精确操作本项目对象，不使用 `CASCADE`，不删除无关表。

## 执行顺序

| 顺序 | 文件 | 作用 | 是否幂等 |
| ---- | ---- | ---- | ---- |
| 1 | `001_schema_v1.sql` | 建表 / 索引（`CREATE ... IF NOT EXISTS`） | 是 |
| 2 | `002_functions_v1.sql` | 固定 RPC、权限回收与授权（同一显式事务） | 是 |
| 3 | `003_seed_v1.sql` | 独立演示数据；已有账户时直接返回 | 是 |
| 升级 | `010_upgrade_v1_1.sql` | 已有 v1 数据库补会话版本 / turn 列（新建库可跳过） | 是 |
| 清理 | `999_cleanup_v1.sql` | 仅删除本项目函数与表 | 是 |

已有 v1 数据库升级顺序：`010_upgrade_v1_1.sql` → 重新执行 `002_functions_v1.sql`（幂等替换函数与权限）。
新建数据库：`001` → `002` → `003`；`010` 也会幂等执行，可作为校验。

> `002_functions_v1.sql` 会 `REVOKE PUBLIC / anon / authenticated / service_role` 对 `rongzhi_bank_*` 表与序列的直接权限，仅 `GRANT EXECUTE ... TO service_role`；
> 这只是本项目对象上的纵深防御；若 service_role 是对象 owner 或平台管理员，仍可能保留固有 / 平台级权限，不代表平台密钥整体权限被限制（见部署文档）。

## 固定 RPC 白名单

| RPC | 说明 |
| ---- | ---- |
| `rongzhi_bank_health_v1()` | 连接 / 版本健康检查 |
| `rongzhi_bank_snapshot_v1(user)` | 只读业务快照（账户 / 流水 / 卡 / 订阅 / 信用 / 操作单 / 会话 / 任务 / 审计摘要） |
| `rongzhi_bank_verification_secret_v1(user)` | 强验证绑定密文（仅后端调用） |
| `rongzhi_bank_transfer_write_v1(user, op, payload)` | 转账 create / confirm / cancel / verify |
| `rongzhi_bank_card_write_v1(user, op, payload)` | 银行卡操作 create / confirm / cancel / verify |
| `rongzhi_bank_sub_write_v1(user, op, payload)` | 订阅操作 create / confirm / cancel / verify |
| `rongzhi_bank_repay_write_v1(user, op, payload)` | 信用卡还款 create / cancel / verify |
| `rongzhi_bank_chat_write_v1(user, op, payload)` | 会话 select / new / save_turn |
| `rongzhi_bank_verification_write_v1(user, op, payload)` | 失败计数 / 重置 / 一次性绑定 |
| `rongzhi_bank_task_write_v1(user, op, payload)` | 订阅审查任务 create / reconcile / select / pause / resume / cancel / manual |
| `rongzhi_bank_seed_v1(user)` | 幂等演示数据初始化 |

`p_op` 只接受白名单值；不存在任意 SQL 文本参数。每个写调用是一个数据库事务，失败整体回滚。

## 版本化升级

- 结构变更：新增 `NNN_schema_vX.sql`（只做增量、可重复执行，不写破坏性 DROP）。
- 函数变更：新增 `NNN_functions_vX.sql`，使用 `CREATE OR REPLACE`，并在同一事务内重做权限。
- 数据变更：新增 `NNN_seed_vX.sql` 或 `NNN_migration_vX.sql`，必须幂等、不得重置业务数据。
- 清理脚本按版本保留；升级前先备份，禁止对共享库执行未审阅的 DROP。

## 本地验证（不连接云端）

```powershell
cd backend
npm ci
npm run cloud:verify:sql       # PGlite 执行真实 SQL：安装幂等 / 权限 / 事务回滚 / 清理 / 升级列
npm run cloud:verify:races     # 锁定竞态 / 日累计顺序复核 / 会话合并 / 时间步残留 / 样例账期
npm run cloud:verify:api       # PGlite RPC 桩 + 真实 Node 云路由：业务 / 回滚 / 幂等 / 过期视图 / 任务
npm run cloud:verify:assistant # mock 模型 + 真实 Express 路由：17 工具 / 建单 / 越权 / 敏感信息 / 状态交错
```

以上结果只代表本地 SQL 与 Node 适配逻辑，**不是真实 CloudBase 网关 / 令牌 / 多连接并发证据**；
`cloud:verify:races` 中真实多连接并发项明确记为 SKIP，不能用单连接 PGlite 冒充。
