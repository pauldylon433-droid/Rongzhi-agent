// 模拟转账验证脚本：在独立临时数据库上运行，不清空、不触碰开发数据库，不调用收费模型。
// 覆盖：创建不扣款 / 黄色确认扣款入账 / 防重复 / 取消·过期·余额不足·异常账户 /
//       1000 元边界与跨过 / 上海跨日重置 / 确认时重新判累计 / 篡改与归属 /
//       红色无法普通确认 / 事务回滚 / 转账后余额与流水一致。
// 用法：node scripts/verify-transfers.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createTransfer, confirmTransfer, cancelTransfer, getTransfer, listRecipients,
  TransferError, DAILY_TRANSFER_LIMIT_CENTS, TRANSFER_EXPIRY_MS,
} from '../src/services/transfers.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-transfers.db')
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function expectThrow(fn, code) {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof TransferError && (!code || e.code === code)
  }
}

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const demoUser = resolveDemoUser(db)
const userId = demoUser.id

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
// 构造某上海自然日 10:00 的绝对时刻（用于固定「今天」与日累计口径）
function shDate(year, month, day, hour = 10, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS)
}
function acct() {
  return db.prepare('SELECT id, account_name AS name, balance_cents AS b, status FROM accounts WHERE user_id = ?').get(userId)
}
function txOf(refNo) {
  return db.prepare('SELECT * FROM transactions WHERE transfer_ref = ?').get(refNo)
}

console.log('—— 收款人与入参校验 ——')
const recipients = listRecipients(db)
check('存在 4 个虚构收款人', recipients.length === 4 && recipients.every((r) => r.name && r.masked_account))

const now = shDate(2026, 10, 1)
for (const a of [0, -100, 1.5, NaN, 2 ** 53, '1000', null, undefined]) {
  check(`非法金额被拒绝 (${String(a)})`, expectThrow(() => createTransfer(db, userId, { recipientId: 1, amountCents: a }, now), 'bad_amount'))
}
check('收款人 0 被拒绝', expectThrow(() => createTransfer(db, userId, { recipientId: 0, amountCents: 100 }, now), 'bad_recipient'))
check('收款人不存在被拒绝', expectThrow(() => createTransfer(db, userId, { recipientId: 999, amountCents: 100 }, now), 'bad_recipient'))

console.log('—— 创建不扣款 / 黄色确认扣款入账 / 防重复 ——')
const before0 = acct().b
const op = createTransfer(db, userId, { recipientId: 1, amountCents: 5000, remark: '测试' }, now)
check('创建为黄色待确认', op.status === 'pending' && op.risk_level === 'yellow', `status=${op.status} risk=${op.risk_level}`)
check('操作快照保存付款账户/收款人/金额/备注', op.from_account_name && op.recipient_name === '李雷' && op.amount_cents === 5000 && op.remark === '测试')
check('创建不扣款', acct().b === before0, `before=${before0} after=${acct().b}`)
check('创建不产生流水', !txOf(op.ref_no))

const r1 = confirmTransfer(db, userId, op.ref_no, now)
check('黄色确认成功', r1.outcome === 'completed')
check('确认后扣款一次', acct().b === before0 - 5000, `期望 ${before0 - 5000} 实际 ${acct().b}`)
const tx1 = txOf(op.ref_no)
check('确认写入一条已入账转账流水', !!tx1 && tx1.status === 'posted' && tx1.category === '转账' && tx1.direction === 'expense')
check('流水金额与收款人来自操作快照', tx1 && tx1.amount_cents === 5000 && tx1.merchant === '李雷')
check('回执含真实流水编号', typeof r1.op.transaction_id === 'number')
const confirmAudit = db.prepare("SELECT * FROM audit_logs WHERE operation_type='transfer' AND action='confirm'").get()
check('确认写入成功审计', !!confirmAudit && confirmAudit.result === 'success')

