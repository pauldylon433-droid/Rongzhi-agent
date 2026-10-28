// 定向验证：订阅「更换扣款账户」（mock + 独立临时库）。
//
// 覆盖：来源查询 / 借记→借记 / 借记→信用 / 信用→借记 / 暂停与生效状态不变 / 取消拒绝 / 同来源拒绝 /
//       越权 / 冻结与失效来源 / 账户无卡 / 币种不符 / 无副作用 / 版本变化 / 过期 / 强验证与防重放 /
//       重复确认 / 旧待确认单失效 / AI 工具 / HTTP 路由 / 完整性。
// 不触碰开发库、不调用收费模型。用法：node scripts/verify-subscription-source-change.js
import { initDatabase } from '../src/db/index.js'
import {
  createSubscriptionOperation, confirmSubscriptionOperation, getSubscriptionOperation,
  cancelSubscriptionOperation, SubscriptionOpError,
} from '../src/services/subscription-operations.js'
import { listSubscriptions } from '../src/services/subscriptions.js'
import { bindVerification, verifyAndConfirmSubscriptionResume } from '../src/services/verification.js'
import { createAssistant } from '../src/services/assistant.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-sub-source.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'SubSource-Test-Pass'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const now = new Date()
const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
bindVerification(db, u1, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
process.env.VERIFICATION_KEY = KEY.toString('base64')

function insAccount(uid, name, type, balance, currency = 'CNY') {
  return db.prepare(
    `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
     VALUES (?, ?, ?, ?, ?, ?, 'active', '2026-08-01')`,
  ).run(uid, name, balance, balance, currency, type).lastInsertRowid
}
function insCard(uid, accountId, masked, type, status = 'active') {
  return db.prepare(
    `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
     VALUES (?, ?, ?, ?, ?, 5000000, '2026-08-01')`,
  ).run(uid, accountId, masked, type, status).lastInsertRowid
}
function insSub(uid, accountId, merchant, amount, cycle, status) {
  return db.prepare(
    `INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, version, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-11-15T01:00:00.000Z', ?, 1, '2026-10-01T00:00:00.000Z')`,
  ).run(uid, accountId, merchant, amount, cycle, status).lastInsertRowid
}

const A = insAccount(u1, '活期账户 A', 'deposit', 1000000)
const cardA = insCard(u1, A, '6222 **** **** 1111', '借记卡')
const B = insAccount(u1, '工资储蓄账户', 'deposit', 100000)
const cardB = insCard(u1, B, '6222 **** **** 5678', '借记卡')
const C = insAccount(u1, '人民币信用卡', 'credit', 0)
const caC = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, 500000)').run(u1, C).lastInsertRowid
const cardC = insCard(u1, C, '6259 **** **** 0003', '信用卡')
const D = insAccount(u1, '冻结卡账户', 'deposit', 500000)
insCard(u1, D, '6222 **** **** 2222', '借记卡', 'frozen')
const E = insAccount(u1, '无卡账户', 'deposit', 500000)
const USD = insAccount(u1, '美元账户', 'deposit', 500000, 'USD')
insCard(u1, USD, '6222 **** **** 3333', '借记卡')
const U2A = insAccount(u2, '他人账户', 'deposit', 500000)
insCard(u2, U2A, '6222 **** **** 9999', '借记卡')
const U2B = insAccount(u2, '他人账户二', 'deposit', 500000)
insCard(u2, U2B, '6222 **** **** 8888', '借记卡')

const sActive = insSub(u1, A, 'Adobe 摄影计划', 8800, 'yearly', 'active')
const sPaused = insSub(u1, A, '爱奇艺会员', 2500, 'monthly', 'paused')
const sCancelled = insSub(u1, A, 'QQ音乐豪华绿钻', 1500, 'monthly', 'cancelled')
const sCardless = insSub(u1, E, '无卡订阅', 1000, 'monthly', 'active')
const sU2 = insSub(u2, U2A, '他人订阅', 2000, 'monthly', 'active')

