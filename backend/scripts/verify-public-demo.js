// 定向验证：公网演示模式（独立临时库 + 本地临时 HTTP 服务 + mock 模型）。
//
// 覆盖：
//  - 缺少访问口令 / 开启 AI 但缺少配额配置 → 拒绝启动；
//  - 首次启动初始化独立演示库（基础数据 + 2 借记卡 + 1 信用卡；无会话 / 操作单 / 验证绑定）；
//  - 访问口令覆盖页面与业务 API（健康检查例外，不泄露配置）；
//  - 页面、刷新前端路由、静态资源、未知 API 返回 JSON 404；
//  - AI 默认关闭（503）；开启后配额 / 并发护栏按调用计数（mock 模型，不触达真实模型）；
//  - 环境变量驱动的公网强验证首次绑定（随机密钥 / 随机 TOTP 密钥，非开发或隔离固定凭据）。
//
// 不触碰开发库、不读取 backend/.env（公网模式显式跳过）、不调用收费模型。
// 用法：node scripts/verify-public-demo.js
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { base32Encode } from '../src/lib/totp.js'
import { createAiGuard } from '../src/lib/ai-guard.js'
import { AiError } from '../src/lib/ai-client.js'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_DIR = join(BACKEND_DIR, '..', 'frontend', 'dist')
const WORK = mkdtempSync(join(tmpdir(), 'rongzhi-public-verify-'))

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

function startServer(env) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d.toString() })
  child.stderr.on('data', (d) => { output += d.toString() })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  return { child, exited, getOutput: () => output }
}

async function waitHealth(port, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      // 尚未监听
    }
    await sleep(200)
  }
  return false
}

async function stopServer(server) {
  try { server.child.kill() } catch {}
  await Promise.race([server.exited, sleep(3000)])
}
const authHeader = (pass) => `Basic ${Buffer.from(`demo:${pass}`).toString('base64')}`
const api = (port, path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts)

const db1 = join(WORK, 'public-demo.db')
const accessPass = 'verify-access-pass'

// —— 1. 缺少访问口令 → 拒绝启动 ——
console.log('—— 1. 启动校验 ——')
{
  const port = await freePort()
  const s = startServer({
    PUBLIC_DEMO: '1', PORT: String(port), DB_PATH: join(WORK, 'no-pass.db'), PUBLIC_AI_ENABLED: '0',
  })
  const code = await Promise.race([s.exited, sleep(10000).then(() => 'timeout')])
  check('公网模式缺少 DEMO_ACCESS_PASSWORD → 拒绝启动', code !== 0 && code !== 'timeout', String(code))
  check('报错只列缺失变量名，不含口令值', /DEMO_ACCESS_PASSWORD/.test(s.getOutput()) && !s.getOutput().includes(accessPass))
  await stopServer(s)
}
{
  const port = await freePort()
  const s = startServer({
    PUBLIC_DEMO: '1', PORT: String(port), DB_PATH: join(WORK, 'no-quota.db'), DEMO_ACCESS_PASSWORD: accessPass,
    PUBLIC_AI_ENABLED: '1', DEEPSEEK_API_KEY: 'test-placeholder-not-real',
  })
  const code = await Promise.race([s.exited, sleep(10000).then(() => 'timeout')])
  check('开启 AI 但缺少配额 / 并发配置 → 拒绝启动', code !== 0 && code !== 'timeout', String(code))
  check('报错列出配额变量名（不泄露密钥）', /PUBLIC_AI_RATE_LIMIT_PER_MIN/.test(s.getOutput()) && !s.getOutput().includes('test-placeholder-not-real'))
  await stopServer(s)
}