const r2 = confirmTransfer(db, userId, op.ref_no, now)
check('重复确认幂等返回原回执', r2.outcome === 'completed' && r2.op.transaction_id === r1.op.transaction_id)
check('重复确认不重复扣款', acct().b === before0 - 5000)
check('重复确认不产生第二条流水', db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE transfer_ref = ?').get(op.ref_no).c === 1)
check('已完成后查看返回原回执', getTransfer(db, userId, op.ref_no, now).status === 'completed')

console.log('—— 取消 / 过期不扣款 ——')
const now2 = shDate(2026, 10, 2)
const b2 = acct().b
const op2 = createTransfer(db, userId, { recipientId: 2, amountCents: 3000 }, now2)
check('取消成功', cancelTransfer(db, userId, op2.ref_no, now2).outcome === 'cancelled')
check('取消不扣款', acct().b === b2)
check('取消无流水', !txOf(op2.ref_no))

const now3 = shDate(2026, 10, 3)
const b3 = acct().b
const op3 = createTransfer(db, userId, { recipientId: 3, amountCents: 4000 }, now3)
const late3 = new Date(now3.getTime() + TRANSFER_EXPIRY_MS + 1000)
check('过期确认返回 expired', confirmTransfer(db, userId, op3.ref_no, late3).outcome === 'expired')
check('过期不扣款', acct().b === b3)
check('过期状态落库', getTransfer(db, userId, op3.ref_no, late3).status === 'expired')

console.log('—— 余额不足 / 异常账户不扣款 ——')
const b9 = acct().b
check('创建金额超过余额被拒绝', expectThrow(() => createTransfer(db, userId, { recipientId: 1, amountCents: b9 + 1 }, now), 'insufficient_balance'))
check('余额不足创建不改变余额', acct().b === b9)

const now5 = shDate(2026, 10, 5)
const b5 = acct().b
const op5 = createTransfer(db, userId, { recipientId: 4, amountCents: 2000 }, now5)
db.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").run(acct().id)
check('冻结账户确认返回 failed', confirmTransfer(db, userId, op5.ref_no, now5).outcome === 'failed')
db.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").run(acct().id)
check('冻结账户确认不扣款', acct().b === b5)
check('失败状态落库', getTransfer(db, userId, op5.ref_no, now5).status === 'failed')

console.log('—— 1000 元边界 / 累计跨过 / 跨日重置 ——')
const now6 = shDate(2026, 10, 6)
const b6 = acct().b
const op6 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now6)
check('恰好 100000 分为黄色（未超限）', op6.risk_level === 'yellow', `risk=${op6.risk_level}`)
check('边界确认成功', confirmTransfer(db, userId, op6.ref_no, now6).outcome === 'completed')
check('边界扣款正确', acct().b === b6 - 100000)

const now7 = shDate(2026, 10, 7)
const op7a = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now7)
confirmTransfer(db, userId, op7a.ref_no, now7)
const op7b = createTransfer(db, userId, { recipientId: 1, amountCents: 1 }, now7)
check('累计 100000 后再转 1 分为红色', op7b.risk_level === 'red' && op7b.status === 'needs_verification', `risk=${op7b.risk_level}`)
const b7 = acct().b
check('红色普通确认被拒绝为 needs_verification', confirmTransfer(db, userId, op7b.ref_no, now7).outcome === 'needs_verification')
check('红色确认不扣款', acct().b === b7)

const now8 = shDate(2026, 10, 8)
const now9 = shDate(2026, 10, 9)
const op8 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now8)
confirmTransfer(db, userId, op8.ref_no, now8)
const op9 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now9)
check('上海跨日后累计重置为黄色', op9.risk_level === 'yellow', `risk=${op9.risk_level}`)
cancelTransfer(db, userId, op9.ref_no, now9)

console.log('—— 创建后另有转账，确认时重新判累计 ——')
const now10 = shDate(2026, 10, 10)
const opA = createTransfer(db, userId, { recipientId: 1, amountCents: 60000 }, now10)
const opB = createTransfer(db, userId, { recipientId: 2, amountCents: 60000 }, now10)
confirmTransfer(db, userId, opB.ref_no, now10)
const b10 = acct().b
const rA = confirmTransfer(db, userId, opA.ref_no, now10)
check('确认时累计已过线转为 needs_verification', rA.outcome === 'needs_verification')
check('转红不扣款', acct().b === b10)

