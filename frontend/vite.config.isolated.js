import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 隔离验收环境专用配置：前端 /api 代理到隔离后端（而非开发库 3000），并在页面顶部注入醒目横幅。
// 与默认 vite.config.js 完全分离；不影响运行中的 5174 开发前端。
// 环境变量：ISOLATED_BACKEND 指定隔离后端地址（默认 http://localhost:4100）。
const BACKEND = process.env.ISOLATED_BACKEND || 'http://localhost:4100'

function isolatedBanner() {
  return {
    name: 'isolated-banner',
    transformIndexHtml(html) {
      const banner = [
        '<div id="isolated-banner" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#c62828;color:#fff;text-align:center;padding:6px 12px;font:700 14px/1.4 system-ui;box-shadow:0 1px 4px rgba(0,0,0,.3);">⚠ 隔离验收环境 —— 数据为独立演示库，与开发库无关</div>',
        '<style>body{padding-top:34px !important}</style>',
      ].join('')
      return html
        .replace('<title>融智 Agent</title>', '<title>融智 Agent · 隔离验收环境</title>')
        .replace('</body>', banner + '</body>')
    },
  }
}

export default defineConfig({
  plugins: [vue(), isolatedBanner()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
})
