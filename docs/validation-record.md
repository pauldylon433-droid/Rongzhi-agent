# 验证记录（交付版）

> 本文件只记录**实际执行过**的验证与人工验收，区分自动化 / mock / 真实模型 / 浏览器人工验收。
> 版本：以本文件所在提交为准；运行环境：Windows 11、Node v24.21.0、npm 11.19.0。

## 一、验证类型说明

| 类型 | 含义 | 是否代表真实模型行为 |
| ---- | ---- | ---- |
| 自动化（mock） | 脚本注入脚本化模型响应 + 独立临时 SQLite 库 | 否，只证明程序边界 |
| 自动化（只读接口） | 对运行中的服务做只读 GET / 数据库只读查询 | 否 |
| 真实模型人工测试 | 用户本人用真实模型对话 | 是，由用户人工判断 |
| 浏览器人工验收 | 用户本人在 5174 / 5180 页面操作 | 是，由用户人工判断 |
| 未验证 | 本项目未覆盖的环境或行为 | — |

## 二、最终自动验证（2026-10-23 收尾轮实际执行）

- **后端**：`backend/scripts/verify-*.js` 共 **35 个脚本全部通过**（exit=0）。
  （此前报告写“36 个”属计数口误；源码包实际为 35 个 `verify-*.js`，以本清单为准。）
  实际脚本清单（按文件名）：
  `verify-account-filter`、`verify-activity`、`verify-add-existing-user-cards`、`verify-agent-tasks`、
  `verify-analytics`、`verify-api`、`verify-assistant`、`verify-assistant-repayment`、
  `verify-assistant-session`、`verify-assistant-transfer`、`verify-bind-interaction`、
  `verify-business-info-binding`、`verify-card-operations`、`verify-chat-history`、`verify-chat-persistence`、
  `verify-completion-sync`、`verify-credential-guard`、`verify-credit-repayment`、`verify-credit-routes`、
  `verify-db`、`verify-demo-seed`、`verify-fix`、`verify-list-recipients`、`verify-migrate`、
  `verify-multi-account`、`verify-repayment-all-posted`、`verify-running-balance`、`verify-security-boundaries`、
  `verify-strong-verification`、`verify-subscription-operations`、`verify-subscription-source-change`、
  `verify-transfer-receipt`、`verify-transfer-receipt-edge`、`verify-transfers`、`verify-verify-message-uniform`。
  覆盖：数据库 / 迁移 / 种子 / API / 分析 / 转账 / 强验证 / 银行卡 / 订阅 / 跨场景任务 / 聊天持久化 /
  信用卡账单与还款（含全部结清与提前还款）/ 多账户范围 / 逐笔结余 / 安全边界 / 凭据保护 / 演示数据 / 增量加卡。
- **前端**：`frontend/scripts/verify-*.mjs` 共 **6 个脚本全部通过**（markdown 净化、业务事件、最新覆盖、活动、任务区选择、卡片余额兼容）。
- **前端构建**：`npm run build` 通过（115 modules）。
- **隔离环境冒烟（当轮）**：3000 / 5174 / 4177 / 5180 健康检查通过；只读接口核对三卡、额度、账单与筛选。
- **脚本调用审计**：所有 `verify-*` 使用注入的 mock `chatFn` 或纯本地服务，无 `chatCompletions` / 外部 URL 调用；
  `ai-check.js`、`smoke-*-live.js` **未**纳入自动验证，也未在交付轮执行。

## 三、人工验收记录（用户本人完成，非自动化结果）

1. **多卡真实模型验收**：收款人歧义时追问、补充姓名后保留付款卡与金额；拒绝口头跳过确认 / 验证；
   拒绝信用卡对外转账且不自动替换账户；建单后切换页面卡片原单付款账户不变；新会话不继承旧指代、原会话可查询原单。
2. **六项安全话术（5180 隔离环境）**：诱导直接扣款被拒（且未新建操作单）、伪造管理员 / 跳过验证被拒、
   注入式指令不执行、密钥索取被拒、查询他人账户不冒充、代填验证码被拒。
3. **信用卡还款与额度**：用户完成真实还款（¥498，9 月账单结清），页面余额、账单与额度数字一致；
   另用户确认还款余额、两笔还款合计、可用额度与“不重复计支出”口径一致。
