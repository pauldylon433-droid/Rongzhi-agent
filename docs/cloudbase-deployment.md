# CloudBase 持久数据库部署与回退（v1）

## 首次部署：按这里填写

本流程新建融智演示服务与 `rongzhi_bank_*` 数据，保留同一环境内原有慧眼项目。
云端使用独立模拟数据，不上传本地 SQLite、聊天记录、验证器绑定或开发密钥。
代码已通过本地检查；真实云端安装、镜像构建和公网交互仍需实际执行。

### 1. 下载代码并安装数据库

从仓库 `pauldylon433-droid/Rongzhi-agent` 的 `main` 分支点击 **Code → Download ZIP**，解压。
在 `cloudbase/sql` 中，按顺序逐个用记事本打开文件，将完整内容复制到
CloudBase PostgreSQL 的 **SQL 编辑器** 执行；每个成功后再执行下一个：

1. `001_schema_v1.sql`：建立融智业务表。
2. `002_functions_v1.sql`：安装业务函数和权限。
3. `003_seed_v1.sql`：建立独立演示用户与样例数据。

前面执行过的 `rongzhi_accept_*` 验收脚本不算业务库安装。只有那些测试表时，仍按 001 → 002 → 003 首次安装。
初次安装不用执行 `010`。**不要执行 `999_cleanup_v1.sql`，它是删除本演示数据的清理脚本。**
若任一脚本报错，停在该文件，保留错误文字，不要继续执行后面的脚本。

### 2. 生成云端独立验证配置

在解压后的项目目录打开 PowerShell，执行：

```powershell
cd backend
node scripts\generate-verification-env.js
```

该命令不需要安装依赖，只生成新的随机 `VERIFICATION_KEY` 与 `DEMO_TOTP_SECRET`，不读取已有密钥、不联网。
两项值自行安全保存，稍后粘贴到控制台，**不发聊天、不放 GitHub、不截进公开图片**。
另外自行设置两个不同的密码：网站访问口令（建议至少 16 位）和云端交易密码（至少 8 位）。
在手机验证器中添加账户“融智云端演示”，选择手动输入密钥，填 `DEMO_TOTP_SECRET`，
类型 TOTP、SHA1、6 位、30 秒，与本地开发环境的验证器账户分开。

### 3. 新建云托管服务

进入同一 CloudBase 环境的 **云托管 → 新建服务 → Git 仓库部署**，使用已授权的 GitHub 仓库。

| 控制台项目 | 填写值 |
| --- | --- |
| 仓库 / 分支 | `pauldylon433-droid/Rongzhi-agent` / `main` |
| 自动部署 | 关闭 |
| 服务名称 | `rongzhi-agent`（新服务，保留慧眼原服务） |
| 服务 / 容器端口 | `3000` |
| 外部访问端口（如单独出现） | 保持平台默认 `80`，HTTPS 由平台提供 |
| 目标目录 / 构建上下文 | 仓库根目录；可留空时留空，不填 `backend` 或 `frontend` |
| Dockerfile | 选择已有，文件名 `Dockerfile` |
| 健康检查路径（如有） | `/api/health` |
| 最小 / 最大实例数 | `0` / `1` |
| 公网访问 / 默认域名 | 开启 |
| 持久磁盘 / 文件挂载 | 不添加，业务数据存 PostgreSQL |
| 自动注入平台 API Key（如有） | 关闭；下表手动填写后端专用 Key |

继续使用控制台现有免费权益，不升级、不新购资源、不打开超额按量付费。
若页面要求购买才能继续，先停在该提示。是否仍有免费额度以当前控制台为准，不承诺永久免费。

### 4. 填写环境变量

控制台每一行填一个变量，名称和值分别填写；不要在值外加引号，也不要把 `名称=值` 整行粘进“值”栏。

