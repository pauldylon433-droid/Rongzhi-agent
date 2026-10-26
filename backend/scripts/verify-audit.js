// 结构化审计验证：请求 / 工具 / 回复关联、凭据脱敏、受保护查询与导出、安全失败不被回滚。
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { createAuditTrail } from '../src/services/audit-trail.js'
import { createApiRouter } from '../src/routes/index.js'

const DB_PATH = join(tmpdir(), 'rongzhi-audit-test.db')
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
db.prepare("INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, status) VALUES (?, '活期', 100000, 100000, 'active')").run(userId)
const trail = createAuditTrail(db)

let modelCall = 0
const mock = async () => {
  modelCall += 1
  if (modelCall === 1) {
    return {
      content: '',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'get_accounts', arguments: '{}' } }],
      usage: { total_tokens: 1 },
    }
  }
  return { content: '账户查询完成', toolCalls: [], usage: { total_tokens: 1 } }
}
const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock, auditTrail: trail })
const requestId = 'req-audit-1'
const r = await assistant.chat({ message: '查询账户余额', sessionId: 'audit-session', requestId })
check('审计：助手返回 request_id', r.request_id === requestId)
const auditSessionId = r.sessionId
const events = trail.list({ session_id: auditSessionId })
const kinds = new Set(events.map((e) => `${e.category}:${e.action}`))
check('审计：记录请求 / 工具 / 回复关联', kinds.has('assistant:request') && kinds.has('tool:get_accounts') && kinds.has('assistant:reply'),
  [...kinds].join(','))
check('审计：请求与工具 / 回复共享 request_id 与 session_id',
  events.every((e) => e.request_id === requestId && e.session_id === auditSessionId))
const toolEvent = events.find((e) => e.category === 'tool')
check('审计：工具事件含 tool_call_id / 结果 / 耗时', toolEvent && toolEvent.tool_call_id === 'call-1'
  && toolEvent.result === 'ok' && typeof toolEvent.detail.duration_ms === 'number')

// 凭据误输入：不落原文，安全失败独立提交
const secret = '交易密码是 SuperSecret123'
let blocked = false
try { await assistant.chat({ message: secret, requestId: 'req-cred' }) } catch { blocked = true }
const credEvents = trail.list({ request_id: 'req-cred' })
check('审计：凭据消息被拦截', blocked && credEvents.some((e) => e.action === 'credential_input_blocked'))
check('审计：凭据原文 / 密码不进入审计', !JSON.stringify(credEvents).includes('SuperSecret123')
  && !JSON.stringify(credEvents).includes('交易密码是'))

// 受保护查询 / 导出
const app = express()
app.use(express.json())
app.use('/api', createApiRouter(db, userId, trail))
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s))
})
const base = `http://127.0.0.1:${server.address().port}`
async function req(path, headers = {}, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json, headers: res.headers }
}
try {
  const old = process.env.AUDIT_ACCESS_TOKEN
  delete process.env.AUDIT_ACCESS_TOKEN
  let x = await req('/api/audit/timeline')
  check('审计：未配置令牌时接口不暴露（404）', x.status === 404)
  process.env.AUDIT_ACCESS_TOKEN = 'audit-test-token'
  x = await req('/api/audit/timeline')
  check('审计：配置后无令牌返回 401', x.status === 401)
  x = await req('/api/audit/timeline', { Authorization: 'Bearer audit-test-token' })
  check('审计：令牌正确可查询时间线', x.status === 200 && x.json.data.length >= 3)
  x = await req('/api/audit/export', { 'X-Audit-Token': 'audit-test-token' })
  check('审计：令牌正确可导出 JSON', x.status === 200 && /attachment/.test(x.headers.get('content-disposition') || '') && Array.isArray(x.json.events))
  x = await req('/api/audit/timeline', { Authorization: 'Bearer wrong' })
  check('审计：错误令牌返回 401', x.status === 401)

  // API 中间件为状态变更请求生成 request id 并记录失败事件
  x = await req('/api/transfers', {}, 'POST', { recipient_id: 1, amount_cents: 100, from_account_id: 1, extra: true })
  const apiEvents = trail.list({ category: 'api' })
  check('审计：状态变更请求记录 API 事件与 request_id', x.status === 400
    && apiEvents.some((e) => e.action === 'POST /api/transfers' && e.result === '400' && e.request_id))
  if (old === undefined) delete process.env.AUDIT_ACCESS_TOKEN
  else process.env.AUDIT_ACCESS_TOKEN = old
} finally {
  await new Promise((res) => server.close(res))
}

// 业务成功审计仍由业务事务写入
const acct = db.prepare('SELECT * FROM accounts WHERE user_id=?').get(userId)
const { createTransfer, confirmTransfer } = await import('../src/services/transfers.js')
const op = createTransfer(db, userId, { recipientId: 1, amountCents: 1000, fromAccountId: acct.id })
confirmTransfer(db, userId, op.ref_no)
const bizAudit = db.prepare("SELECT * FROM audit_logs WHERE operation_ref=? AND action='confirm'").get(op.ref_no)
check('审计：成功确认写入业务原子审计', Boolean(bizAudit))

db.close()
console.log(`\n== 结构化审计验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
process.exit(failures ? 1 : 0)