const txCount = () => db.prepare('SELECT COUNT(*) c FROM transactions').get().c
const subRow = (id) => db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
const bal = (id) => db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(id).b
let step = 0
function confirm(ref, { uid = u1, shift = null, password = PASSWORD } = {}) {
  const s = shift === null ? step++ : shift
  const t = new Date(now.getTime() - (s + 1) * 30000)
  const code = totpAt(SECRET_BUF, totpStep(t.getTime()))
  return verifyAndConfirmSubscriptionResume(db, uid, ref, { password, totp: code }, { encryptionKey: KEY, now: t })
}
const createErr = (args, uid = u1) => {
  try { createSubscriptionOperation(db, uid, args); return null } catch (e) { return e }
}

console.log('—— 来源查询 ——')
{
  const subs = listSubscriptions(db, u1)
  const a = subs.find((s) => s.id === sActive)
  check('查询返回扣款账户名 / 卡种 / 脱敏尾号', a.account_name === '活期账户 A' && a.card_type === '借记卡' && a.masked_card_number === '6222 **** **** 1111', JSON.stringify({ n: a.account_name, m: a.masked_card_number }))
  const c = subs.find((s) => s.id === sCardless)
  check('账户无卡时卡字段为空（不回退第一张卡）', c.account_name === '无卡账户' && c.masked_card_number === null, String(c.masked_card_number))
}

console.log('—— 建单：快照 / 无副作用 / 规则拒绝 ——')
{
  const tx0 = txCount()
  const balA0 = bal(A)
  const op = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: B })
  check('借记→借记：操作单为红色待验证', op.action === 'change_source' && op.risk_level === 'red' && op.status === 'needs_verification')
  check('冻结原/新来源与卡号快照', op.from_account_id === A && op.from_masked_card === '6222 **** **** 1111' && op.to_account_id === B && op.to_masked_card === '6222 **** **** 5678', JSON.stringify({ f: op.from_masked_card, t: op.to_masked_card }))
  check('建单不改变订阅绑定 / 状态', subRow(sActive).account_id === A && subRow(sActive).status === 'active')
  check('建单不产生流水、不改变余额', txCount() === tx0 && bal(A) === balA0)

  const same = createErr({ subscriptionId: sActive, action: 'change_source', toAccountId: A })
  check('同来源 → 拒绝', same instanceof SubscriptionOpError && same.code === 'same_source', same && same.code)
  const cancelled = createErr({ subscriptionId: sCancelled, action: 'change_source', toAccountId: B })
  check('已取消订阅 → 拒绝（不能借更换重新开通）', cancelled instanceof SubscriptionOpError && cancelled.code === 'cancelled', cancelled && cancelled.code)
  const frozen = createErr({ subscriptionId: sActive, action: 'change_source', toAccountId: D })
  check('冻结卡来源 → 拒绝', frozen instanceof SubscriptionOpError && frozen.code === 'card_unavailable', frozen && frozen.code)
  const noCard = createErr({ subscriptionId: sActive, action: 'change_source', toAccountId: E })
  check('无卡账户 → 拒绝', noCard instanceof SubscriptionOpError && noCard.code === 'card_unavailable', noCard && noCard.code)
  const usd = createErr({ subscriptionId: sActive, action: 'change_source', toAccountId: USD })
  check('币种不符 → 拒绝', usd instanceof SubscriptionOpError && usd.code === 'currency_mismatch', usd && usd.code)
  const other = createErr({ subscriptionId: sActive, action: 'change_source', toAccountId: U2A })
  check('他人账户 → 拒绝', other instanceof SubscriptionOpError && other.code === 'not_found', other && other.code)
  const otherSub = createErr({ subscriptionId: sU2, action: 'change_source', toAccountId: B })
  check('他人订阅 → 拒绝', otherSub instanceof SubscriptionOpError && otherSub.code === 'not_found', otherSub && otherSub.code)
}