| 名称 | 值 |
| --- | --- |
| `PORT` | `3000` |
| `DB_MODE` | `cloudbase` |
| `PUBLIC_DEMO` | `1` |
| `CLOUDBASE_RPC_BASE` | `https://你的环境ID.api.tcloudbasegateway.com`，与此前成功验收的网关相同，不追加路径 |
| `CLOUDBASE_SERVICE_KEY` | 此前验证成功的服务端 API Key，只粘贴密钥本身，不加 `Bearer` |
| `CLOUDBASE_DEMO_USER_ID` | `1` |
| `DEMO_ACCESS_PASSWORD` | 自行设置的网站访问口令 |
| `VERIFICATION_KEY` | 上一步生成的同名值 |
| `DEMO_TOTP_SECRET` | 上一步生成的同名值 |
| `DEMO_VERIFICATION_PASSWORD` | 自行设置的云端交易密码 |
| `PUBLIC_AI_ENABLED` | `0`（先验收部署，服务不会因此调用模型） |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `PUBLIC_AI_RATE_LIMIT_PER_MIN` | `6` |
| `PUBLIC_AI_DAILY_CALL_QUOTA` | `40` |
| `PUBLIC_AI_MAX_CONCURRENCY` | `1` |

`CLOUDBASE_SERVICE_KEY` 与 DeepSeek Key、网站访问口令、交易密码都不同。
初次 `PUBLIC_AI_ENABLED=0` 时不必设置 `DEEPSEEK_API_KEY`。
不要配置本地 `DB_PATH`，不要上传开发 `.env` 或 `.verification-key`。
强验证在首次启动时绑定一次；已有绑定不会被初始化配置覆盖。

### 5. 部署与打开

SQL 三个文件都成功、表格填好后，点击 **部署**，等待构建日志和服务状态。
根目录 Dockerfile 会构建前端与后端；构建完成前不能据此声称网站可访问。

成功后复制该新服务实际给出的 HTTPS 公网地址。打开网页，用户名填 **`demo`**，
密码填 `DEMO_ACCESS_PASSWORD`。这个口令是共享演示入口，不是银行多用户登录。
先检查 `/api/health` 返回 `"database":"cloudbase"`，页面可显示三张卡、流水、信用卡账单和订阅。
记录账户金额与未结清账单，重启服务再核对，才能完成真实云端持久性验收。
AI 关闭时聊天不可用属预期，不能算 AI 对话已验收。

### 6. 需要真实 AI 时

页面和数据连通后，在同一服务增加 `DEEPSEEK_API_KEY`（自己的有效密钥，只填服务端环境变量），
把 `PUBLIC_AI_ENABLED` 改为 `1` 并应用更新。
然后由本人在网页发送“列出我的银行卡和已有收款人，只查询”，核对工具结果。
这会调用外部 DeepSeek API，费用与腾讯云免费资源分开；每日 40 次是模型调用次数（一个对话可能多次），
并非 40 次聊天或人民币硬上限，且进程重启会清零。代码准备阶段未调用真实模型。

完整验收还包括本人经专用表单输入交易密码和动态码，确认模拟业务与重启后记录保留。
真实多连接竞态和真实模型对抗结果应单独记录，不用本地 PGlite 结果替代。

## 目标与边界

- 电脑关闭后仍可访问：公网实例只保存进程状态，业务数据全部在 CloudBase PostgreSQL。
- 本地默认 `DB_MODE=sqlite`；原有 SQLite 功能与验证脚本保持不变。
- 云端模式通过后端持有 **Service Role API Key** 调用固定 RPC；容器内不保存业务数据。
- 公网 AI 默认关闭；显式开启且配置齐全时，走与本地一致的 17 个工具白名单循环。
- 本轮未执行云端建表 / 部署 / 套餐操作；助手测试使用 mock 模型，未调用真实模型。

## 架构

```
浏览器 → CloudBase 云托管（Node 容器，端口 3000）
           ├─ DB_MODE=sqlite    → backend/data/*.db（仅本地；公网不应依赖临时磁盘）
           └─ DB_MODE=cloudbase → CloudBase PostgreSQL 固定 RPC（service_role）
                                   ├─ 只读 snapshot
                                   └─ 业务写 RPC（单事务）
```

强验证密文由后端用 `VERIFICATION_KEY` 解密 / 校验；TOTP 时间步消费与业务写入在同一个业务 RPC 事务内完成。
AI 助手只调用查询 / 准备操作单 / 启动任务类工具，没有确认、扣款、验证凭据或任意 SQL 工具。

## 一、在 CloudBase DMC 执行脚本

要求 PostgreSQL 13+（使用内置 `gen_random_uuid()`、`jsonb` 与 PL/pgSQL 异常处理）。

按顺序执行（仅首次）：

1. `cloudbase/sql/001_schema_v1.sql`
2. `cloudbase/sql/002_functions_v1.sql`
3. `cloudbase/sql/003_seed_v1.sql`

