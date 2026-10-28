// 定向验证：还款模式「结清全部已入账欠款」+ 提前还款 + 现有指定账单全额（mock + 独立临时库）。
//
// 覆盖：已出账全额、仅未出账提前还、混合全部结清、待入账排除、无欠款、余额不足、
//       金额/版本变化拒绝、越权、强验证、重复确认、冻结可还、出账不重复计债、
//       提前还后新增消费、冲销明细多条同 ref、统计与逐笔额度、完整性。
// 不触碰开发库、不调用收费模型。用法：node scripts/verify-repayment-all-posted.js
import { initDatabase } from '../src/db/index.js'
import {
  createCreditConsumption, postCreditConsumption, issueStatements,
  createRepaymentOperation, getRepaymentOperation, CreditError,
} from '../src/services/credit.js'
import { bindVerification, verifyAndConfirmRepayment } from '../src/services/verification.js'
import { createAssistant } from '../src/services/assistant.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import { listTransactions } from '../src/services/transactions.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-all-posted.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'AllPosted-Test-Pass'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const now = new Date()
const iso = (s) => new Date(s).toISOString()
const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
bindVerification(db, u1, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
process.env.VERIFICATION_KEY = KEY.toString('base64')

function insAccount(uid, name, type, balance) {
  return db.prepare(
    `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
     VALUES (?, ?, ?, ?, 'CNY', ?, 'active', '2026-08-01')`,
  ).run(uid, name, balance, balance, type).lastInsertRowid
}
function makeCredit(uid, label, limit) {
  const acc = insAccount(uid, `${label}账户`, 'credit', 0)
  const ca = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)').run(uid, acc, limit).lastInsertRowid
  const card = db.prepare(
    `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
     VALUES (?, ?, ?, '信用卡', 'active', 0, '2026-08-01')`,
  ).run(uid, acc, `6259 **** **** ${String(ca).padStart(4, '0')}`).lastInsertRowid
  return { acc, ca, card, uid }
}
function charge(c, cents, atIso, postedIso = null) {
  const r = createCreditConsumption(db, c.uid, { cardId: c.card, amountCents: cents, category: '购物', merchant: '测试商户', transactionAt: atIso })
  if (postedIso) postCreditConsumption(db, c.uid, r.transaction_id, { postedAt: new Date(postedIso) })
  return r.transaction_id
}
const bal = (id) => db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(id).b
const caRow = (caId) => db.prepare('SELECT * FROM credit_accounts WHERE id = ?').get(caId)
const stmts = (caId) => db.prepare('SELECT * FROM statements WHERE credit_account_id = ? ORDER BY statement_year, statement_month').all(caId)

const payer = insAccount(u1, '活期付款账户', 'deposit', 3000000)
const payerLow = insAccount(u1, '低余额账户', 'deposit', 100000)
const payerOther = insAccount(u2, '他人活期账户', 'deposit', 3000000)

// 多步 TOTP：每次确认使用不同的时间步，避免防重放拦截
let stepOffset = 0
function confirmOp(refNo, { uid = u1, shiftSteps = null } = {}) {
  const s = shiftSteps === null ? stepOffset++ : shiftSteps
  const t = new Date(now.getTime() - (s + 1) * 30000)
  const code = totpAt(SECRET_BUF, totpStep(t.getTime()))
  return verifyAndConfirmRepayment(db, uid, refNo, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now: t })
}