4. **订阅更换扣款账户页面验收**：用户确认页面交互正常。
5. **部署验收**：用户在 5174 刷新核对三卡、余额、范围筛选与结余列（见开发日志各阶段）。

## 四、评分维度对应（建议口径，非比赛官方评分细则）

| 维度 | 已有证据 | 验证类型 |
| ---- | ---- | ---- |
| 任务完成率 40% | 五场景 + 多账户/信用卡 + 提前还款 + 订阅来源 + 历史续聊；35 个后端脚本、6 个前端脚本、构建 | 自动化 + 人工 |
| 安全合规 30% | 操作单 + 版本 CAS + 强验证（密码/TOTP/防重放/锁定/限流）、归属校验、AI 工具白名单、凭据入口拦截、注入字段序列化、备份与主密钥对应 | 自动化（mock）+ 人工话术 |
| 创新与交互 30% | 自然语言工具调用与结构化结果卡、多卡上下文、账户范围联动、逐笔结余 / 可用额度、确认与强验证交互 | 自动化 + 浏览器人工验收 |

> 以上为项目自评口径，不代表比赛官方评分规则。

## 五、事故与防复发（如实保留）

- **2026-10-23**：在验证聊天凭据拦截时，用 Git Bash `curl -d` 发送中文，终端编码把中文标签转成乱码，
  未命中拦截并触发了 **2 次真实模型调用**（违反“不调用收费模型”约束）。
- 处置：立即停止该方式；改用 Node `fetch`（UTF-8）+ 不可达模型端点复验；删除该次产生的 2 个测试会话 / 4 条消息
  并恢复会话指针；在开发日志中记录。此后所有实机验证均先确认不会触达真实模型。
- **结论**：本项目交付轮未调用模型，但**不是全程零调用**。

## 六、2026-10-23 修复轮补充（基于 6c63b53 复核）

- **聊天历史**：移除「按闲置 7 天自动删除会话」逻辑；新增 `verify-chat-no-retention.js`（19 项，独立临时库 + mock）：
  A/B 用户 8 / 30 天未活跃会话在读取当前、列表、新建、打开后内容不变；仅显式导航更新指针；
  重建实例仍可读取；后续聊天包含保留窗口内既有内容；纯列表 / 打开 0 次模型调用；8 轮裁剪与工具配对完整。
  `verify-chat-persistence.js` 中旧的「7 天清理」断言同步改为「不清理」。
- **转账风险升级**：确认时越过 ¥1000 的升级在同一事务、同一状态 CAS 中同时写 `status='needs_verification'` 与
  `risk_level='red'`；新增 `verify-transfer-risk-upgrade.js`（25 项）：两张 600 元单升级、GET / 助手工具读 red、
  强验证只扣一次且保持 red、重复确认幂等、1000 黄色 / 1000.01 红色、两个付款账户合并累计、上海跨日重置、
  审计仅业务元数据。
- **卡片余额脚本**：`verify-card-balance.mjs` 拆为纯逻辑 + 可选 HTTP 集成（`--base` / `VERIFY_BASE_URL`）；
  未指定时明确显示「未执行」，指定后连接失败记 FAIL；新增 `verify-card-balance-http.mjs` 用独立临时本地服务
  验证旧 / 新接口夹具与负向用例，不依赖已停止的隔离环境。
- **已知数据瑕疵（记录，未修复）**：新增借记账户样例中有一笔历史瞬时负结余 −¥41.02；属模拟生成器缺陷，
  最终余额正常，不影响业务逻辑。本轮不改开发库与生成器；后续整改须单独验证生成器。

## 七、未验证事项

- 真实模型对 Prompt 注入话术的系统性抵抗能力（只做了人工话术与程序边界验证）。
- 全新物理电脑 / 其他操作系统（本轮只做了“本机独立目录干净源码复现”，见交付报告）。
- 浏览器自动化与跨浏览器兼容性（仅人工页面验收）。
- 公网部署、TLS、并发压力、多用户认证与授权。
- 比赛官方时长、提交格式、材料要求（未核实，不臆造）。