已有 v1 数据库升级：先执行 `cloudbase/sql/010_upgrade_v1_1.sql`，再重新执行 `002_functions_v1.sql`。
新建数据库执行 `001` → `002` → `003`；不要重复执行破坏性脚本。
清理（仅停用演示时）：`cloudbase/sql/999_cleanup_v1.sql`。

独立演示数据包含三张信用卡账单：已结清、已出账未还、未出账；消费按 `posted_at` 归入对应账期，
出账时间不早于账期内消费。已有演示库不会被自动重置；如需新样例，请使用新用户或空库。

## 二、配置环境变量

在 CloudBase 云托管（或其它部署平台）设置：

| 变量 | 说明 |
| ---- | ---- |
| `DB_MODE` | `cloudbase` |
| `CLOUDBASE_RPC_BASE` | `https://<envId>.api.tcloudbasegateway.com`（站点根地址） |
| `CLOUDBASE_SERVICE_KEY` | Service Role API Key，仅后端；按平台管理员密钥保护 |
| `CLOUDBASE_DEMO_USER_ID` | 独立演示用户 id，默认 `1` |
| `PUBLIC_DEMO` | 公网演示设为 `1` |
| `DEMO_ACCESS_PASSWORD` | 公网访问口令（Basic Auth） |
| `VERIFICATION_KEY` | 强验证加密主密钥（base64 32 字节） |
| `DEMO_VERIFICATION_PASSWORD` / `DEMO_TOTP_SECRET` | 首次绑定用；已绑定不会覆盖 |
| `PUBLIC_AI_ENABLED` | 默认 `0`；设为 `1` 才允许助手调用模型 |
| `DEEPSEEK_API_KEY` | 开启 AI 时必填 |
| `PUBLIC_AI_RATE_LIMIT_PER_MIN` / `PUBLIC_AI_DAILY_CALL_QUOTA` / `PUBLIC_AI_MAX_CONCURRENCY` | 开启 AI 时必填，正整数 |

模板见 `backend/.env.example`。启动时只校验变量名，**不会打印任何值**。

### 关于 Service Role API Key 的实际权限范围（重要）

- 这是 **CloudBase 平台的服务端管理员密钥**，不是应用级、只含某个 RPC 的受限令牌。
  它可以作为 `service_role` 访问数据库 / PostgREST 暴露的对象；是否绕过 RLS、能否访问其它 schema /
  表 / 函数 / DDL，取决于平台配置，**本地无法证明其全部能力**。
- 本仓库的 SQL 已显式撤销 `PUBLIC` / `anon` / `authenticated` / `service_role` 对
  `rongzhi_bank_*` 表与序列的直接权限，只把固定 RPC 的 `EXECUTE` 授给 `service_role`。
  这是**本项目对象上的纵深防御**，不能推导出“平台管理员密钥只能走 RPC”。
- 若建表脚本是以 `service_role` 或对象 owner 身份执行，owner 的固有权限不会因 `REVOKE` 消失；
  对象 owner、角色成员关系与平台级能力必须由管理员在 CloudBase 侧确认。本轮未执行该云端诊断。
- “只调用固定 RPC”是**后端代码约束**（`backend/src/cloud/rpc-client.js` 白名单），不是密钥权限边界。
  因此该 Key 必须仅存放在云托管服务端环境变量中，严禁进入前端、模型上下文、仓库、日志或截图；
  一旦泄露，应按平台密钥泄露流程轮换，而不是只撤业务表权限。
- 部署后如需确认实际角色 / 权限，应由有权限的管理员在受控 DMC 会话中检查
  `current_user` / `session_user` / `has_table_privilege` 等；本轮未执行云端诊断。

## 三、初始化 / 绑定

```powershell
cd backend
# 可选：通过 RPC 再次确认初始化状态（幂等，不会重置）
npm run cloud:init

# 可选：一次性绑定强验证（已绑定返回“已绑定（未覆盖）”）
npm run cloud:bind-verification
```

`003_seed_v1.sql` 与 `cloud:init` 都只在没有账户时写入独立演示数据；不会在每次启动时重置。

## 四、部署主流程：腾讯云 CloudBase 云托管

