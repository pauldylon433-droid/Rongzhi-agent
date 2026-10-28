import { spawn } from 'node:child_process'
import net from 'node:net'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
// 本地启动验收：临时 RPC 桩 + 真实 Node 入口；不连接云端、不调用模型。
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runtimeRoot = root
assert.ok(existsSync(join(root, 'frontend', 'dist', 'index.html')), '请先在 frontend 执行 npm ci 和 npm run build')
const children = []
function start(file, env) {
  const p = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] })
  children.push(p)
  p.output = ''
  p.stdout.on('data', (x) => p.output += x)
  p.stderr.on('data', (x) => p.output += x)
  return p
}
async function ready(p, regex) {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    const m = p.output.match(regex)
    if (m) return m
    if (p.exitCode !== null) throw new Error('child stopped: ' + p.output)
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('child timeout: ' + p.output)
}
async function freePort() {
  const s = net.createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}
let passed = 0
function check(name, cond) { assert.ok(cond, name); console.log('PASS  ' + name); passed++ }
try {
  const stub = start(runtimeRoot + '/backend/scripts/cloud/rpc-stub.js', { STUB_PORT: '0' })
  const stubPort = (await ready(stub, /^(\d+)\r?\n/))[1]
  const port = await freePort()
  const base = 'http://127.0.0.1:' + port
  const env = {
    DB_MODE: 'cloudbase', PUBLIC_DEMO: '1', PORT: String(port), PUBLIC_AI_ENABLED: '0',
    DEMO_ACCESS_PASSWORD: 'local-startup-fixture-only',
    CLOUDBASE_RPC_BASE: 'http://127.0.0.1:' + stubPort,
    CLOUDBASE_SERVICE_KEY: 'test-service-key', CLOUDBASE_DEMO_USER_ID: '1',
    STATIC_DIR: runtimeRoot + '/frontend/dist', SKIP_ENV_FILE: '1',
    VERIFICATION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DEMO_VERIFICATION_PASSWORD: 'startup-test-password', DEMO_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DP',
    DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
  }
  let app = start(root + '/backend/src/index.js', env)
  await ready(app, /融智 Agent 后端服务已启动/)
  let r = await fetch(base + '/api/health'); let j = await r.json()
  check('真实启动入口健康检查使用 cloudbase 模式', r.status === 200 && j.database === 'cloudbase')
  r = await fetch(base + '/'); check('公网页面无口令返回 401', r.status === 401)
  r = await fetch(base + '/api/accounts'); check('业务 API 无口令返回 401', r.status === 401)
  const headers = { Authorization: 'Basic ' + Buffer.from('demo:local-startup-fixture-only').toString('base64') }
  r = await fetch(base + '/', { headers }); const html = await r.text()
  check('正确口令可打开已构建前端页面', r.status === 200 && html.includes('id="app"'))
  const asset = html.match(/src="([^\"]+\.js)"/)[1]
  r = await fetch(base + asset, { headers }); check('前端 JavaScript 资源可读取', r.status === 200)
  r = await fetch(base + '/api/accounts', { headers }); j = await r.json()
  check('实际启动入口账户查询返回 3 个账户', r.status === 200 && j.data.length === 3)
  const before = JSON.stringify(j.data)
  const accountId = j.data.find((a) => a.account_type === 'deposit').id
  const post = (path, body, auth = headers) => fetch(base + path, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  r = await fetch(base + '/api/transfers/recipients', { headers }); j = await r.json()
  const recipientId = j.data[0].id
  r = await post('/api/transfers', { from_account_id: accountId, recipient_id: recipientId, amount_cents: 120000 })
  j = await r.json()
  check('公网入口创建红色测试单，不执行转账', r.status === 200 && j.data.status === 'needs_verification')
  const verifyPath = '/api/transfers/' + j.data.ref_no + '/verify'
  r = await post(verifyPath, { password: 'wrong-test-password', totp: '000000' }, {})
  check('缺少网站口令仍返回 401 与 Basic challenge', r.status === 401 && r.headers.get('www-authenticate')?.startsWith('Basic '))
  r = await post(verifyPath, { password: 'wrong-test-password', totp: '000000' })
  j = await r.json()
  check('网站已登录后的交易凭据错误返回 403，不触发网站 401 challenge', r.status === 403 && j.code === 'bad_credentials' && !r.headers.has('www-authenticate'))
  r = await fetch(base + '/api/verification/status', { headers }); j = await r.json()
  check('错误后访问身份保持有效，绑定保留且只计一次失败', r.status === 200 && j.data.bound && !j.data.locked && j.data.remaining_attempts === 4)
  r = await fetch(base + '/api/accounts', { headers }); j = await r.json()
  check('凭据失败不扣款', r.status === 200 && JSON.stringify(j.data) === before)
  r = await fetch(base + '/api/assistant/chat', { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({message:'查询账户'}) })
  check('初次上线关闭 AI，聊天返回 503', r.status === 503)
  const stopped = once(app, 'exit'); app.kill(); await stopped
  app = start(root + '/backend/src/index.js', env)
  await ready(app, /融智 Agent 后端服务已启动/)
  r = await fetch(base + '/api/accounts', { headers }); j = await r.json()
  check('重启后仍读取同一 RPC 数据，启动不重灌样例', r.status === 200 && JSON.stringify(j.data) === before)
  console.log('== 完整启动入口本地验证：PASS ' + passed + ' / FAIL 0；RPC 为本地 PGlite 桩，非真实云端或 Docker构建 ==')
} finally {
  for (const p of children) if (p.exitCode === null) p.kill()
}