console.log('—— 场景 1：混合欠款全部结清（已出账优先，未出账随后，待入账排除）——')
const C1 = makeCredit(u1, '混合', 1000000)
charge(C1, 30000, iso('2026-08-05T02:00:00Z'), iso('2026-08-07T02:00:00Z'))
charge(C1, 20000, iso('2026-10-05T02:00:00Z'), iso('2026-10-06T02:00:00Z'))
charge(C1, 5000, iso('2026-10-20T02:00:00Z')) // 待入账
issueStatements(db, u1, C1.ca, new Date(iso('2026-09-02T02:00:00Z')))
const c1Before = caRow(C1.ca)
const op1 = createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C1.ca }, now)
check('全部结清金额 = 已出账 300 + 未出账已入账 200（待入账 50 排除）', op1.amount_cents === 50000, String(op1.amount_cents))
check('分配：已出账账单优先，其次未出账', op1.allocations.length === 2 && op1.allocations[0].issued === true && op1.allocations[1].issued === false, JSON.stringify(op1.allocations.map((a) => ({ m: a.statement_month, i: a.issued, a: a.amount_cents }))))
check('准备单包含付款账户与信用卡名称', op1.from_account_id === payer && op1.credit_account_name.includes('混合'))
const balBefore1 = bal(payer)
const r1 = confirmOp(op1.ref_no)
check('强验证确认完成', r1.outcome === 'completed', r1.outcome)
check('付款账户仅扣一次合计', bal(payer) === balBefore1 - 50000, `${balBefore1}→${bal(payer)}`)
check('信用已入账未还减少 50000，待入账占用保留', caRow(C1.ca).posted_outstanding_cents === c1Before.posted_outstanding_cents - 50000 && caRow(C1.ca).pending_occupied_cents === 5000, JSON.stringify(caRow(C1.ca)))
const pays1 = db.prepare('SELECT * FROM statement_payments WHERE repayment_ref = ?').all(op1.ref_no)
check('一笔操作单产生两条冲抵明细（同 ref）', pays1.length === 2 && pays1.every((p) => p.repayment_ref === op1.ref_no))
check('两张账单剩余均为 0', stmts(C1.ca).every((s) => s.new_charges_cents === s.paid_cents), JSON.stringify(stmts(C1.ca).map((s) => [s.statement_month, s.new_charges_cents, s.paid_cents])))
const repayTx1 = db.prepare('SELECT * FROM transactions WHERE repayment_ref = ?').all(op1.ref_no)
check('还款流水仅一条且 flow_kind=repayment', repayTx1.length === 1 && repayTx1[0].flow_kind === 'repayment' && repayTx1[0].amount_cents === 50000)
const r1dup = confirmOp(op1.ref_no, { shiftSteps: 50 })
check('重复确认幂等（不重复扣款）', r1dup.outcome === 'completed' && bal(payer) === balBefore1 - 50000)
const ana = monthlyAnalytics(db, u1, { year: 2026, month: 10, accountId: payer })
check('还款不计入消费支出（单列）', ana.repayment_cents === 50000 && ana.expense_cents === 0, JSON.stringify({ rep: ana.repayment_cents, exp: ana.expense_cents }))

console.log('—— 场景 2：仅未出账欠款提前还款，出账不重复计债 ——')
const C2 = makeCredit(u1, '提前', 500000)
charge(C2, 40000, iso('2026-10-08T02:00:00Z'), iso('2026-10-09T02:00:00Z'))
const op2 = createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C2.ca }, now)
check('仅未出账已入账也可提前还款（400）', op2.amount_cents === 40000 && op2.allocations.length === 1 && op2.allocations[0].issued === false, String(op2.amount_cents))
check('提前还款确认完成', confirmOp(op2.ref_no).outcome === 'completed')
issueStatements(db, u1, C2.ca, new Date(iso('2026-11-02T02:00:00Z')))
const c2Stmt = stmts(C2.ca)[0]
check('后续出账：消费 400、已还 400、剩余 0', c2Stmt && c2Stmt.new_charges_cents === 40000 && c2Stmt.paid_cents === 40000 && c2Stmt.issued_at != null)
check('出账未再次要求偿还（已入账未还为 0）', caRow(C2.ca).posted_outstanding_cents === 0, String(caRow(C2.ca).posted_outstanding_cents))
const earlyPay = db.prepare('SELECT * FROM statement_payments WHERE repayment_ref = ?').all(op2.ref_no)
check('提前还款冲抵可追溯（paid_at 早于出账）', earlyPay.length === 1 && earlyPay[0].paid_at < c2Stmt.issued_at)

console.log('—— 场景 3：无欠款 / 余额不足 / 版本变化 ——')
const C3 = makeCredit(u1, '无欠款', 500000)
let err3 = null
try { createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C3.ca }, now) } catch (e) { err3 = e }
check('无已入账欠款 → 拒绝（不生成 0 元单）', err3 instanceof CreditError && err3.code === 'no_debt', err3 && err3.code)