console.log('—— 确认：暂停保持暂停 / 生效保持生效 / 信用与借记互换 ——')
{
  const vPaused0 = subRow(sPaused).version
  const opP = createSubscriptionOperation(db, u1, { subscriptionId: sPaused, action: 'change_source', toAccountId: B })
  check('暂停订阅更换完成', confirm(opP.ref_no).outcome === 'completed')
  check('暂停状态保持不变且来源已更新', subRow(sPaused).status === 'paused' && subRow(sPaused).account_id === B && subRow(sPaused).version === vPaused0 + 1)

  const creditOut0 = db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE id = ?').get(caC)
  const balA0 = bal(A)
  const tx0 = txCount()
  const opC = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: C })
  check('借记→信用完成', confirm(opC.ref_no).outcome === 'completed' && subRow(sActive).account_id === C)
  check('生效状态保持不变', subRow(sActive).status === 'active')
  check('更换不改变余额 / 额度 / 流水', bal(A) === balA0 && txCount() === tx0 && JSON.stringify(db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE id = ?').get(caC)) === JSON.stringify(creditOut0))

  const opA = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: A })
  check('信用→借记完成', confirm(opA.ref_no).outcome === 'completed' && subRow(sActive).account_id === A)
}

console.log('—— 强验证 / 重复确认 / 防重放 ——')
{
  const op = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: B })
  let wrong = null
  try { confirm(op.ref_no, { password: 'wrong', shift: 30 }) } catch (e) { wrong = e }
  check('错误交易密码 → 拒绝（凭据错误）', !!wrong && (wrong.code === 'bad_credentials' || /错误/.test(wrong.message)), wrong && (wrong.code || wrong.message))
  check('失败后订阅未变更', subRow(sActive).account_id === A)
  const okRes = confirm(op.ref_no, { shift: 31 })
  check('正确双因素 → 完成', okRes.outcome === 'completed')
  check('重复确认幂等（版本只 +1）', (() => { const v = subRow(sActive).version; const r = confirm(op.ref_no, { shift: 32 }); return r.outcome === 'completed' && subRow(sActive).version === v })())
  // 防重放：同一时间步用于另一张新单 → 拒绝
  const opReplay = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: A })
  let replay = null
  try { confirm(opReplay.ref_no, { shift: 31 }) } catch (e) { replay = e }
  check('同一时间步跨单复用被拒（防重放）', !!replay && replay.code === 'code_reused', replay && (replay.code || replay.message))
  check('防重放拒绝不改变绑定', subRow(sActive).account_id === B)
}

console.log('—— 版本变化 / 过期 / 旧待确认单 ——')
{
  const op = createSubscriptionOperation(db, u1, { subscriptionId: sPaused, action: 'change_source', toAccountId: A })
  db.prepare('UPDATE subscriptions SET version = version + 1 WHERE id = ?').run(sPaused)
  const accBefore = subRow(sPaused).account_id
  const r = confirm(op.ref_no)
  check('订阅版本变化 → 旧单失效（failed）且不改绑定', r.outcome === 'failed' && subRow(sPaused).account_id === accBefore, r.outcome)

  const opPause = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'pause' })
  const opChange = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: C })
  check('先建暂停单再建换卡单', opPause.status === 'pending' && opChange.status === 'needs_verification')
  check('更换确认完成', confirm(opChange.ref_no).outcome === 'completed')
  const oldPause = confirmSubscriptionOperation(db, u1, opPause.ref_no)
  check('旧待确认暂停单因版本变化失效（不静默改用新来源）', oldPause.outcome === 'stale' && subRow(sActive).status === 'active' && subRow(sActive).account_id === C, oldPause.outcome)

  const opExp = createSubscriptionOperation(db, u1, { subscriptionId: sActive, action: 'change_source', toAccountId: B })
  db.prepare("UPDATE subscription_operations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE ref_no = ?").run(opExp.ref_no)
  const exp = confirm(opExp.ref_no)
  check('过期操作单 → expired 且不改绑定', exp.outcome === 'expired' && subRow(sActive).account_id === C, exp.outcome)
}

