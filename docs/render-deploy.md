# Render 部署说明（免费 Web Service · 公网演示）

> 目标：前后端通过**一个 HTTPS 网址**访问；所有 API 为同源 `/api`；使用独立模拟数据；
> 保留现有确认、交易密码 + TOTP、失败锁定、防重放、归属校验与幂等机制。
> 不购买域名、不启用付费资源、不自动发布（`render.yaml` 中 `autoDeploy: false`）。

## 一、服务类型与套餐

| 项目 | 取值 |
| ---- | ---- |
| 服务类型 | **Web Service**（Node 运行时） |
| 套餐 | **Free** |
| 构建命令 | `npm --prefix backend ci && npm --prefix frontend ci && npm --prefix frontend run build` |
| 启动命令 | `node backend/src/index.js` |
| 健康检查路径 | **`/api/health`**（不要求访问口令；只返回服务状态，不泄露配置） |
| Node 版本 | 环境变量 `NODE_VERSION=22.14.0`；`package.json` 的 `engines` 为 `>=20.12 <25` |
| 磁盘 | 无持久磁盘（免费方案不支持）；见「数据与休眠」 |

也可以不使用 Blueprint：在 Render 控制台手动创建 Web Service，构建 / 启动命令与上表一致。

## 二、环境变量

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `PUBLIC_DEMO` | 是（填 `1`） | 显式开启公网演示模式 |
| `DEMO_ACCESS_PASSWORD` | **是** | 共享访问口令；**缺失时服务拒绝启动** |
| `NODE_VERSION` | 建议 | 固定 Node 版本，避免默认版本变化 |
| `PUBLIC_AI_ENABLED` | 建议 `0` | 公网 AI **默认关闭**；填 `1` 才允许自然语言助手 |
| `DEEPSEEK_API_KEY` | 开启 AI 时必填 | 仅从后端环境变量读取，不写仓库 |
| `PUBLIC_AI_RATE_LIMIT_PER_MIN` | 开启 AI 时必填 | 每 IP 每分钟请求上限 |
| `PUBLIC_AI_DAILY_CALL_QUOTA` | 开启 AI 时必填 | 每日模型**调用次数**上限（含工具循环内多次调用） |
| `PUBLIC_AI_MAX_CONCURRENCY` | 开启 AI 时必填 | 同时进行的模型调用上限 |
| `VERIFICATION_KEY` | 可选 | 公网强验证主密钥（base64 32 字节）；公网模式**不读取**本地 `.verification-key` |
| `DEMO_VERIFICATION_PASSWORD` | 可选 | 公网首次绑定的交易密码（≥8 位） |
| `DEMO_TOTP_SECRET` | 可选 | 公网首次绑定的 TOTP Base32 密钥 |
| `STATIC_DIR` | 可选 | 前端构建目录；默认 `frontend/dist` |

> 敏感项在 Render 控制台填写（Blueprint 中为 `sync: false`），不要写入仓库或截图。
> 若 `PUBLIC_AI_ENABLED=1` 但缺少模型密钥或三项配额配置，服务会**拒绝启动**，不会默认无限调用。

## 三、访问口令（服务端保护）

- 公网模式下使用 **HTTP Basic Auth**（用户名固定 `demo`，口令为 `DEMO_ACCESS_PASSWORD`），
  由服务端中间件统一校验，覆盖页面静态资源与全部业务 API；不是前端隐藏入口。
- 浏览器首次访问会弹出登录框；同一源后续请求自动携带。请通过 HTTPS 访问。
- `/api/health` 例外，便于 Render 健康检查；不返回任何配置或环境变量。
- **这是共享模拟环境的访问口令，不是多用户登录系统**：所有访问者共享同一份演示数据与同一演示用户。

## 四、数据与休眠

- 公网模式使用独立数据库 `backend/data/public-demo.db`（或 `DB_PATH` 指定），
  **只在文件不存在时**初始化：基础模拟数据 + 第二张借记卡 + 一张信用卡及代表性样例；
  不读取、复制或修改开发库；公网模式若 `DB_PATH` 指向开发库 `data/rongzhi.db` 会拒绝启动。
- 初始化数据不含任何个人会话、操作记录、验证绑定或密钥。
- 免费实例**闲置约 15 分钟后休眠**，再次访问需要冷启动；免费方案无持久磁盘，
  实例重启 / 重新部署后文件系统重置，**演示数据会重新初始化**（期间的演示操作丢失）。
