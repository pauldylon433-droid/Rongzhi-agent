import express from 'express'
import { initDatabase, DEFAULT_DB_PATH } from './db/index.js'
import { resolveDemoUser } from './demo-user.js'
import { createApiRouter } from './routes/index.js'

const PORT = process.env.PORT || 3000
// 支持通过环境变量 DB_PATH 指定数据库路径（测试时传入独立临时库，不碰开发库）
const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH

// 复用同一个数据库连接（启动时打开一次，供所有请求使用）；不自动灌入、不清空数据
const { db } = initDatabase({ dbPath, seed: false })
const demoUser = resolveDemoUser(db)

const app = express()

// 解析 JSON 请求体
app.use(express.json())

// 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '服务正常',
    timestamp: new Date().toISOString(),
  })
})

// 业务查询接口（单用户演示模式，固定演示用户，不接受客户端切换用户）
app.use('/api', createApiRouter(db, demoUser.id))

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '接口不存在',
  })
})

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[服务器错误]', err)
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
  })
})

app.listen(PORT, () => {
  console.log(`融智 Agent 后端服务已启动：http://localhost:${PORT}`)
  console.log(`演示用户：${demoUser.name}（id=${demoUser.id}）`)
})