console.log('—— 越权操作单 ——')
{
  const opU2 = createSubscriptionOperation(db, u2, { subscriptionId: sU2, action: 'change_source', toAccountId: U2B })
  check('他人操作单不可读', getSubscriptionOperation(db, u1, opU2.ref_no) === null)
  check('他人操作单不可确认', confirm(opU2.ref_no, { uid: u1 }).outcome === 'not_found')
  const cancelOther = cancelSubscriptionOperation(db, u1, opU2.ref_no)
  check('他人操作单不可取消', cancelOther.outcome === 'not_found')
}

console.log('—— AI 工具 ——')
{
  function tc(id, name, args) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } }
  function mock(script) { let i = 0; return async () => { const s = i < script.length ? script[i] : { content: 'x' }; i += 1; return { content: s.content ?? '', toolCalls: s.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } } }
  const a1 = createAssistant({ db, demoUserId: u1, chatFn: mock([{ toolCalls: [tc('s1', 'prepare_subscription_operation', { subscription_id: sActive, action: 'change_source', to_account_id: B })] }, { content: '已生成。' }]) })
  const r1 = await a1.chat({ message: '把 Adobe 的扣款账户改成尾号 5678' })
  check('AI 可准备更换扣款账户操作单', r1.toolRecords[0].status === 'ok' && r1.toolRecords[0].data.action === 'change_source' && r1.toolRecords[0].data.to_account_id === B, r1.toolRecords[0].error || '')
  const a2 = createAssistant({ db, demoUserId: u1, chatFn: mock([{ toolCalls: [tc('s2', 'prepare_subscription_operation', { subscription_id: sActive, action: 'change_source' })] }, { content: '请选择。' }]) })
  const r2 = await a2.chat({ message: '换一下扣款卡' })
  check('缺少 to_account_id → 工具要求澄清', r2.toolRecords[0].status === 'error' && /to_account_id/.test(r2.toolRecords[0].error || ''), r2.toolRecords[0].error)
}

console.log('—— HTTP 路由 ——')
{
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
    const current = subRow(sActive).account_id
    const target = current === A ? B : A
    const bad = await post(`${base}/subscription-operations`, { subscription_id: sActive, action: 'change_source', to_account_id: current })
    check('HTTP 同来源 → 400', bad.status === 400)
    const created = await post(`${base}/subscription-operations`, { subscription_id: sActive, action: 'change_source', to_account_id: target })
    const cb = await created.json()
    check('HTTP 创建更换操作单', created.status === 200 && cb.data.action === 'change_source' && cb.data.to_account_id === target)
    const wrong = await post(`${base}/subscription-operations/${cb.data.ref_no}/verify`, { password: 'nope', totp: '000000' })
    check('HTTP 错误凭据 → 401', wrong.status === 401)
    const code = totpAt(SECRET_BUF, totpStep(Date.now()))
    const okRes = await post(`${base}/subscription-operations/${cb.data.ref_no}/verify`, { password: PASSWORD, totp: code })
    const okBody = await okRes.json()
    check('HTTP 正确凭据 → 200 completed，绑定已换', okRes.status === 200 && okBody.data.status === 'completed' && subRow(sActive).account_id === target, `${okRes.status}`)
    const plainConfirm = await post(`${base}/subscription-operations/${cb.data.ref_no}/confirm`, { confirm: true })
    check('已完成单普通确认返回成功幂等（不重复变更）', plainConfirm.status === 200)
  })
}

const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('integrity_check = ok', ic.length === 1 && ic[0].integrity_check === 'ok')
check('foreign_key_check 无违例', fk.length === 0)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n订阅扣款账户更换定向验证全部通过 ✅（独立临时库）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
