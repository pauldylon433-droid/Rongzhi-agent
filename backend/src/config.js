// 后端配置模块：在模块加载时即从固定的 backend/.env 路径读取本地配置（密钥只在后端使用）。
// 采用 Node.js 内置 process.loadEnvFile（Node 20.12+ / 21.7+，本项目 v24），无需额外依赖。
// 缺失 .env 时静默跳过；不覆盖已存在的环境变量；未配置密钥时，数据库与查询接口仍可正常使用。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url)) // backend/src
const BACKEND_DIR = join(MODULE_DIR, '..') // backend
export const ENV_PATH = join(BACKEND_DIR, '.env')

// 公网演示模式（PUBLIC_DEMO=1）只使用真实环境变量，不加载 backend/.env，
// 避免把本地开发密钥 / 配置无意带到公网实例；本地模式保持原行为。
if (process.env.PUBLIC_DEMO !== '1') {
  try {
    process.loadEnvFile(ENV_PATH)
  } catch {
    // .env 不存在或无法解析时跳过，走默认值与缺省判断
  }
}

// DeepSeek 配置（缺省使用模板默认值；密钥为空表示未配置）
export function getDeepSeekConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  }
}

// 是否已填写 AI 密钥（真实密钥由用户填写后生效）
export function hasAiKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY && String(process.env.DEEPSEEK_API_KEY).trim())
}

// —— 公网演示模式（PUBLIC_DEMO=1，显式开启）——
// 仅在 Render 等公网演示环境使用：共享访问口令、独立演示库、AI 默认关闭。
export function isPublicDemo() {
  return process.env.PUBLIC_DEMO === '1'
}

// 读取公网演示配置（只返回是否配置的布尔值 / 数值，绝不打印密钥或口令内容）
export function getPublicDemoConfig() {
  const num = (name) => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return {
    accessPasswordConfigured: Boolean(process.env.DEMO_ACCESS_PASSWORD),
    aiEnabled: process.env.PUBLIC_AI_ENABLED === '1',
    aiRateLimitPerMin: num('PUBLIC_AI_RATE_LIMIT_PER_MIN'),
    aiDailyCallQuota: num('PUBLIC_AI_DAILY_CALL_QUOTA'),
    aiMaxConcurrency: num('PUBLIC_AI_MAX_CONCURRENCY'),
    verificationConfigured: Boolean(
      process.env.VERIFICATION_KEY && process.env.DEMO_VERIFICATION_PASSWORD && process.env.DEMO_TOTP_SECRET,
    ),
  }
}

// 公网模式启动前校验：缺少访问口令必须拒绝启动；显式开启 AI 时必须配置限流 / 配额 / 并发与模型密钥。
// 返回缺失项名称数组（只含环境变量名，不含任何值）。
export function validatePublicConfig() {
  if (!isPublicDemo()) return []
  const missing = []
  if (!process.env.DEMO_ACCESS_PASSWORD) missing.push('DEMO_ACCESS_PASSWORD')
  if (process.env.PUBLIC_AI_ENABLED === '1') {
    if (!hasAiKey()) missing.push('DEEPSEEK_API_KEY')
    const c = getPublicDemoConfig()
    if (!c.aiRateLimitPerMin) missing.push('PUBLIC_AI_RATE_LIMIT_PER_MIN')
    if (!c.aiDailyCallQuota) missing.push('PUBLIC_AI_DAILY_CALL_QUOTA')
    if (!c.aiMaxConcurrency) missing.push('PUBLIC_AI_MAX_CONCURRENCY')
  }
  return missing
}
