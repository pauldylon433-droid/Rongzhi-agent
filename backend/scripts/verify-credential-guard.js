// 定向验证：聊天入口凭据保护 + 历史重放保护（mock 模型 + 独立临时库）。
//
// 只用虚构哨兵值；断言：
//   - 明确标注的密码 / 验证码 / API Key / TOTP 种子命中后：不调用模型、不写入聊天 / 审计、错误与日志不含哨兵；
//   - 普通问法（忘记密码 / 如何获取验证码 / 金额 / 日期 / 操作编号 / 卡尾号）不被误拦；
//   - 已存在历史中的哨兵不会随历史重放发送给模型（数据库原文不改写）；
//   - 正常查询、建单与专用强验证接口不受影响。
//
// 用法：node scripts/verify-credential-guard.js
import { initDatabase } from '../src/db/index.js'
import { createAssistant } from '../src/services/assistant.js'
import { createTransfer, getTransferRow } from '../src/services/transfers.js'
import { bindVerification } from '../src/services/verification.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-credential-guard.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

// 虚构哨兵值（非真实凭据，仅用于断言不回显）
const PWD_SENTINEL = 'Zx9-Qf7-SentinelPwd'
const CODE_SENTINEL = '654321'
const SEED_SENTINEL = 'JBSWY3DPEHPK3PXP'
const KEY_SENTINEL = 'sk-FAKE-SENTINEL-0123456789ABCDEF'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function makeMock(script) {
  const calls = []
  let i = 0
  const fn = async ({ messages }) => {
    calls.push(JSON.parse(JSON.stringify(messages)))
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  fn.calls = calls
  return fn
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const nowIso = new Date().toISOString()
const u1 = db.prepare("INSERT INTO users (name, created_at) VALUES ('张三', ?)").run(nowIso).lastInsertRowid
const acct = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
   VALUES (?, '活期账户 A', 1000000, 1000000, 'CNY', 'deposit', 'active', '2026-08-01', ?)`,
).run(u1, nowIso).lastInsertRowid
db.prepare(
  `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
   VALUES (?, ?, '6222 **** **** 0001', '借记卡', 'active', 5000000, '2026-08-01', ?)`,
).run(u1, acct, nowIso)
const recipient = db.prepare("INSERT INTO transfer_recipients (name, masked_account, created_at) VALUES ('王五', '6217 **** **** 1111', ?)").run(nowIso).lastInsertRowid

const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'Guard-Test-Pass'
bindVerification(db, u1, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
process.env.VERIFICATION_KEY = KEY.toString('base64')

const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
const allText = (table, cols) => JSON.stringify(db.prepare(`SELECT ${cols} FROM ${table}`).all())
const chatSessions = () => count('chat_sessions')
const chatMessages = () => count('chat_messages')
const auditText = () => allText('audit_logs', 'detail, action, result, operation_type')
const bal = () => db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(acct).b

// ============ 1. 命中拦截：不动模型 / 不落库 / 不回显 ============
console.log('—— 1. 明确标注的凭据消息：拦截且无副作用 ——')
const blockedCases = [
  ['交易密码赋值', `我的交易密码是 ${PWD_SENTINEL}`],
  ['验证码赋值', `验证码：${CODE_SENTINEL}`],
  ['API Key 赋值', `DEEPSEEK_API_KEY=${KEY_SENTINEL}`],
  ['TOTP 种子赋值', `TOTP密钥：${SEED_SENTINEL}`],
  ['主密钥赋值', `主密钥=${SEED_SENTINEL}`],
]
for (const [label, text] of blockedCases) {
  const before = { s: chatSessions(), m: chatMessages(), a: auditText(), b: bal() }
  const mock = makeMock([{ content: '不应被调用' }])
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: mock })
  let err = null
  try { await assistant.chat({ message: text }) } catch (e) { err = e }
  const sentinel = [PWD_SENTINEL, CODE_SENTINEL, SEED_SENTINEL, KEY_SENTINEL].find((v) => text.includes(v))
  check(`${label} → 被拦截（credential_detected）`, !!err && err.code === 'credential_detected', err && err.code)
  check(`${label} → 未调用模型`, mock.calls.length === 0, String(mock.calls.length))
  check(`${label} → 未新增会话 / 聊天消息 / 审计`, chatSessions() === before.s && chatMessages() === before.m && auditText() === before.a)
  check(`${label} → 余额与流水无变化`, bal() === before.b && count('transactions') === 0)
  check(`${label} → 错误信息不含哨兵原文`, !!err && !String(err.message).includes(sentinel))
  check(`${label} → 返回固定安全提示`, !!err && /专用验证表单/.test(err.message))
}

// 日志：拦截过程不打印原文
{
  const logs = []
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const k of Object.keys(orig)) console[k] = (...args) => { logs.push(args.map(String).join(' ')) }
  try {
    const assistant = createAssistant({ db, demoUserId: u1, chatFn: makeMock([{ content: 'x' }]) })
    try { await assistant.chat({ message: `交易密码是 ${PWD_SENTINEL}` }) } catch { /* 预期 */ }
  } finally {
    Object.assign(console, orig)
  }
  check('拦截过程不向控制台输出哨兵原文', !logs.join('\n').includes(PWD_SENTINEL))
}

// ============ 2. 普通问法不得误拦 ============
console.log('—— 2. 普通问法 / 正常业务信息不误拦 ——')
const allowedCases = [
  '我的交易密码忘记了怎么办',
  '如何获取动态验证码',
  '验证码是6位数字吗',
  '交易密码是不是6位',
  '转账 12.34 元给王五',
  '操作编号 d5a9e9d4-5412-4ae8-a0cd-9ee4081a08fc 是什么状态',
  '卡号尾号 0001',
  '2026-10-23 的账单',
]
for (const text of allowedCases) {
  const mock = makeMock([{ content: '正常回答' }])
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: mock })
  let ok = true
  try { await assistant.chat({ message: text }) } catch { ok = false }
  check(`未误拦：${text}`, ok && mock.calls.length === 1)
}

// ============ 3. 历史重放保护 ============
console.log('—— 3. 历史中的疑似凭据不随重放发送给模型（不改写数据库）——')
const oldSession = 'sess-old-credential'
const oldText = `我之前设的交易密码是 ${PWD_SENTINEL}`
db.prepare('INSERT INTO chat_sessions (id, user_id, messages_json, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
  .run(oldSession, u1, JSON.stringify([{ role: 'user', content: oldText }, { role: 'assistant', content: '收到。' }]), Date.now(), Date.now())
db.prepare(
  `INSERT INTO chat_messages (session_id, user_id, seq, role, text, tool_records_json, incomplete, error, created_at)
   VALUES (?, ?, 1, 'user', ?, NULL, 0, NULL, ?)`,
).run(oldSession, u1, oldText, Date.now())
{
  const mock = makeMock([{ content: '好的。' }])
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: mock })
  await assistant.chat({ message: '继续查询余额', sessionId: oldSession })
  const sent = JSON.stringify(mock.calls)
  check('历史重放不含哨兵原文', !sent.includes(PWD_SENTINEL))
  check('命中的历史内容被替换为占位符', sent.includes('已从模型输入中移除'))
  const persisted = db.prepare('SELECT messages_json FROM chat_sessions WHERE id = ?').get(oldSession).messages_json
  check('数据库中已有历史原文未被改写（如实保留）', persisted.includes(PWD_SENTINEL))
  check('本轮正常消息仍被持久化', db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE session_id = ? AND text = '继续查询余额'").get(oldSession).c === 1)
}

// ============ 4. 正常业务与专用强验证接口不受影响 ============
console.log('—— 4. 正常查询 / 建单 / 专用强验证不受影响 ——')
{
  const mock = makeMock([
    { toolCalls: [tc('a1', 'get_accounts', {}), tc('a2', 'prepare_transfer', { recipient_id: recipient, amount_yuan: '10.00', account_id: acct })] },
    { content: '已查询并生成待确认单。' },
  ])
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: mock })
  const r = await assistant.chat({ message: '查余额并转 10 元给王五' })
  check('正常查询工具可用', r.toolRecords.some((t) => t.name === 'get_accounts' && t.status === 'ok'))
  check('正常建单可用（未扣款）', r.toolRecords.some((t) => t.name === 'prepare_transfer' && t.status === 'ok') && bal() === 1000000)
}

// 安全性：即使后续意外调用模型，也只会指向本机不可达地址（不发往真实服务）
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-placeholder'
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9'

async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(db, u1))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try { await fn(`http://127.0.0.1:${server.address().port}/api`) } finally { await new Promise((r) => server.close(r)) }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

await withServer(async (base) => {
  const before = { m: chatMessages(), a: auditText() }
  const res = await post(`${base}/assistant/chat`, { message: `验证码：${CODE_SENTINEL}` })
  const body = await res.json()
  check('HTTP 入口拦截返回 400 + credential_detected', res.status === 400 && body.code === 'credential_detected', `${res.status} ${body.code || ''}`)
  check('HTTP 错误响应不含哨兵原文', !JSON.stringify(body).includes(CODE_SENTINEL))
  check('HTTP 拦截后无聊天 / 审计写入', chatMessages() === before.m && auditText() === before.a)

  // 专用强验证接口：正确密码 + 当前动态码 → 成功且仅扣一次
  const red = createTransfer(db, u1, { recipientId: recipient, amountCents: 200000, fromAccountId: acct })
  const beforeBal = bal()
  const code = totpAt(SECRET_BUF, totpStep(Date.now()))
  const v = await post(`${base}/transfers/${red.ref_no}/verify`, { password: PASSWORD, totp: code })
  const vb = await v.json()
  check('专用强验证接口正常（200 completed）', v.status === 200 && vb.data && vb.data.status === 'completed', `${v.status}`)
  check('强验证扣款一次', bal() === beforeBal - 200000, `${beforeBal}→${bal()}`)
  check('强验证请求未经过聊天入口 / 未落聊天', chatMessages() === before.m)
})

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n凭据保护定向验证全部通过 ✅（mock 模型 + 独立临时库）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
