// 可疑行为范围锁定 + 模型服务熔断验证（与请求限流、强验证锁定分开）。
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAuditTrail } from '../src/services/audit-trail.js'
import { createSecurityGuard, createModelBreaker, createLocalSecurityState } from '../src/services/security-guard.js'
import { createApiRouter } from '../src/routes/index.js'
import { createAssistantRouter } from '../src/routes/assistant.js'
import { AiError } from '../src/lib/ai-client.js'

const DB_PATH = join(tmpdir(), 'rongzhi-security-test.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const db = openDatabase(DB_PATH)
createSchema(db)
migrate(db)
const userId = Number(db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid)
const trail = createAuditTrail(db)
const config = { enabled: true, windowMs: 60000, threshold: 3, lockMs: 60000 }
const state = createLocalSecurityState(db)

const a = createSecurityGuard({ auditTrail: trail, stateStore: state, scopeKey: 'ip-a', config })
const b = createSecurityGuard({ auditTrail: trail, stateStore: state, scopeKey: 'ip-b', config })
let r = await a.record('invalid_tool', { tool: 'confirm_transfer' })
check('可疑行为：第 1 次不锁定', r.locked === false && r.count === 1, JSON.stringify(r))
r = await a.record('invalid_tool', { tool: 'confirm_transfer' })
check('可疑行为：第 2 次不锁定', r.locked === false && r.count === 2)
r = await a.record('invalid_tool', { tool: 'confirm_transfer' })
check('可疑行为：第 3 次触发范围锁定', r.locked === true && r.count === 3, JSON.stringify(r))
const blocked = await a.assertAllowed()
const allowedB = await b.assertAllowed()
check('可疑行为：锁定仅作用于当前 scope（不锁死全服务）', blocked.allowed === false && allowedB.allowed === true)
const late = await a.record('invalid_tool', { tool: 'confirm_transfer' })
check('可疑行为：锁定期间晚到请求仍被拒绝', late.locked === true)
const future = createSecurityGuard({ auditTrail: trail, stateStore: state, scopeKey: 'ip-a', config, now: () => Date.now() + 120000 })
check('可疑行为：锁定到期后可恢复', (await future.assertAllowed()).allowed === true)
const securityEvents = trail.list({ category: 'security' }).filter((e) => e.detail.scope_key === 'ip-a')
check('可疑行为：触发 / 锁定事件进入审计', securityEvents.some((e) => e.action === 'scope_locked')
  && securityEvents.filter((e) => e.action === 'anomaly_invalid_tool').length >= 3)

// R5：其它 scope 写入 501 / 600 条安全事件不得把已锁定 scope 的状态挤出。
for (let i = 0; i < 600; i++) {
  await trail.record({ category: 'security', action: 'anomaly_flood', result: 'detected',
    detail: { scope_key: 'ip-b' } })
}
const afterFlood = await a.assertAllowed()
check('可疑行为：跨 scope 事件洪泛不影响既有锁定', afterFlood.allowed === false, JSON.stringify(afterFlood))
// 重启 / 新实例读取同一持久状态：锁定仍有效。
const restarted = createSecurityGuard({ auditTrail: trail, stateStore: createLocalSecurityState(db), scopeKey: 'ip-a', config })
check('可疑行为：实例重建 / 重启后锁定仍有效', (await restarted.assertAllowed()).allowed === false)
// 持久状态存储故障：校验抛错（中间件据此返回 503），不能静默放行。
const broken = createSecurityGuard({
  auditTrail: trail, scopeKey: 'ip-a', config,
  stateStore: { async lockedUntil() { throw new Error('state store down') }, async record() { throw new Error('state store down') } },
})
let stateErr = null
try { await broken.assertAllowed() } catch (e) { stateErr = e }
check('可疑行为：状态存储故障时校验失败（不静默放行）', stateErr && /down/.test(stateErr.message))

// 模型服务熔断（独立于限流 / 强验证锁定）
let clock = 1000000
const breaker = createModelBreaker({ threshold: 3, cooldownMs: 5000, now: () => clock })
for (let i = 0; i < 3; i++) {
  try { await breaker.call(async () => { throw new Error('model down') }) } catch { /* expected */ }
}
let breakerErr
try { await breaker.call(async () => 'ok') } catch (e) { breakerErr = e }
check('模型熔断：连续 3 次失败后打开并拒绝调用', breakerErr && breakerErr.code === 'model_breaker', breakerErr?.code)
clock += 5001
const recovered = await breaker.call(async () => 'ok')
check('模型熔断：冷却结束后恢复', recovered === 'ok' && breaker.stats().failures === 0)

// HTTP 集成：同一 IP 多次非法字段请求触发 423；其他 IP 不受影响
process.env.SECURITY_ANOMALY_ENABLED = '1'
process.env.SECURITY_ANOMALY_THRESHOLD = '3'
process.env.SECURITY_ANOMALY_WINDOW_SECONDS = '60'
process.env.SECURITY_ANOMALY_LOCK_SECONDS = '60'
const app = express()
app.set('trust proxy', 1)
app.use(express.json())
app.use('/api', createApiRouter(db, userId, trail))
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
try {
  const post = (body, ip) => fetch(`${base}/api/transfers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body),
  })
  let last
  for (let i = 0; i < 3; i++) last = await post({ recipient_id: 1, amount_cents: 100, from_account_id: 1, extra: true }, '10.0.0.9')
  check('HTTP 异常：前 3 次非法请求返回 400', last.status === 400)
  await new Promise((r) => setTimeout(r, 200))
  const blockedHttp = await post({ recipient_id: 1, amount_cents: 100, from_account_id: 1, extra: true }, '10.0.0.9')
  check('HTTP 异常：第 4 次同 IP 请求返回 423', blockedHttp.status === 423
    && (await blockedHttp.json()).code === 'suspicious_locked', `status=${blockedHttp.status}`)
  const otherIp = await post({ recipient_id: 1, amount_cents: 100, from_account_id: 1, extra: true }, '10.0.0.10')
  check('HTTP 异常：其他 IP 不受影响（仍为 400）', otherIp.status === 400)
} finally {
  await new Promise((res) => server.close(res))
}

// P2-11：本地 SQLite 模式的路由层模型熔断（与云端共用 createModelBreaker）
{
  const oldKey = process.env.DEEPSEEK_API_KEY
  const oldThreshold = process.env.MODEL_BREAKER_THRESHOLD
  const oldCooldown = process.env.MODEL_BREAKER_COOLDOWN_MS
  process.env.DEEPSEEK_API_KEY = 'test-only-model-key'
  process.env.MODEL_BREAKER_THRESHOLD = '2'
  process.env.MODEL_BREAKER_COOLDOWN_MS = '300'
  let calls = 0
  const fakeChatFn = async () => {
    calls += 1
    if (calls <= 2) throw new AiError('provider down', { kind: 'network' })
    return { content: 'ok', toolCalls: [], usage: { total_tokens: 1 } }
  }
  const app2 = express()
  app2.use(express.json())
  app2.use('/api/assistant', createAssistantRouter(db, userId, { chatFn: fakeChatFn }))
  const server2 = await new Promise((resolve) => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)) })
  const base2 = `http://127.0.0.1:${server2.address().port}`
  const chat = () => fetch(`${base2}/api/assistant/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '你好' }),
  })
  try {
    let r1 = await chat()
    let r2 = await chat()
    check('本地模式模型熔断：阈值前 502；达到阈值的请求起返回 503',
      r1.status === 502 && r2.status === 503,
      `statuses=${r1.status},${r2.status}`)
    const r3 = await chat()
    const b3 = await r3.json()
    check('本地模式模型熔断：达到阈值后返回 503 且不再调用提供方',
      r3.status === 503 && b3.code === 'model_breaker' && calls === 2, JSON.stringify({ status: r3.status, calls, b3 }))
    await new Promise((r) => setTimeout(r, 380))
    const r4 = await chat()
    check('本地模式模型熔断：冷却后恢复并重新调用提供方', r4.status === 200 && calls === 3,
      JSON.stringify({ status: r4.status, calls }))
  } finally {
    await new Promise((res) => server2.close(res))
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey
    if (oldThreshold === undefined) delete process.env.MODEL_BREAKER_THRESHOLD; else process.env.MODEL_BREAKER_THRESHOLD = oldThreshold
    if (oldCooldown === undefined) delete process.env.MODEL_BREAKER_COOLDOWN_MS; else process.env.MODEL_BREAKER_COOLDOWN_MS = oldCooldown
  }
}

db.close()
console.log(`\n== 安全控制验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
process.exit(failures ? 1 : 0)