1. 在 CloudBase 控制台开通 **云托管**，新建服务（本仓库根目录已提供 `Dockerfile`）。
2. 选择源码 / 镜像部署；容器端口填 **3000**（`PORT` 默认 3000）。
3. 填写第二节环境变量；`CLOUDBASE_SERVICE_KEY`、`DEEPSEEK_API_KEY`、`VERIFICATION_KEY` 等敏感项
   使用平台密钥配置，不要写进 Dockerfile / 仓库。
4. 不需要持久磁盘：`DB_MODE=cloudbase` 时业务数据全部在 CloudBase PostgreSQL；
   `backend/data` 即使丢失也不影响云端业务数据。
5. 部署后访问 `/api/health`，确认返回 `"database":"cloudbase"`。

本机构建镜像（可选，本轮未实际执行）：

```powershell
docker build -t rongzhi-agent .
docker run -p 3000:3000 --env-file backend/.env rongzhi-agent
```

## 五、Render 指引（次要 / 仅备用）

- Render 免费实例**没有持久磁盘**，实例休眠 / 重启 / 重新部署会重置容器文件系统；
  因此公网持久演示必须设置 `DB_MODE=cloudbase`，不能依赖容器内 SQLite。
- 仓库 `render.yaml` 已把 `DB_MODE` 设为 `cloudbase`，并关闭 `autoDeploy`。
- 在 Render 控制台填写 `sync: false` 的 `CLOUDBASE_RPC_BASE`、`CLOUDBASE_SERVICE_KEY`、
  `DEMO_ACCESS_PASSWORD`、`VERIFICATION_KEY` 等；不要把值提交到仓库。
- Render 不是本项目主部署路径；同等条件下优先 CloudBase 云托管，避免跨平台网络 / 冷启动差异。
- 若确实要用 SQLite 做临时演示，必须挂载持久磁盘并明确“重启可能丢数据”，不得对外宣称持久。

## 六、验证

本地（不连接云端，不调用真实模型）：

```powershell
cd backend
npm run cloud:verify            # SQL + 定向回归 + RPC 桩 + 助手 mock
cd ../frontend
npm run build
```

真实 CloudBase 上至少检查：

1. `GET /api/health` 返回 `database: "cloudbase"`；
2. `GET /api/accounts`、`/api/transactions`、`/api/analytics/monthly` 与前端展示一致；
3. 转账 / 卡操作 / 订阅 / 还款各完成一次正常 + 失败路径；
4. 重复确认只扣一次；强验证时间步不可跨单复用；
5. `PUBLIC_AI_ENABLED=1` 时完成一次“查询 → 工具结果 → 回复”，并确认没有确认 / 扣款工具；
6. anon / authenticated 权限项未提供真实令牌时记 SKIP，不冒充通过。

## 七、回退

- 代码回退：在云托管重新部署上一个已审阅镜像 / 版本；数据库脚本不自动回滚。
- 配置回退：将 `DB_MODE` 改回 `sqlite`（仅限有持久卷的本地 / 自管环境）。
- 数据回退：升级前先在 CloudBase 侧做备份；`999_cleanup_v1.sql` 只删除本项目对象，
  不会删除慧眼或其它项目资源，但会删除本演示全部数据，执行前必须确认。
- 密钥轮换：Service Role Key 一旦疑似泄露，按平台流程轮换；仅撤业务表权限不足以消除风险。

## 八、已知限制

- 本轮助手测试使用 **mock 模型 + PGlite RPC 桩 + 真实 Node 路由**；未调用真实模型，
  也未在真实 CloudBase 上执行助手工具循环。真实模型行为、平台网络与令牌权限需部署后复验。
- 本地 `cloud:verify:races` / `cloud:verify:api` 使用单连接 PGlite 做受控顺序 / 交错，
  真实多连接并发（失败计数、两单日累计竞争、会话同时保存）明确记 SKIP，**不能证明真实 CloudBase 并发**；
  代码中已加入用户级 advisory lock 与行锁 / 版本检查，需部署后在真实多连接环境复验。
- 强验证锁定、会话版本合并、时间步不残留、过期只读视图与样例账期均有本地定向回归；
  其中真实并发场景仍以 SKIP 记录。
- 本机未安装 Docker，`Dockerfile` 已完成静态审查但未实际构建；部署前需在目标环境构建一次。
- 部署应使用 GitHub `main` 的最新代码；原 Windows 本地分支与远端历史不同，不要强制推送旧分支覆盖它。
- 单用户演示仍无正式登录认证；应用内归属校验不等于请求者身份认证。