- 因此请不要在公网实例中保存任何需要保留的数据。

## 五、AI 与费用限制

- 公网 AI **默认关闭**（未开启时 `/api/assistant/chat` 返回 503，查询与手动操作仍可用）。
- 显式开启后：
  - 按 IP 请求限流（每分钟）；
  - 全局每日模型调用配额（工具循环内每次调用都计数）；
  - 全局并发上限；
  - 触达限制返回 429，不会继续调用模型。
- 配额为**内存态**，服务重启 / 休眠冷启动后**清零**；按 UTC 自然日切换。
- 这些是**调用次数与并发限制，不是人民币费用硬上限**：实际费用仍取决于模型定价与每次请求的输入输出长度。
  若不希望产生费用，请保持 `PUBLIC_AI_ENABLED=0`，不要配置 `DEEPSEEK_API_KEY`。
- 未配置密钥时除自然语言助手外的功能均可用。

## 六、公网首次配置强验证（可行办法）

免费实例没有持久数据，公网模式提供**环境变量驱动的首次绑定**：

1. 在本地运行（只打印随机值，不写文件、不读现有密钥）：
   ```powershell
   cd C:\Users\HUAWEI123\Desktop\rongzhi-agent\backend
   node scripts/generate-verification-env.js
   ```
   得到 `VERIFICATION_KEY` 与 `DEMO_TOTP_SECRET`；自行设置一个 ≥8 位的 `DEMO_VERIFICATION_PASSWORD`
   （不要使用本机开发环境的交易密码）。
2. 把三项写入 Render 环境变量并重新部署。
3. 实例启动时若数据库尚无验证绑定，会用这三项自动绑定一次；之后用验证器 App
   （手动输入 `DEMO_TOTP_SECRET`，SHA1 / 6 位 / 30 秒）生成动态码，即可完成红色强验证。
4. 每次冷启动数据库重置后，会按同样的环境变量重新绑定，不需要交互式终端。

**若免费环境限制**：没有持久数据库，绑定无法跨重启保留（依赖环境变量重建）；
本项目不假设 Render 免费实例提供交互式 Shell，也不把本机开发验证器或隔离验收的固定测试凭据带到公网。
未配置上述三项时，红色操作保持阻断（返回「尚未绑定验证器」），不会降级为免验证。

## 七、部署后自检

1. 访问 `https://<服务名>.onrender.com/` → 浏览器弹出访问口令 → 输入后看到页面。
2. 刷新任意前端路由（如 `/assistant`）→ 仍返回页面（SPA 回退），不是 404。
3. 未带口令访问 `/api/accounts` → 401；带口令 → JSON 数据。
4. `/api/health` → 200 JSON；`/api/does-not-exist` → **JSON 404**（不是 HTML 页面）。
5. 银行卡页应有三张卡：两张借记卡 + 一张信用卡；数据为独立演示库。

## 八、未包含 / 未承诺

- 不购买域名、不启用付费实例 / 持久磁盘 / 自动扩缩容。
- 不做多用户登录、真实银行接入、真实代扣调度、公网合规认证。
- 免费实例的休眠延迟、冷启动时间与具体限额以 Render 官方当前政策为准（本文不臆造数值）。

## 九、常见问题

- **构建时 `better-sqlite3` 原生模块报错**：确认 `NODE_VERSION` 使用 22.x；若当前 npm 禁止安装脚本，
  可在构建命令末尾追加 `&& npm --prefix backend rebuild better-sqlite3`（本项目本地已验证预编译二进制可用）。
- **页面一直 401**：浏览器未输入访问口令，或用户名不是 `demo`；可清除该站点的凭据后重试。
- **服务启动即退出**：查看日志中「公网演示模式缺少必要环境变量」列表——通常是 `DEMO_ACCESS_PASSWORD`
  或开启 AI 后的三项配额变量缺失；日志只显示变量名，不显示值。
- **红色操作提示「尚未绑定验证器」**：未配置 `VERIFICATION_KEY` / `DEMO_VERIFICATION_PASSWORD` /
  `DEMO_TOTP_SECRET`，或实例重启后环境变量被移除；按第六节重新配置即可。
- **数据在重启后回到初始状态**：免费实例无持久磁盘，属预期行为。