const C4 = makeCredit(u1, '余额不足', 500000)
charge(C4, 200000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
let err4 = null
try { createRepaymentOperation(db, u1, { fromAccountId: payerLow, scope: 'all_posted', creditAccountId: C4.ca }, now) } catch (e) { err4 = e }
check('付款账户余额不足 → 准备单拒绝', err4 instanceof CreditError && err4.code === 'insufficient_balance', err4 && err4.code)

const C5 = makeCredit(u1, '版本变化', 500000)
const c5charge = charge(C5, 30000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
const op5 = createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C5.ca }, now)
// 建单后新增一笔已入账消费（账单版本与剩余变化）
charge(C5, 10000, iso('2026-10-04T02:00:00Z'), iso('2026-10-05T02:00:00Z'))
const balBefore5 = bal(payer)
const r5 = confirmOp(op5.ref_no)
check('欠款变化 → 旧单拒绝（stale）且不扣款', r5.outcome === 'stale' && bal(payer) === balBefore5, r5.outcome)
check('旧单状态标记 failed，未偷偷改金额', db.prepare('SELECT status, amount_cents FROM repayment_operations WHERE ref_no = ?').get(op5.ref_no).status === 'failed')

console.log('—— 场景 4：越权 ——')
const U2 = makeCredit(u2, '他人信用', 500000)
charge(U2, 20000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
let err6 = null
try { createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: U2.ca }, now) } catch (e) { err6 = e }
check('使用他人信用账户建单被拒', err6 instanceof CreditError && err6.code === 'not_found', err6 && err6.code)
const opU2 = createRepaymentOperation(db, u2, { fromAccountId: payerOther, scope: 'all_posted', creditAccountId: U2.ca }, now)
check('他人还款单对当前用户不可读', getRepaymentOperation(db, u1, opU2.ref_no) === null)
check('他人还款单不可被当前用户确认', confirmOp(opU2.ref_no, { uid: u1 }).outcome === 'not_found')

console.log('—— 场景 5：冻结卡可还款 ——')
const C7 = makeCredit(u1, '冻结', 500000)
charge(C7, 15000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
db.prepare("UPDATE cards SET status = 'frozen' WHERE id = ?").run(C7.card)
const op7 = createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C7.ca }, now)
check('冻结卡仍可生成还款单并确认', confirmOp(op7.ref_no).outcome === 'completed' && db.prepare('SELECT paid_cents p FROM statements WHERE credit_account_id = ?').get(C7.ca).p === 15000)

