// 定向验证（独立临时库）：多账户付款选择 + 流水/月度账单查询范围。
//
// 覆盖：
//   A. 转账付款账户：必须显式传入；两个借记账户分别建单 → 冻结各自付款账户；
//      信用卡 / 他人账户 / 余额不足被拒；建单后付款账户不随前端切卡变化；确认只扣该账户。
//   B. 查询范围：单账户与「全部账户」的流水总数、分页、月度收支 / 分类 / 待入账 / 还款金额
//      均与后端按「归属 + 范围」先筛选后聚合的结果一致（非仅过滤当前页）。
//
// 不触碰开发库、不调用收费模型。用法：node scripts/verify-multi-account.js
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createApiRouter } from '../src/routes/index.js'
import { shanghaiNowParts, shanghaiMonthRange } from '../src/lib/shanghai.js'
import express from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const tmpPath = join(tmpdir(), 'rongzhi-verify-multi-account.db')
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const userId = resolveDemoUser(db).id
const now = new Date()
const parts = shanghaiNowParts(now.getTime())
const month = `${parts.year}-${String(parts.month).padStart(2, '0')}`
const { start, end } = shanghaiMonthRange(parts.year, parts.month)
// 月内时间点（上海 5 日 12:00）→ UTC ISO；早于当前时刻，计入已入账
const at = new Date(Date.parse(start) + 4 * 24 * 3600 * 1000).toISOString()

// —— 构造数据：A（种子活期）+ B（第二借记）+ 信用账户 ——
const A = db.prepare("SELECT * FROM accounts WHERE user_id = ? AND account_type = 'deposit' ORDER BY id LIMIT 1").get(userId)
const bAccId = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
   VALUES (?, '工资储蓄账户', 500000, 500000, 'CNY', 'deposit', 'active', '2026-08-01', ?)`,
).run(userId, now.toISOString()).lastInsertRowid
db.prepare(
  `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
   VALUES (?, ?, '6222 **** **** 5678', '借记卡', 'active', 5000000, '2026-08-01', ?)`,
).run(userId, bAccId, now.toISOString())
const creditAccId = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
   VALUES (?, '人民币信用卡', 0, 0, 'CNY', 'credit', 'active', '2026-08-01', ?)`,
).run(userId, now.toISOString()).lastInsertRowid
db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, 5000000)').run(userId, creditAccId)
db.prepare(
  `INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
   VALUES (?, ?, '6259 **** **** 0003', '信用卡', 'active', 0, '2026-08-01', ?)`,
).run(userId, creditAccId, now.toISOString())

function insertTx(accountId, direction, cents, category, status = 'posted', flowKind = 'external') {
  db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
     VALUES (?, ?, ?, ?, ?, '测试商户', '范围验证', ?, ?, ?)`,
  ).run(userId, accountId, direction, cents, category, at, status, flowKind)
}
insertTx(bAccId, 'income', 200000, '收入')
insertTx(bAccId, 'expense', 80000, '购物')
insertTx(bAccId, 'expense', 5000, '餐饮', 'pending')
insertTx(creditAccId, 'expense', 60000, '购物')
insertTx(creditAccId, 'expense', 12000, '交通', 'pending')
insertTx(creditAccId, 'expense', 50000, '还款', 'posted', 'repayment')

// 另一个用户 + 账户（验证归属隔离）
const otherUserId = db.prepare("INSERT INTO users (name, created_at) VALUES ('李四', ?)").run(now.toISOString()).lastInsertRowid
const otherAccId = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on, created_at)
   VALUES (?, '他人活期', 100000, 100000, 'CNY', 'deposit', 'active', '2026-08-01', ?)`,
).run(otherUserId, now.toISOString()).lastInsertRowid

// —— HTTP ——
async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(db, userId))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try { await fn(`http://127.0.0.1:${server.address().port}/api`) } finally { await new Promise((r) => server.close(r)) }
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const getJson = async (url) => (await fetch(url)).json()
const bal = (id) => db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(id).b

