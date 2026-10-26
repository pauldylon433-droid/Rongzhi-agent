// 计划任务 HTTP 契约验证（前端「计划任务」页面使用的接口）：
// 创建 / 选择 / 修改使旧单失效 / 暂停恢复 / 取消 / 重试 / 转人工 / 还款强验证 / 刷新恢复 / 审计关联。
// 使用独立临时库与本地临时端口，不触碰开发库或用户运行中的 3000 / 5174 服务。
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createApiRouter } from '../src/routes/index.js'
import { createAuditTrail } from '../src/services/audit-trail.js'
import { bindVerification } from '../src/services/verification.js'
import { base32Decode, totpAt, totpStep } from '../src/lib/totp.js'

const DB_PATH = join(tmpdir(), 'rongzhi-workflow-api-test.db')
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
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const userId = Number(db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid)
function addAccount(name, balance) {
  return Number(db.prepare(`INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
    VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active')`).run(userId, name, balance, balance).lastInsertRowid)
}
function addCard(accountId, masked) {
  return Number(db.prepare(`INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, version)
    VALUES (?, ?, ?, '借记卡', 'active', 100000, '2026-01-01', 1)`).run(userId, accountId, masked).lastInsertRowid)
}
const a1 = addAccount('日常活期', 1000000)
const a2 = addAccount('储蓄活期', 500000)
addCard(a1, '6222 **** **** 0001')
addCard(a2, '6222 **** **** 0002')
const subId = Number(db.prepare(`INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, version)
  VALUES (?, ?, '测试会员', 1500, 'monthly', '2026-12-01', 'active', 1)`).run(userId, a1).lastInsertRowid)
const creditAccount = Number(db.prepare(`INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
  VALUES (?, '信用卡账户', 0, 0, 'CNY', 'credit', 'active')`).run(userId).lastInsertRowid)
const caId = Number(db.prepare(`INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents)
  VALUES (?, ?, 500000, 120000, 0)`).run(userId, creditAccount).lastInsertRowid)
const statementId = Number(db.prepare(`INSERT INTO statements
  (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents, version)
  VALUES (?, ?, 2026, 10, '2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z',
          '2026-10-31T16:00:00.000Z', '2026-10-31T16:00:00.000Z', '2026-11-24T16:00:00.000Z', 120000, 0, 1)`)
  .run(userId, caId).lastInsertRowid)

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP'
const KEY = randomBytes(32)
// 仅进程内测试密钥：让本地强验证路由与 bindVerification 使用同一把加密主密钥。
process.env.VERIFICATION_KEY = KEY.toString('base64')
const PASSWORD = 'WorkflowPass123'
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET, encryptionKey: KEY, matchedStep: 0 })
const totp = (off = 0) => totpAt(base32Decode(SECRET), totpStep() + off)

const trail = createAuditTrail(db)
const app = express()
app.use(express.json())
app.use('/api', createApiRouter(db, userId, trail))
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`

async function req(path, { method = 'GET', body, requestId } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (requestId) headers['X-Request-Id'] = requestId
  const res = await fetch(`${base}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json, requestId: res.headers.get('x-request-id') }
}

