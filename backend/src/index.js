import express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, DEFAULT_DB_PATH, DATA_DIR } from './db/index.js'
import { resolveDemoUser } from './demo-user.js'
import { createApiRouter } from './routes/index.js'
import { createCloudRouter } from './routes/cloud.js'
import { createCloudAssistant } from './cloud/assistant.js'
import { createAiGuard } from './lib/ai-guard.js'
import { createModelBreaker } from './services/security-guard.js'
import { chatCompletions } from './lib/ai-client.js'
import {
  isPublicDemo, getPublicDemoConfig, validatePublicConfig, hasAiKey,
  getDbMode, getCloudBaseConfig, validateCloudConfig,
} from './config.js'
import { seedPublicDemoExtras, maybeBindPublicVerification } from './db/public-demo.js'
import { createCloudRpcClient } from './cloud/rpc-client.js'
import { bindCloudVerification } from './cloud/verification.js'
import { loadVerificationKey } from './lib/verification-key.js'
import { base32Decode } from './lib/totp.js'

const PORT = process.env.PORT || 3000
const SRC_DIR = dirname(fileURLToPath(import.meta.url)) // backend/src
const BACKEND_DIR = join(SRC_DIR, '..') // backend
const publicDemo = isPublicDemo()

let dbMode
try {
  dbMode = getDbMode()
} catch (e) {
  console.error(`[启动失败] ${e.message}`)
  process.exit(1)
}

// —— 启动校验（在任何数据库连接之前）：缺少必要配置则拒绝启动，不显示具体值 ——
if (publicDemo) {
  const missing = validatePublicConfig()
  if (missing.length) {
    console.error(`[启动失败] 公网演示模式缺少必要环境变量：${missing.join('、')}（不显示具体值）`)
    process.exit(1)
  }
}
if (dbMode === 'cloudbase') {
  const missing = validateCloudConfig()
  if (missing.length) {
    console.error(`[启动失败] 云端持久库模式缺少必要环境变量：${missing.join('、')}（不显示具体值）`)
    process.exit(1)
  }
}

let db = null
let demoUser = null
let cloudClient = null
let cloudRouter = null
let cloudSnapshot = null

if (dbMode === 'cloudbase') {
  const cfg = getCloudBaseConfig()
  cloudClient = createCloudRpcClient({ base: cfg.base, serviceKey: cfg.serviceKey })

  try {
    const health = await cloudClient.health()
    if (!health || health.ok !== true) throw new Error('健康检查未返回 ok')
    cloudSnapshot = await cloudClient.snapshot(cfg.demoUserId)
    if (!cloudSnapshot || !cloudSnapshot.user) throw new Error('未找到演示用户数据')
    demoUser = { id: cfg.demoUserId, name: cloudSnapshot.user.name || '张三' }
    console.log('[CloudBase] RPC 连接正常（固定函数白名单）')
  } catch (e) {
    console.error('[启动失败] CloudBase 持久库不可用或未初始化。请先执行 cloudbase/sql/001~003 脚本。')
    console.error(`[启动失败] 原因（脱敏）：${e && e.message ? e.message : e}`)
    process.exit(1)
  }

  // 云端强验证：已绑定不覆盖；仅在未绑定且环境变量完整时做一次幂等绑定。
  const cfg2 = getCloudBaseConfig()
  const bound = cloudSnapshot.verification && cloudSnapshot.verification.bound === true
  const key = loadVerificationKey()
  if (bound) {
    console.log(key
      ? '[CloudBase] 强验证：已绑定（未覆盖）'
      : '[CloudBase] 强验证：已绑定但缺少 VERIFICATION_KEY，红色操作将保持阻断')
  } else if (cfg2.verificationConfigured) {
    const password = process.env.DEMO_VERIFICATION_PASSWORD || ''
    const secret = (process.env.DEMO_TOTP_SECRET || '').trim()
    const secretBuf = base32Decode(secret)
    if (password.length < 8 || !key || !secretBuf || secretBuf.length < 10) {
      console.log('[CloudBase] 强验证未启用（环境配置不完整或格式不正确）；红色操作保持阻断')
    } else {
      try {
        const r = await bindCloudVerification({
          client: cloudClient, userId: cfg.demoUserId, password,
          totpSecretBase32: secret.toUpperCase(), encryptionKey: key,
        })
        console.log(`[CloudBase] 强验证：${r.outcome === 'already_bound' ? '已存在（未覆盖）' : '已按环境变量初始化'}`)
      } catch (e) {
        console.log(`[CloudBase] 强验证初始化失败（脱敏）：${e && e.message ? e.message : e}`)
      }
    }
  } else {
    console.log('[CloudBase] 强验证未启用（缺少 VERIFICATION_KEY / DEMO_VERIFICATION_PASSWORD / DEMO_TOTP_SECRET）；红色操作保持阻断')
  }
  let cloudAssistant = null
  if (hasAiKey() && (!publicDemo || getPublicDemoConfig().aiEnabled)) {
    const pcfg = getPublicDemoConfig()
    const guard = publicDemo
      ? createAiGuard({ chatFn: chatCompletions, dailyCallQuota: pcfg.aiDailyCallQuota, maxConcurrency: pcfg.aiMaxConcurrency })
      : null
    const breaker = createModelBreaker({
      threshold: Number(process.env.MODEL_BREAKER_THRESHOLD) > 0 ? Number(process.env.MODEL_BREAKER_THRESHOLD) : 3,
      cooldownMs: Number(process.env.MODEL_BREAKER_COOLDOWN_MS) > 0 ? Number(process.env.MODEL_BREAKER_COOLDOWN_MS) : 60000,
    })
    const baseChatFn = guard ? guard.chatFn : chatCompletions
    cloudAssistant = createCloudAssistant({
      client: cloudClient, userId: cfg.demoUserId, chatFn: (args) => breaker.call(baseChatFn, args),
    })
  }
  cloudRouter = createCloudRouter({ client: cloudClient, demoUserId: cfg.demoUserId, assistant: cloudAssistant })
} else {
  // —— 本地 SQLite 模式（默认，行为保持不变）——
  const defaultPublicDb = join(DATA_DIR, 'public-demo.db')
  const dbPath = process.env.DB_PATH || (publicDemo ? defaultPublicDb : DEFAULT_DB_PATH)
  if (publicDemo && resolve(dbPath) === resolve(DEFAULT_DB_PATH)) {
    console.error('[启动失败] 公网演示模式不得使用开发库 data/rongzhi.db，请通过 DB_PATH 指定独立数据库')
    process.exit(1)
  }
  const freshPublicDb = publicDemo && !existsSync(dbPath)
  const initialized = initDatabase({ dbPath, seed: freshPublicDb })
  db = initialized.db
  if (freshPublicDb) {
    const seeded = seedPublicDemoExtras(db)
    console.log(`[公网演示] 已初始化独立演示库：3 张卡（用户 id=${seeded.userId}）`)
  }
  if (publicDemo) {
    const v = maybeBindPublicVerification(db)
    if (v.bound) {
      console.log(`[公网演示] 强验证：${v.reason === 'bound' ? '已按环境变量初始化' : '已存在（未覆盖）'}`)
    } else {
      console.log(`[公网演示] 强验证未启用（${v.reason}）；红色操作保持阻断`)
    }
  }
  demoUser = resolveDemoUser(db)
}