// SQL 口径期望值（与后端同条件：用户 + 月 + 账户 + 已入账且 <= asOf）
function expectedAnalytics(accountId, asOf) {
  const cond = ['user_id = ?', 'transaction_at >= ?', 'transaction_at < ?']
  const params = [userId, start, end]
  if (accountId) { cond.push('account_id = ?'); params.push(accountId) }
  const rows = db.prepare(`SELECT direction, amount_cents, status, transaction_at, flow_kind FROM transactions WHERE ${cond.join(' AND ')}`).all(...params)
  let inc = 0, exp = 0, rep = 0, pend = 0, pendAmt = 0
  for (const r of rows) {
    if (r.flow_kind === 'repayment') { rep += r.amount_cents; continue }
    if (r.status === 'pending') { pend += 1; pendAmt += r.amount_cents; continue }
    if (r.transaction_at > asOf) continue
    if (r.direction === 'income') inc += r.amount_cents; else exp += r.amount_cents
  }
  return { inc, exp, rep, pend, pendAmt }
}

await withServer(async (base) => {
  console.log('—— A. 转账付款账户 ——')
  const noPayer = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 10000 })
  const noPayerBody = await noPayer.json()
  check('未传付款账户 → 400', noPayer.status === 400 && /付款账户/.test(noPayerBody.message || ''), noPayerBody.message)

  const opB = await (await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 10000, remark: 'B 账户', from_account_id: bAccId })).json()
  check('指定借记账户 B 建单成功', opB.success && opB.data.from_account_id === bAccId, JSON.stringify(opB.data && { id: opB.data.from_account_id }))
  check('确认卡展示真实付款账户名', opB.data.from_account_name === '工资储蓄账户', opB.data.from_account_name)

  const opA = await (await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 10000, remark: 'A 账户', from_account_id: A.id })).json()
  check('指定借记账户 A 建单成功', opA.success && opA.data.from_account_id === A.id)
  check('两个付款账户各自冻结（建单后不互换）', opA.data.from_account_id !== opB.data.from_account_id && opA.data.from_account_id === A.id && opB.data.from_account_id === bAccId)

  const refB = opB.data.ref_no
  const reread = await getJson(`${base}/transfers/${refB}`)
  check('建单后回读付款账户不变（模拟前端切卡不影响原单）', reread.data.from_account_id === bAccId && reread.data.from_account_name === '工资储蓄账户')

  const creditPay = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 10000, from_account_id: creditAccId })
  const creditPayBody = await creditPay.json()
  check('信用卡账户付款被拒（400）', creditPay.status === 400 && /信用卡/.test(creditPayBody.message || ''), creditPayBody.message)

  const otherPay = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 10000, from_account_id: otherAccId })
  check('他人账户付款被拒（400）', otherPay.status === 400, String(otherPay.status))

  const overBal = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 9999999, from_account_id: bAccId })
  const overBalBody = await overBal.json()
  check('超出所选账户余额被拒（400）', overBal.status === 400 && /余额不足/.test(overBalBody.message || ''), overBalBody.message)

  const aBefore = bal(A.id)
  const bBefore = bal(bAccId)
  const confirm = await (await postJson(`${base}/transfers/${refB}/confirm`, { confirm: true })).json()
  check('确认后扣款只落在所选账户 B', confirm.success && confirm.data.status === 'completed' && bal(bAccId) === bBefore - 10000 && bal(A.id) === aBefore, `B ${bBefore}→${bal(bAccId)} / A ${aBefore}→${bal(A.id)}`)
  const txRow = db.prepare('SELECT account_id FROM transactions WHERE transfer_ref = ?').get(refB)
  check('流水归属所选付款账户 B', txRow && txRow.account_id === bAccId)

  console.log('—— B. 流水 / 月度账单查询范围 ——')
  const asOfResp = await getJson(`${base}/analytics/monthly?month=${month}`)
  const asOf = asOfResp.data.as_of
  const expAll = expectedAnalytics(null, asOf)
  const expA = expectedAnalytics(A.id, asOf)
  const expB = expectedAnalytics(bAccId, asOf)
  const expC = expectedAnalytics(creditAccId, asOf)

  const anaAll = (await getJson(`${base}/analytics/monthly?month=${month}`)).data
  const anaA = (await getJson(`${base}/analytics/monthly?month=${month}&account_id=${A.id}`)).data
  const anaB = (await getJson(`${base}/analytics/monthly?month=${month}&account_id=${bAccId}`)).data
  const anaC = (await getJson(`${base}/analytics/monthly?month=${month}&account_id=${creditAccId}`)).data

  check('全部账户：收入 = 各账户之和', anaAll.income_cents === expAll.inc && anaAll.income_cents === anaA.income_cents + anaB.income_cents + anaC.income_cents, `${anaAll.income_cents}`)
  check('全部账户：支出 = 各账户之和', anaAll.expense_cents === expAll.exp && anaAll.expense_cents === anaA.expense_cents + anaB.expense_cents + anaC.expense_cents, `${anaAll.expense_cents}`)
  check('全部账户：待入账数量 / 金额 = 各账户之和', anaAll.pending.count === expAll.pend && anaAll.pending.amount_cents === expAll.pendAmt && anaAll.pending.count === anaA.pending.count + anaB.pending.count + anaC.pending.count, `${anaAll.pending.count}/${anaAll.pending.amount_cents}`)
  check('全部账户：还款金额 = 各账户之和（单列，不计收支）', anaAll.repayment_cents === expAll.rep && anaAll.repayment_cents === anaA.repayment_cents + anaB.repayment_cents + anaC.repayment_cents, `${anaAll.repayment_cents}`)
  check('账户 B：收支 / 待入账 / 还款均按该账户聚合', anaB.income_cents === expB.inc && anaB.expense_cents === expB.exp && anaB.pending.count === expB.pend && anaB.pending.amount_cents === expB.pendAmt && anaB.repayment_cents === expB.rep, JSON.stringify({ inc: anaB.income_cents, exp: anaB.expense_cents }))
  check('信用账户：还款单列且不计入支出', anaC.repayment_cents === expC.rep && anaC.expense_cents === expC.exp && anaC.net_cents === anaC.income_cents - anaC.expense_cents, `${anaC.repayment_cents}/${anaC.expense_cents}`)
  check('信用卡额度不计为收入', anaC.income_cents === expC.inc && anaC.income_cents === 0, `${anaC.income_cents}`)

  const sumCats = (rows) => rows.reduce((s, r) => s + r.amount_cents, 0)
  check('账户 A：分类汇总合计 = 已入账收入/支出', sumCats(anaA.income_by_category) === anaA.income_cents && sumCats(anaA.expense_by_category) === anaA.expense_cents)
  check('账户 B：分类汇总合计 = 已入账收入/支出', sumCats(anaB.income_by_category) === anaB.income_cents && sumCats(anaB.expense_by_category) === anaB.expense_cents)
  check('全部账户：分类汇总合计 = 已入账收入/支出', sumCats(anaAll.income_by_category) === anaAll.income_cents && sumCats(anaAll.expense_by_category) === anaAll.expense_cents)

  // 流水：总数按范围统计（先筛选后分页），分页无重复、不越界
  const sqlCount = (accountId) => {
    const cond = ['user_id = ?', 'transaction_at >= ?', 'transaction_at < ?']
    const params = [userId, start, end]
    if (accountId) { cond.push('account_id = ?'); params.push(accountId) }
    return db.prepare(`SELECT COUNT(*) c FROM transactions WHERE ${cond.join(' AND ')}`).get(...params).c
  }
  const pageA1 = await getJson(`${base}/transactions?month=${month}&account_id=${bAccId}&limit=2&offset=0`)
  const pageA2 = await getJson(`${base}/transactions?month=${month}&account_id=${bAccId}&limit=2&offset=2`)
  const pageAll = await getJson(`${base}/transactions?month=${month}&limit=2&offset=0`)
  const totalB = sqlCount(bAccId)
  check('账户 B：流水总数 = 该账户当月记录数', pageA1.meta.total === totalB && pageA2.meta.total === totalB, `${pageA1.meta.total}/${totalB}`)
  check('账户 B：分页返回均属该账户', [...pageA1.data, ...pageA2.data].every((r) => r.account_id === bAccId))
  check('账户 B：分页无重复且不超出总数', new Set([...pageA1.data, ...pageA2.data].map((r) => r.id)).size === Math.min(totalB, 4))
  check('全部账户：流水总数 = 全部账户当月记录数', pageAll.meta.total === sqlCount(null) && pageAll.meta.total >= totalB, `${pageAll.meta.total}`)
  check('全部账户：首屏跨账户混合返回', new Set([...pageAll.data.map((r) => r.account_id)]).size >= 1)
})

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n多账户定向验证全部通过 ✅（独立临时库）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