try {
  // 订阅链：创建 → 非法 action 拒绝 → 选择 → 确认 → 核验
  let r = await req('/api/workflows', { method: 'POST', body: { flow: 'subscription_review', params: { month } }, requestId: 'wfapi-create-1' })
  check('HTTP 计划：创建订阅审查计划', r.status === 200 && r.json?.data?.status === 'waiting_selection'
    && r.requestId === 'wfapi-create-1', JSON.stringify(r.json?.data?.status || r.json))
  const planNo = r.json?.data?.plan_no

  r = await req(`/api/workflows/${planNo}/select`, { method: 'POST', body: { subscription_id: subId, action: 'DELETE_EVERYTHING' }, requestId: 'wfapi-bad-1' })
  check('HTTP 计划：非法 action 返回 400 且无副作用（R13）', r.status === 400
    && db.prepare("SELECT count(*) n FROM subscription_operations WHERE ref_no LIKE ?").get(`wf-${planNo}-%`).n === 0,
    JSON.stringify({ status: r.status, body: r.json }))

  r = await req(`/api/workflows/${planNo}/select`, { method: 'POST', body: { subscription_id: subId, action: 'pause' }, requestId: 'wfapi-select-1' })
  const pauseRef = r.json?.data?.op_ref
  check('HTTP 计划：选择生成待确认订阅单', r.status === 200 && r.json?.data?.status === 'waiting_confirmation' && pauseRef,
    JSON.stringify({ status: r.status, body: r.json?.data?.status }))

  r = await req(`/api/subscription-operations/${pauseRef}/confirm`, { method: 'POST', body: { confirm: true }, requestId: 'wfapi-confirm-1' })
  check('HTTP 计划：界面确认订阅单', r.status === 200 && r.json?.data?.status === 'completed', JSON.stringify({ status: r.status }))

  r = await req(`/api/workflows/${planNo}`, { requestId: 'wfapi-get-1' })
  check('HTTP 计划：刷新后核验完成且全部节点完成',
    r.status === 200 && r.json?.data?.status === 'completed'
    && r.json.data.nodes.every((n) => n.status === 'completed'), JSON.stringify(r.json?.data?.status))

  // 修改使旧单失效（先恢复订阅为生效状态，独立于上一条已完成的暂停单）
  db.prepare("UPDATE subscriptions SET status='active', version=version+1 WHERE id=?").run(subId)
  r = await req('/api/workflows', { method: 'POST', body: { flow: 'subscription_review', params: { month } }, requestId: 'wfapi-create-2' })
  const plan2 = r.json?.data?.plan_no
  r = await req(`/api/workflows/${plan2}/select`, { method: 'POST', body: { subscription_id: subId, action: 'pause' }, requestId: 'wfapi-select-2' })
  const oldRef = r.json?.data?.op_ref
  r = await req(`/api/workflows/${plan2}/modify`, { method: 'POST', body: { params: { action: 'change_source', to_account_id: a2 } }, requestId: 'wfapi-modify-1' })
  const oldStatus = db.prepare('SELECT status FROM subscription_operations WHERE ref_no=?').get(oldRef)?.status
  check('HTTP 计划：修改后回到等待选择且旧单取消（F5）', r.status === 200
    && r.json?.data?.status === 'waiting_selection' && r.json?.data?.op_ref === null && oldStatus === 'cancelled',
    JSON.stringify({ status: r.json?.data?.status, oldStatus }))

  // 暂停 / 继续 / 取消 / 转人工
  r = await req(`/api/workflows/${plan2}/pause`, { method: 'POST', body: {} })
  check('HTTP 计划：暂停', r.status === 200 && r.json?.data?.status === 'paused')
  r = await req(`/api/workflows/${plan2}/resume`, { method: 'POST', body: {} })
  check('HTTP 计划：继续回到等待选择', r.status === 200 && r.json?.data?.status === 'waiting_selection')
  r = await req(`/api/workflows/${plan2}/manual`, { method: 'POST', body: {} })
  check('HTTP 计划：转人工', r.status === 200 && r.json?.data?.status === 'manual')
  r = await req('/api/workflows', { method: 'POST', body: { flow: 'subscription_review', params: { month } } })
  const plan3 = r.json?.data?.plan_no
  r = await req(`/api/workflows/${plan3}/cancel`, { method: 'POST', body: {} })
  check('HTTP 计划：取消终态', r.status === 200 && r.json?.data?.status === 'cancelled')

  // 还款链：创建 → 选择 → 强验证 → 核验
  r = await req('/api/workflows', { method: 'POST', body: { flow: 'repayment_review', params: {} }, requestId: 'wfapi-repay-create' })
  const repayPlan = r.json?.data?.plan_no
  check('HTTP 计划：创建还款审查计划', r.status === 200 && r.json?.data?.status === 'waiting_selection')
  r = await req(`/api/workflows/${repayPlan}/select`, {
    method: 'POST', body: { scope: 'all_posted', from_account_id: a1, credit_account_id: caId }, requestId: 'wfapi-repay-select',
  })
  const repayRef = r.json?.data?.op_ref
  check('HTTP 计划：生成红色强验证还款单', r.status === 200 && r.json?.data?.status === 'waiting_verification'
    && r.json?.data?.op?.risk_level === 'red', JSON.stringify({ status: r.status, op: r.json?.data?.op?.status }))
  r = await req(`/api/repayments/${repayRef}/verify`, { method: 'POST', body: { password: PASSWORD, totp: totp(0) }, requestId: 'wfapi-repay-verify' })
  check('HTTP 计划：还款强验证执行成功', r.status === 200 && r.json?.data?.status === 'completed', JSON.stringify({ status: r.status, body: r.json?.message }))
  r = await req(`/api/workflows/${repayPlan}`)
  check('HTTP 计划：还款计划核验完成且账单结清', r.status === 200 && r.json?.data?.status === 'completed'
    && db.prepare('SELECT paid_cents FROM statements WHERE id=?').get(statementId).paid_cents === 120000)

  // 刷新恢复：新服务实例（同一数据库）可读取计划与节点
  const { createWorkflowService, createLocalWorkflowOps, createLocalWorkflowStore } = await import('../src/services/workflow-plans.js')
  const restarted = createWorkflowService({
    store: createLocalWorkflowStore(db, userId), ops: createLocalWorkflowOps(db, userId), audit: trail,
  })
  const recovered = await restarted.get(repayPlan)
  check('HTTP 计划：实例重建后计划与终态可恢复', recovered && recovered.status === 'completed'
    && recovered.nodes.every((n) => n.status === 'completed'), recovered?.status)

  // P1-09：计划审计带 request_id，可从请求串到计划与操作单
  const planEvents = trail.list({ plan_id: planNo })
  check('审计关联：计划事件携带 request_id 且可串到操作单',
    planEvents.length >= 2 && planEvents.every((e) => e.request_id)
    && planEvents.some((e) => e.request_id === 'wfapi-create-1')
    && planEvents.some((e) => e.action === 'select' && e.request_id === 'wfapi-select-1' && e.operation_ref === pauseRef),
    JSON.stringify(planEvents.map((e) => [e.action, e.request_id, e.operation_ref])))
} catch (e) {
  failures += 1
  console.error('HTTP WORKFLOW TEST ERROR:', e.stack || e.message)
} finally {
  await new Promise((res) => server.close(res))
  db.close()
  console.log(`\n== 计划任务 HTTP 契约验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
