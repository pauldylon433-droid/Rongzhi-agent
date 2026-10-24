# 融智 Agent · 前端

「融智 Agent」银行 AI 智能体竞赛项目的前端（Vue 3 + Vite）。单用户演示版，全部为模拟数据。

## 技术

- Vue 3（`<script setup>` SFC）+ Vite 8
- Markdown 渲染：markdown-it + DOMPurify（助手回答严格白名单净化，`frontend/src/utils/markdown.js`）
- 开发服务器将 `/api` 代理到 `http://localhost:3000`（见 `vite.config.js`）

## 命令

```powershell
npm ci            # 精确安装依赖
npm run dev       # 启动开发服务器（默认 5173，被占用时自动顺延到 5174 等，以启动输出为准）
npm run build     # 生产构建（输出 dist/）
node scripts/verify-markdown.mjs   # Markdown 渲染与净化验证（32 项，jsdom + dompurify）
```

## 说明

- 页面分区：账户概览 / 模拟转账 / AI 助手 / 月度账单分析 / 交易流水 / 银行卡 / 订阅 / 跨场景任务。
- 前端不持有任何密钥（AI 密钥、加密主密钥、交易密码 / TOTP 均只在后端）。

完整部署、配置、备份与测试说明见项目根目录 `README.md`。
