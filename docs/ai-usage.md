# AI 用量记录

记录本项目开发与验收过程中对真实 DeepSeek 模型的调用次数与 token 用量（不含密钥信息）。

## 说明

- 模型：`deepseek-v4-pro`（`backend/.env` 的 `DEEPSEEK_MODEL`）。
- 协议：Chat Completions（非流式），`stream:false`、顶层 `thinking:{type:"disabled"}`。
- 连接检查与助手回复的 `max_tokens` 分开配置：连接检查 128、助手回复 1024。
- token 用量取自接口返回的 `usage`，为模型侧计费口径；实际结算以服务商账单为准。

## 用量明细

| 日期 | 用途 | 请求数 | prompt_tokens | completion_tokens | total_tokens |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 2026-10-21 | AI 助手真实模型冒烟测试（3 条用户问题） | 1 次会话（3 轮用户消息，内部含工具调用多轮模型请求） | 5438 | 207 | 5645 |
| 2026-10-21 | AI 助手转账真实模型冒烟测试（3 条用户消息，独立临时库，不自动确认） | 1 次会话（3 轮用户消息，内部含工具调用多轮模型请求） | 16960 | 831 | 17791 |

## 记录规则

- 仅记录真实模型的调用；`node scripts/verify-assistant.js` 使用 mock 模型，不计入。
- `npm run ai:check`（连接检查）每次成功/失败各算 1 次真实请求，单独记录用途与 token。
- 不记录、不展示密钥、Authorization、完整请求/响应内容。
