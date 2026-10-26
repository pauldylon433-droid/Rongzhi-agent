# 比赛要求补齐 · 需求追踪与证据（2026-10-26）

## 基线

- 主项目：`rongzhi-agent`，master，9ed8efd；含公网 Render 部署配置与本机业务库 / 密钥 / 备份。
- 最新本地开发：`rongzhi-agent-cloudbase`，worktree，原分支 `feature/cloudbase-persistent-db`，阶段提交 `536497f`。
- 本轮独立分支：`feature/competition-requirements`（从 536497f 创建，不覆盖原工作区）。
- 远端 main 用户确认是 `d79d037c51bf386849dfbbf4b22e446fd4c5b3ce`；本地与远端不同，且网络不可达，无法确认公网部署对应提交。
  **未合并、未推送、未强制覆盖远端；安全地在本地独立副本继续。**
- 本机开发库 / 公网业务数据 / 验证绑定 / 真实密钥未修改；未调用收费模型；未执行云端 SQL / 部署。

## 逐条追踪

| 要求 | 实现位置 | 测试 / 证据 | 状态 |
| ---- | ---- | ---- | ---- |
| A1 业务事实以服务端为准，四类操作单一致权威回执 | `services/assistant.js`（转账 / 还款 / 卡 / 订阅上下文与 post-generation 替换）、`cloud/assistant.js`、`services/card-operations.js`、`services/subscription-operations.js` | `verify-authoritative-receipts.js`（6 项）；cloud assistant 测试（卡 / 订阅回执 2 项） | PASS（本地 SQLite + Cloud RPC 桩） |
| A2 最新状态重新读取，不沿用建单时聊天 | `get_transfer_status` / 卡 / 订阅 / 还款状态工具；`refreshReadonly`；系统提示权威回执 | `verify-assistant.js`、`verify-security-boundaries.js`、cloud assistant 测试 | PASS |
| A3 关键事实结构化、不得补造成功 / 金额 / 流水号 | 工具结果 JSON + 系统提示；四类 post-generation 权威替换；业务审计 | `verify-authoritative-receipts.js`；`verify-assistant.js`；cloud assistant 测试 | PASS |
| A4 修复“界面已成功，助手仍说待确认” | 四类 `build*StatusReply` / `cardStatusReply` / `subscriptionStatusReply` | 本地回执测试；cloud 回执测试 | PASS |
| A5 查询失败 / 对象不明 / 数据陈旧时兜底 | 工具错误返回 `status:error`，不伪造 data；系统提示禁止补造；未知 / 额外参数拒绝 | `verify-assistant.js`、`verify-security-boundaries.js` | PASS（未做真实模型行为验证） |
| A6 AI 月度分析账户范围 | `get_monthly_analytics` 新增 `account_id`；本地归属校验；云端快照过滤 | `verify-assistant.js` 1.9 / 1.10 | PASS |
| B1 服务端统一风险 / 权限，客户端 / 模型不能降级 | 创建 / 确认 / 验证接口服务端判定；模型工具无确认 / 扣款权限 | `verify-transfers.js`、`verify-strong-verification.js`、`verify-security-boundaries.js` | PASS |
| B2 上海当日完成转账累计，确认时并发保护内重算 | 本地 SQLite 事务；云端 `internal_transfer_user_lock` 用户级 advisory lock + 重算 | `verify-transfers.js`、`verify-races.js`（同账户 / 不同账户受控顺序；真实多连接 SKIP） | PASS（受控顺序；真实并发未执行） |
| B3 操作单冻结账户 / 对象 / 金额 / 版本 / 有效期 | 四类操作单字段快照 + 版本 CAS + 过期校验 + 锁后重新取时间 | 现有 verify-* + `verify-races.js` | PASS |
| B4 工具白名单 / 参数 / 归属 / 确认 / 强验证独立生效 | `TOOL_DEFS` 19 个；`executeTool` 校验；未知 / 额外参数拒绝 | `verify-security-boundaries.js`、`verify-assistant.js` | PASS |
| B5 用户输入 / 备注 / 名称 / 工具输出不能改变权限 | 系统提示数据边界 + 工具权限固定 + 凭证拦截 | `verify-security-boundaries.js`（恶意名称 / 角色标签 / 伪造回执） | PASS |
| B6 直接 / 间接 / 多轮注入与伪造回执 | 系统提示 + 工具白名单 + 无确认工具 + 权威状态回读；`plan_workflow` 只建计划 | `verify-security-boundaries.js`；`verify-assistant.js` | PASS（mock 模型；真实模型未调用） |
| C1 请求 / 会话 / 计划 / 工具 / 操作单 / 回执关联编号 | `services/audit-trail.js`；`audit_events` 表；assistant request / tool / reply；API 中间件；计划审计 | `verify-audit.js`、cloud assistant 审计测试 | PASS |
| C2 记录意图 / 待补信息 / 计划版本 / 工具 / 风险 / 确认结果 / 拒绝 / 中断 / 人工接管 | audit details（工具 args / error / duration / plan_id / op_ref）；计划动作审计 | `verify-audit.js`、`verify-workflows.js` | PASS（意图以工具序列表示，不记录思维链） |
| C3 密码 / 验证码 / 种子 / API Key 不入审计 / 模型 | `audit-trail` 脱敏；credential-guard；测试 | `verify-audit.js`、`verify-security-boundaries.js` | PASS |
| C4 受保护时间线查询 / 导出 | `/api/audit/timeline`、`/api/audit/export`；`AUDIT_ACCESS_TOKEN`，未配置返回 404 | `verify-audit.js`、cloud assistant 审计测试 | PASS |
| C5 关键成功审计与业务原子提交；安全失败不被回滚 | 业务 `audit_logs` 在业务事务；安全事件独立提交 | `verify-audit.js`、`verify-races.js`、`verify-sql.js` 回滚测试 | PASS |
| D1 连续 5 次凭据错误锁定 15 分钟，多实例一致 | `verification_failures` 行锁 + `record_failure` 原子更新 | `verify-races.js`（PGlite / SQL）；真实多实例未执行 | PASS（DB 逻辑）；真实多实例 SKIP |
| D2 可配置越权 / 非法工具 / 参数异常检测 | `services/security-guard.js`：按 scope 统计服务端拒绝 / 工具拒绝，阈值 / 窗口 / 锁定可配置 | `verify-security-controls.js`；cloud assistant 安全测试 | PASS |
| D3 区分请求限流 / 强验证锁定 / 可疑锁定 / 模型熔断 | `lib/rate-limit.js`、`verification_failures`、`security-guard`、`createModelBreaker` | `verify-security-controls.js` | PASS |
| D4 触发窗口 / 阈值 / 范围 / 恢复 / 审计 | `SECURITY_ANOMALY_*`、`MODEL_BREAKER_*`；scope=IP / 会话；锁定事件入审计 | `verify-security-controls.js` | PASS |
| D5 单个访客不能锁死整个服务 | scope_key 隔离（IP / 会话），测试其他 IP 不受影响 | `verify-security-controls.js`；cloud 安全测试 | PASS |
| E1 真实代码沙箱：脱敏流水分析，隔离、无网络 / 文件 / 密钥、资源限制 | `services/sandbox.js`：QuickJS WebAssembly 独立运行时；输入脱敏；无 require / process / fetch / fs；内存 / 栈 / 墙钟 / 输出 / 代码长度限制；不暴露业务写接口 | `verify-sandbox.js`（正常 / 宿主访问 / 超时 / 内存 / 输出 / 代码长度 / 脱敏）；assistant 工具集成测试 | PASS（WASM 隔离；不是 OS 容器） |
| E2 记录执行摘要 / 限制 / 耗时 / 退出状态 / 脱敏结果 | sandbox `summary`（sandbox / status / elapsed / limits / input_rows / output_bytes / code_sha256）；工具结果标注 non-authoritative | `verify-sandbox.js`、assistant / cloud assistant 测试 | PASS |
| E3 沙箱输出不得当余额 / 交易事实 | `authoritative:false` + note；系统提示；工具只返回分析结果 | `verify-assistant.js`、cloud assistant 测试 | PASS |
| F1 模型结构化计划 + 服务端白名单 / 依赖 / 参数 / 权限 / 无环 / 步骤上限 | `services/workflow-plans.js` `validateSteps`；`plan_workflow` 工具；API `/api/workflows` | `verify-workflows.js`；cloud assistant DAG 测试 | PASS |
| F2 信息缺失先澄清；依赖未满足不执行 | 计划选择前校验前置节点；`select` 拒绝依赖未完成；AI 系统提示 | `verify-workflows.js`；`verify-assistant.js` | PASS |
| F3 计划 / 进度持久化，刷新 / 重启 / 重试不重复副作用 | SQLite `workflow_plans`；CloudBase `rongzhi_bank_workflow_plans`；版 CAS；操作单幂等 | `verify-workflows.js`；cloud assistant DAG 测试 | PASS |
| F4 暂停 / 继续 / 取消 / 重试 / 修改未执行步骤 / 人工接管 | `pause` / `resume` / `cancel` / `retry` / `modify` / `manual`；API 路由 | `verify-workflows.js` | PASS |
| F5 修改金额 / 对象 / 账户后原确认失效 | `modify` 取消待确认操作单并重置交互节点；旧单不可再确认 | `verify-workflows.js`（旧单 cancelled） | PASS |
| F6 回退只适用于未执行步骤 / 失败；不撤销已完成扣款 | `resetInteractive` / `resetAll`；已完成计划拒绝修改；操作单状态以真实状态核验 | `verify-workflows.js`（已完成计划拒绝修改） | PASS |
| F7 两条链跑通 | 订阅链：本地全链（选择→暂停→确认→核验）+ 换来源强验证；还款链：本地全链（账单→范围/账户→建单→TOTP 强验证→核验）；CloudBase 订阅全链、还款建单/取消 | `verify-workflows.js`；cloud assistant DAG 测试 | PASS（云端还款强验证端到端未执行） |
| G1 两张借记卡独立账务 / 筛选 | 现有账户 / 流水 / 统计服务；账户筛选测试 | `verify-multi-account.js`、`verify-account-filter.js`、`verify-running-balance.js` | PASS |
| G2 信用卡占额 / 入账 / 账单 / 提前还款 / 额度恢复 / 逐笔额度 | 现有 `services/credit.js`、`services/transactions.js` | `verify-credit-repayment.js`、`verify-repayment-all-posted.js`、`verify-running-balance.js` | PASS |
| G3 还款不重复计收支，待入账不计可还 | `services/analytics.js`、`services/credit.js` | `verify-analytics.js`、`verify-credit-repayment.js` | PASS |
| G4 订阅状态 / 版本 / 换来源 | `services/subscription-operations.js` | `verify-subscription-operations.js`、`verify-subscription-source-change.js` | PASS |
| G5 选卡不改变已生成操作单 | 操作单快照 + 前端当前卡仅作查询上下文 | `verify-transfers.js`、`verify-card-operations.js` | PASS |
| G6 确认 / 验证 / 取消 / 过期 / 重复 / 并发一致 | 现有服务 + 本轮锁 / 过期 / TOTP 修复 | 43 个本地 verify-*；cloud 28/28/63/48 | PASS（真实多连接并发 SKIP） |
| G7 重复错误提示 / 未绑定 / 锁定 / 失效下一步 | 路由 / 服务错误映射 + 前端提示 | `verify-strong-verification.js`、`verify-security-boundaries.js` | PASS（浏览器交互未自动化） |
| G8 本地 SQLite 与 CloudBase 公共功能一致 | 双模式服务 / 路由 / 计划 / 审计 / 安全 / 沙箱 | 43 本地 + 28 SQL + 28 races + 63 API + 48 assistant | PASS（真实 CloudBase 未执行） |
| G9 模拟边界不变 | 未扩展理财 / 真实银行 / 自动代扣 | 代码审查；无相关写接口 | PASS |

