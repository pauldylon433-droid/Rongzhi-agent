// 后端配置模块：在模块加载时即从固定的 backend/.env 路径读取本地配置（密钥只在后端使用）。
// 采用 Node.js 内置 process.loadEnvFile（Node 20.12+ / 21.7+，本项目 v24），无需额外依赖。
// 缺失 .env 时静默跳过；不覆盖已存在的环境变量；未配置密钥时，数据库与查询接口仍可正常使用。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url)) // backend/src
const BACKEND_DIR = join(MODULE_DIR, '..') // backend
export const ENV_PATH = join(BACKEND_DIR, '.env')

try {
  process.loadEnvFile(ENV_PATH)
} catch {
  // .env 不存在或无法解析时跳过，走默认值与缺省判断
}

// DeepSeek 配置（缺省使用模板默认值；密钥为空表示未配置）
export function getDeepSeekConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  }
}

// 是否已填写 AI 密钥（真实密钥由用户填写后生效）
export function hasAiKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY && String(process.env.DEEPSEEK_API_KEY).trim())
}