// —— 2. 首次启动：独立演示库 + 访问口令 + 页面 / API / AI 默认关闭 ——
console.log('—— 2. 公共演示实例（AI 关闭）——')
let port = await freePort()
let server = startServer({
  PUBLIC_DEMO: '1', PORT: String(port), DB_PATH: db1, DEMO_ACCESS_PASSWORD: accessPass,
  PUBLIC_AI_ENABLED: '0', STATIC_DIR, NODE_ENV: 'production',
})
if (!(await waitHealth(port))) {
  console.error(server.getOutput())
  check('公网演示实例启动', false)
} else {
  check('健康检查无需口令且返回 JSON', (await api(port, '/api/health')).status === 200)
  const noAuthPage = await api(port, '/')
  check('未带口令访问页面 → 401', noAuthPage.status === 401, String(noAuthPage.status))
  check('401 带 WWW-Authenticate', /^Basic/.test(noAuthPage.headers.get('www-authenticate') || ''))
  const noAuthApi = await api(port, '/api/accounts')
  check('未带口令访问业务 API → 401', noAuthApi.status === 401, String(noAuthApi.status))

  const page = await api(port, '/', { headers: { Authorization: authHeader(accessPass) } })
  const pageText = await page.text()
  check('带口令访问页面 → 200 HTML', page.status === 200 && /text\/html/.test(page.headers.get('content-type') || ''))
  check('页面包含前端入口', /<div id="app">/.test(pageText))
  const spa = await api(port, '/assistant', { headers: { Authorization: authHeader(accessPass) } })
  check('刷新前端路由 → SPA 回退为页面', spa.status === 200 && /text\/html/.test(spa.headers.get('content-type') || ''))
  const asset = await api(port, '/favicon.svg', { headers: { Authorization: authHeader(accessPass) } })
  check('静态资源可访问', asset.status === 200, String(asset.status))

  const accounts = await api(port, '/api/accounts', { headers: { Authorization: authHeader(accessPass) } })
  const accountsBody = await accounts.json()
  check('业务 API 返回演示账户（3 个）', accounts.status === 200 && accountsBody.data.length === 3, String(accountsBody.data?.length))
  const cards = await (await api(port, '/api/cards', { headers: { Authorization: authHeader(accessPass) } })).json()
  check('三张卡：两张借记 + 一张信用', cards.data.length === 3 &&
    cards.data.filter((c) => c.card_type === '借记卡').length === 2 && cards.data.filter((c) => c.card_type === '信用卡').length === 1,
    cards.data.map((c) => c.card_type).join(','))
  const unknown = await api(port, '/api/not-exists', { headers: { Authorization: authHeader(accessPass) } })
  const unknownBody = await unknown.text()
  check('未知 API → 404 且为 JSON（非 HTML）', unknown.status === 404 && /application\/json/.test(unknown.headers.get('content-type') || '') && /"success":false/.test(unknownBody), `${unknown.status} ${unknown.headers.get('content-type')}`)

  const chat = await api(port, '/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(accessPass) },
    body: JSON.stringify({ message: '你好' }),
  })
  const chatBody = await chat.json()
  check('公网 AI 默认关闭 → 503', chat.status === 503 && /未开启 AI/.test(chatBody.message || ''), String(chat.status))
  const vstat = await (await api(port, '/api/verification/status', { headers: { Authorization: authHeader(accessPass) } })).json()
  check('未配置强验证时 bound=false（红色操作阻断）', vstat.data.bound === false)

  const db = new Database(db1, { readonly: true })
  const one = (sql) => db.prepare(sql).get().c
  check('演示库：1 用户 / 3 账户 / 3 卡', one('SELECT COUNT(*) c FROM users') === 1 && one('SELECT COUNT(*) c FROM accounts') === 3 && one('SELECT COUNT(*) c FROM cards') === 3)
  check('演示库：6 条订阅', one('SELECT COUNT(*) c FROM subscriptions') === 6)
  check('演示库不含会话 / 操作单 / 验证绑定', one('SELECT COUNT(*) c FROM chat_sessions') === 0 && one('SELECT COUNT(*) c FROM transfer_operations') === 0 && one('SELECT COUNT(*) c FROM card_operations') === 0 && one('SELECT COUNT(*) c FROM subscription_operations') === 0 && one('SELECT COUNT(*) c FROM verification_bindings') === 0)
  db.close()
}
await stopServer(server)

// —— 3. 环境变量驱动公网强验证首次绑定（随机值，非开发 / 隔离固定凭据）——
console.log('—— 3. 公网强验证首次绑定 ——')
{
  const key = randomBytes(32)
  const totpSecret = base32Encode(randomBytes(20))
  const vPass = 'public-verify-pass-123'
  port = await freePort()
  server = startServer({
    PUBLIC_DEMO: '1', PORT: String(port), DB_PATH: db1, DEMO_ACCESS_PASSWORD: accessPass,
    PUBLIC_AI_ENABLED: '0', STATIC_DIR,
    VERIFICATION_KEY: key.toString('base64'),
    DEMO_VERIFICATION_PASSWORD: vPass,
    DEMO_TOTP_SECRET: totpSecret,
  })
  if (!(await waitHealth(port))) {
    console.error(server.getOutput())
    check('绑定实例启动', false)
  } else {
    const vstat = await (await api(port, '/api/verification/status', { headers: { Authorization: authHeader(accessPass) } })).json()
    check('公网强验证按环境变量完成绑定', vstat.data.bound === true, JSON.stringify(vstat.data))
    const db = new Database(db1, { readonly: true })
    check('绑定写入独立演示库（1 条）', db.prepare('SELECT COUNT(*) c FROM verification_bindings').get().c === 1)
    db.close()
  }
  await stopServer(server)
}

// —— 4. AI 护栏（mock 模型）：配额 / 并发 / 日切重置 ——
console.log('—— 4. AI 配额与并发（mock）——')
{
  let day = new Date('2026-10-24T01:00:00Z')
  let calls = 0
  const inner = async () => { calls += 1; return { content: 'ok', toolCalls: [], usage: {} } }
  const guard = createAiGuard({ chatFn: inner, dailyCallQuota: 2, maxConcurrency: 2, now: () => day })
  await guard.chatFn({})
  await guard.chatFn({})
  check('配额内调用成功且逐次计数', calls === 2 && guard.stats().used === 2, JSON.stringify(guard.stats()))
  let quotaErr = null
  try { await guard.chatFn({}) } catch (e) { quotaErr = e }
  check('超过每日调用配额 → AiError(quota)', quotaErr instanceof AiError && quotaErr.kind === 'quota' && calls === 2, quotaErr && quotaErr.kind)
  day = new Date('2026-10-25T01:00:00Z')
  await guard.chatFn({})
  check('跨日重置配额（重启 / 日切后恢复）', calls === 3 && guard.stats().used === 1, JSON.stringify(guard.stats()))

  let release
  const blocked = new Promise((r) => { release = r })
  const slow = createAiGuard({ chatFn: async () => { await blocked; return {} }, dailyCallQuota: 10, maxConcurrency: 1 })
  const first = slow.chatFn({})
  let concErr = null
  try { await slow.chatFn({}) } catch (e) { concErr = e }
  check('并发上限生效 → AiError(concurrency)', concErr instanceof AiError && concErr.kind === 'concurrency', concErr && concErr.kind)
  release()
  await first
  check('并发释放后可继续调用', (await slow.chatFn({})) !== undefined && slow.stats().active === 0)
}

rmSync(WORK, { recursive: true, force: true })
console.log(failures === 0 ? '\n公网演示模式定向验证全部通过 ✅（临时库 + 本地服务 + mock）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