console.log('—— 场景 6：提前还款后新增消费 ——')
const C8 = makeCredit(u1, '新增消费', 500000)
charge(C8, 10000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
const op8 = createRepaymentOperation(db, u1, { fromAccountId: payer, scope: 'all_posted', creditAccountId: C8.ca }, now)
confirmOp(op8.ref_no)
charge(C8, 5000, iso('2026-10-06T02:00:00Z'), iso('2026-10-07T02:00:00Z'))
check('提前还款后新增消费只新增欠款（5000）', caRow(C8.ca).posted_outstanding_cents === 5000, String(caRow(C8.ca).posted_outstanding_cents))
const c8stmt = stmts(C8.ca)[0]
check('原提前还款未被撤销（已还 10000 保留）', c8stmt.paid_cents === 10000 && c8stmt.new_charges_cents === 15000, JSON.stringify([c8stmt.new_charges_cents, c8stmt.paid_cents]))

console.log('—— 场景 7：指定账单全额（原有模式）仍可用 ——')
const C9 = makeCredit(u1, '指定账单', 500000)
charge(C9, 12000, iso('2026-08-05T02:00:00Z'), iso('2026-08-06T02:00:00Z'))
issueStatements(db, u1, C9.ca, new Date(iso('2026-09-02T02:00:00Z')))
const c9stmt = stmts(C9.ca)[0]
const op9 = createRepaymentOperation(db, u1, { statementId: c9stmt.id, fromAccountId: payer, scope: 'statement' }, now)
check('指定账单模式金额 = 剩余应还，分配 1 条', op9.amount_cents === 12000 && op9.allocations.length === 1 && op9.allocations[0].statement_id === c9stmt.id)
check('指定账单模式确认完成', confirmOp(op9.ref_no).outcome === 'completed')

console.log('—— 场景 8：逐笔额度与统计 ——')
const rowsC1 = listTransactions(db, u1, { accountId: C1.acc, limit: 100, offset: 0 }).rows
check('信用逐笔额度全部可追溯', rowsC1.every((r) => r.balance_state === 'value'), JSON.stringify([...new Set(rowsC1.map((r) => r.balance_state))]))
const rowsPayer = listTransactions(db, u1, { accountId: payer, limit: 100, offset: 0 }).rows
check('付款账户逐笔结余全部可追溯', rowsPayer.every((r) => r.balance_state === 'value'))
const ana8 = monthlyAnalytics(db, u1, { year: 2026, month: 10, accountId: C8.acc })
check('信用账户统计不混入还款（expense = 两笔消费 15000）', ana8.repayment_cents === 0 && ana8.expense_cents === 15000, JSON.stringify({ rep: ana8.repayment_cents, exp: ana8.expense_cents }))

console.log('—— 场景 9：HTTP 路由（创建 / 字段校验 / 强验证）——')
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
  const C10 = makeCredit(u1, 'HTTP', 500000)
  charge(C10, 8000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
  const bad = await post(`${base}/repayments`, { scope: 'all_posted', statement_id: 1, from_account_id: payer })
  check('all_posted 携带 statement_id → 400', bad.status === 400)
  const badScope = await post(`${base}/repayments`, { scope: 'partial', from_account_id: payer })
  check('非法 scope → 400', badScope.status === 400)
  const created = await post(`${base}/repayments`, { scope: 'all_posted', from_account_id: payer, credit_account_id: C10.ca })
  const cb = await created.json()
  check('HTTP 创建全部结清还款单', created.status === 200 && cb.data.scope === 'all_posted' && cb.data.amount_cents === 8000, `${created.status}`)
  const wrong = await post(`${base}/repayments/${cb.data.ref_no}/verify`, { password: 'wrong', totp: '000000' })
  check('HTTP 错误凭据 → 401', wrong.status === 401)
  // HTTP 路由使用真实当前时间校验，动态码必须取当前时间步
  const code = totpAt(SECRET_BUF, totpStep(Date.now()))
  const okRes = await post(`${base}/repayments/${cb.data.ref_no}/verify`, { password: PASSWORD, totp: code })
  const okBody = await okRes.json()
  check('HTTP 正确凭据 → 200 completed', okRes.status === 200 && okBody.data.status === 'completed', `${okRes.status} ${okBody.message || ''}`)
})

console.log('—— 场景 10：AI 工具 prepare_repayment（mode=all_posted）——')
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function makeMock(script) {
  let i = 0
  const fn = async () => {
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  return fn
}
{
  const C11 = makeCredit(u1, 'AI模式', 500000)
  charge(C11, 7000, iso('2026-10-02T02:00:00Z'), iso('2026-10-03T02:00:00Z'))
  const assistant = createAssistant({
    db, demoUserId: u1,
    chatFn: makeMock([
      { toolCalls: [tc('r1', 'prepare_repayment', { mode: 'all_posted', credit_account_id: C11.ca, from_account_id: payer })] },
      { content: '已生成待确认还款单。' },
    ]),
  })
  const res = await assistant.chat({ message: '把已入账欠款全部还清' })
  const rec = res.toolRecords[0]
  check('AI 工具生成全部结清还款单（金额由服务端计算）', rec.status === 'ok' && rec.data.scope === 'all_posted' && rec.data.amount_cents === 7000, rec.status === 'error' ? rec.error : String(rec.data.amount_cents))
  const assistant2 = createAssistant({
    db, demoUserId: u1,
    chatFn: makeMock([
      { toolCalls: [tc('r2', 'prepare_repayment', { mode: 'all_posted', from_account_id: payer })] },
      { content: '请先选择信用卡。' },
    ]),
  })
  const res2 = await assistant2.chat({ message: '全部还清' })
  check('多张信用卡未指定 → 工具要求澄清', res2.toolRecords[0].status === 'error' && /多个信用账户/.test(res2.toolRecords[0].error || ''), res2.toolRecords[0].error)
}

const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('integrity_check = ok', ic.length === 1 && ic[0].integrity_check === 'ok')
check('foreign_key_check 无违例', fk.length === 0)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n全部结清还款定向验证全部通过 ✅（独立临时库）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