console.log('—— 归属与篡改 ——')
const now11 = shDate(2026, 10, 11)
const b11 = acct().b
const opX = createTransfer(db, userId, { recipientId: 1, amountCents: 1000 }, now11)
check('他人确认返回 not_found', confirmTransfer(db, 999999, opX.ref_no, now11).outcome === 'not_found')
check('他人取消返回 not_found', cancelTransfer(db, 999999, opX.ref_no, now11).outcome === 'not_found')
check('他人查看返回 null', getTransfer(db, 999999, opX.ref_no, now11) === null)
check('归属校验不改变余额', acct().b === b11)
check('他人操作后状态仍待确认', getTransfer(db, userId, opX.ref_no, now11).status === 'pending')
cancelTransfer(db, userId, opX.ref_no, now11)

console.log('—— HTTP 路由层：字段校验 / 红色阻断 / 端到端确认 ——')
async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(db, userId))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

await withServer(async (base) => {
  const rr = await fetch(`${base}/transfers/recipients`)
  const rrb = await rr.json()
  check('GET /recipients 返回 4 个收款人', rr.ok && rrb.success && rrb.data.length === 4)

  const extra = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 100, remark: 'x', hacked: true })
  check('创建带非法字段返回 400', extra.status === 400)
  const badAmt = await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 1.5 })
  check('创建小数金额返回 400', badAmt.status === 400)

  const cb = await (await postJson(`${base}/transfers`, { recipient_id: 1, amount_cents: 100, remark: 'http 测试', from_account_id: acct().id })).json()
  check('HTTP 创建黄色转账单', cb.success && cb.data.status === 'pending')
  const refNo = cb.data.ref_no

  const tamper = await postJson(`${base}/transfers/${refNo}/confirm`, { confirm: true, amount_cents: 1 })
  check('确认携带金额篡改字段返回 400', tamper.status === 400)
  const noConfirm = await postJson(`${base}/transfers/${refNo}/confirm`, {})
  check('确认缺少 confirm 返回 400', noConfirm.status === 400)

  // 直接落一条红色操作，验证普通确认入口无法绕过
  const redRef = 'red-' + Date.now()
  db.prepare(
    `INSERT INTO transfer_operations
      (ref_no, user_id, from_account_id, from_account_name, recipient_id, recipient_name, recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(redRef, userId, acct().id, acct().name, 1, '李雷', '6217 **** **** 8801', 100, 'red', 'needs_verification', 'red', new Date().toISOString(), new Date(Date.now() + 300000).toISOString())
  const redC = await postJson(`${base}/transfers/${redRef}/confirm`, { confirm: true })
  check('红色操作普通确认返回 409', redC.status === 409)
  const redBody = await redC.json()
  check('红色 409 提示强验证', /强验证/.test(redBody.message))

  const beforeHttp = acct().b
  const okb = await (await postJson(`${base}/transfers/${refNo}/confirm`, { confirm: true })).json()
  check('HTTP 黄色确认成功返回回执', okb.success && okb.data.status === 'completed' && okb.data.transaction_id)
  check('HTTP 确认后扣款', acct().b === beforeHttp - 100)
})

console.log('—— 转账后余额与流水核算一致 ——')
const accRow = db.prepare('SELECT opening_balance_cents AS o, balance_cents AS b FROM accounts WHERE user_id = ?').get(userId)
const rows = db.prepare("SELECT direction AS d, SUM(amount_cents) AS s FROM transactions WHERE user_id = ? AND status = 'posted' GROUP BY direction").all(userId)
let inc = 0
let exp = 0
for (const r of rows) {
  if (r.d === 'income') inc = r.s
  else exp = r.s
}
check('余额 = 期初 + 已入账收入 - 已入账支出（含转账）', accRow.b === accRow.o + inc - exp, `期望 ${accRow.o + inc - exp} 实际 ${accRow.b}`)

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