## 实际测试汇总（本轮）

- 本地 SQLite：**43 / 43 通过**（原 38 + 回执 / 审计 / 沙箱 / 安全控制 / DAG 计划 5 个新脚本）。
- CloudBase SQL（PGlite）：**PASS 28 / FAIL 0**。
- 定向竞态（PGlite）：**PASS 28 / FAIL 0 / SKIP 3**。
- CloudBase API 集成（真实 Node 路由 + PGlite RPC 桩）：**PASS 63 / FAIL 0**。
- CloudBase AI / DAG / 审计 / 安全（mock 模型 + 真实 Express 路由）：**PASS 48 / FAIL 0**。
- 前端构建：成功。
- 真实 CloudBase、真实模型、真实多连接并发、浏览器自动化：**未执行 / SKIP**。

## 明确未完成 / 边界

1. **真实 CloudBase 部署与真实多连接并发未执行**；三项竞态测试记 SKIP，不以单连接 PGlite 冒充。
2. **真实模型未调用**；AI 行为仅用 mock 模型验证工具循环、注入拒绝与回执替换；真实模型抗注入需后续受控验证。
3. **代码沙箱是 QuickJS WebAssembly 隔离**，不是 OS 容器 / Docker。它无网络、无文件系统、无 Node 宿主绑定，有内存 / 栈 / 时间 / 输出限制，并已实际跑通越权与资源耗尽测试；如赛题强制要求独立 OS 容器，需在部署环境补 Docker / Firecracker 级隔离。
4. **新通用 DAG 计划暂无专用前端页面**：后端 API、AI 工具、订阅 / 还款操作单确认卡与现有任务 UI 可用；新计划卡的可视化入口尚未接入前端。现有「订阅审查」旧任务 UI 保持可用。
5. Dockerfile 已完成但本机无 Docker，未实际构建镜像。
6. 浏览器交互未做自动化；本地 SQLite 与 CloudBase 的部分真实网关 / 令牌行为未验证。
7. 本地与远端 main 不同，且远端网络不可达；未确认公网部署提交，未推送。