const app = express()
// 代理来源必须显式配置：默认不信任 X-Forwarded-For（本机直连按 socket 地址）。
// TRUST_PROXY=1 / 数字：通用单层代理，由 Express 按显式跳数解析 X-Forwarded-For。
// TRUST_PROXY=cloudbase：CloudBase 网关模式，X-Forwarded-For 可被客户端伪造，改由
// lib/client-ip.js 取网关注入的 X-Original-Forwarded-For 最后一段（实测网关会追加真实 IP）。
const trustProxyRaw = String(process.env.TRUST_PROXY || '').trim()
if (trustProxyRaw === '1' || trustProxyRaw.toLowerCase() === 'true') {
  app.set('trust proxy', 1)
} else if (/^\d+$/.test(trustProxyRaw)) {
  app.set('trust proxy', Math.max(0, Number(trustProxyRaw)))
} else {
  // cloudbase 与默认模式均不启用 Express 的代理头信任；cloudbase 模式在 getClientIp 内单独解析。
  app.set('trust proxy', false)
}
app.use(express.json())

// 健康检查（公网访问口令例外；不泄露任何配置 / 环境变量）
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '服务正常',
    database: dbMode,
    timestamp: new Date().toISOString(),
  })
})

// —— 公网演示访问口令（服务端 Basic Auth，覆盖页面与业务 API，健康检查除外）——
function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}
function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}
function requirePublicAccess(req, res, next) {
  const header = req.headers.authorization || ''
  const match = /^Basic\s+(.+)$/i.exec(header)
  let ok = false
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8')
    const idx = decoded.indexOf(':')
    const user = idx >= 0 ? decoded.slice(0, idx) : ''
    const pass = idx >= 0 ? decoded.slice(idx + 1) : ''
    ok = safeEqual(user, 'demo') && safeEqual(pass, process.env.DEMO_ACCESS_PASSWORD || '')
  }
  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="Rongzhi Demo", charset="UTF-8"')
    return res.status(401).type('text/plain; charset=utf-8').send('需要访问口令（共享演示环境）')
  }
  return next()
}
if (publicDemo) app.use(requirePublicAccess)

// 业务接口（单用户模拟演示，服务端固定演示用户；云端仅通过固定 RPC）
if (dbMode === 'cloudbase') {
  app.use('/api', cloudRouter)
} else {
  app.use('/api', createApiRouter(db, demoUser.id))
}

// 未知 API 一律返回 JSON 404，不能回退成页面 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: '接口不存在' })
})

// —— 前端静态页面 + SPA 回退（仅非 /api 的 GET / HEAD）——
const staticDir = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : join(BACKEND_DIR, '..', 'frontend', 'dist')
const indexPath = join(staticDir, 'index.html')
if (existsSync(indexPath)) {
  app.use(express.static(staticDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path === '/api' || req.path.startsWith('/api/')) return next()
    return res.sendFile(indexPath)
  })
}

// 其他未知路径
app.use((req, res) => {
  res.status(404).json({ success: false, message: '接口不存在' })
})

// 统一错误处理（不输出密钥 / 请求体）
app.use((err, req, res, next) => {
  console.error('[服务器错误]', err && err.message ? err.message : err)
  res.status(500).json({ success: false, message: '服务器内部错误' })
})

app.listen(PORT, () => {
  console.log(`融智 Agent 后端服务已启动：http://localhost:${PORT}`)
  console.log(`演示用户：${demoUser.name}（id=${demoUser.id}）`)
  if (publicDemo) {
    const cfg = getPublicDemoConfig()
    console.log(`运行模式：公网演示（共享模拟环境；AI ${cfg.aiEnabled ? '已开启（受配额 / 并发 / 请求限流约束）' : '关闭'}）`)
  } else {
    console.log(`运行模式：本地演示（${dbMode === 'cloudbase' ? 'CloudBase 持久库' : 'SQLite'}）`)
  }
  if (dbMode === 'cloudbase') console.log('数据来源：CloudBase PostgreSQL 固定 RPC（容器内不保存业务数据）')
  if (existsSync(indexPath)) console.log(`前端静态页面：已加载（${staticDir}）`)
})
