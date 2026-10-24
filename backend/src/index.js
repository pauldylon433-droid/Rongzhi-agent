import express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, DEFAULT_DB_PATH, DATA_DIR } from './db/index.js'
import { resolveDemoUser } from './demo-user.js'
import { createApiRouter } from './routes/index.js'
import { isPublicDemo, getPublicDemoConfig, validatePublicConfig } from './config.js'
import { seedPublicDemoExtras, maybeBindPublicVerification } from './db/public-demo.js'

const PORT = process.env.PORT || 3000
const SRC_DIR = dirname(fileURLToPath(import.meta.url)) // backend/src
const BACKEND_DIR = join(SRC_DIR, '..') // backend
const publicDemo = isPublicDemo()

// —— 公网演示模式启动校验（在打开数据库之前）：缺少访问口令 / AI 配置不完整则拒绝启动 ——
if (publicDemo) {
  const missing = validatePublicConfig()
  if (missing.length) {
    console.error(`[启动失败] 公网演示模式缺少必要环境变量：${missing.join('、')}（不显示具体值）`)
    process.exit(1)
  }
}

// 公网模式使用独立演示库；显式 DB_PATH 指向开发库时拒绝启动（绝不读取 / 修改开发库）
const defaultPublicDb = join(DATA_DIR, 'public-demo.db')
const dbPath = process.env.DB_PATH || (publicDemo ? defaultPublicDb : DEFAULT_DB_PATH)
if (publicDemo && resolve(dbPath) === resolve(DEFAULT_DB_PATH)) {
  console.error('[启动失败] 公网演示模式不得使用开发库 data/rongzhi.db，请通过 DB_PATH 指定独立数据库')
  process.exit(1)
}

// 只在公网演示库文件不存在时初始化基础数据与多卡样例；已有文件不做任何重建
const freshPublicDb = publicDemo && !existsSync(dbPath)
const { db } = initDatabase({ dbPath, seed: freshPublicDb })
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

const demoUser = resolveDemoUser(db)

const app = express()
app.set('trust proxy', 1) // Render 等反向代理下取真实客户端 IP（用于 AI 请求限流）
app.use(express.json())

// 健康检查（公网访问口令例外；不泄露任何配置 / 环境变量）
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '服务正常',
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

// 业务接口（单用户模拟演示，服务端固定演示用户）
app.use('/api', createApiRouter(db, demoUser.id))

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

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[服务器错误]', err)
  res.status(500).json({ success: false, message: '服务器内部错误' })
})

app.listen(PORT, () => {
  console.log(`融智 Agent 后端服务已启动：http://localhost:${PORT}`)
  console.log(`演示用户：${demoUser.name}（id=${demoUser.id}）`)
  if (publicDemo) {
    const cfg = getPublicDemoConfig()
    console.log(`运行模式：公网演示（共享模拟环境；AI ${cfg.aiEnabled ? '已开启（受配额 / 并发 / 请求限流约束）' : '关闭'}）`)
  } else {
    console.log('运行模式：本地演示')
  }
  if (existsSync(indexPath)) console.log(`前端静态页面：已加载（${staticDir}）`)
})
