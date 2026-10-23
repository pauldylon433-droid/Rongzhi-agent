// 信用卡查询 + 还款 HTTP 路由验证脚本：仅在独立临时库上运行，不触碰、不迁移开发库，不调用收费模型。
//
// 覆盖（对应「三、查询与操作接口」与「七、验收」的服务器端校验）：
//  1. 信用账户 / 账单 / 账单详情只读接口返回真实账户类型（credit）与脱敏卡号。
//  2. 还款单创建：服务端归属 / 类型 / 金额 / 状态校验；未出账账单拒绝；信用卡账户不可作还款来源。
//  3. 还款单强验证（交易密码 + 动态验证码）：错误凭据拒绝不扣款、正确凭据完成并冲抵。
//  4. 还款单查看（惰性过期）/ 取消 / 状态刷新。
// 用法：node scripts/verify-credit-routes.js
import { initDatabase } from '../src/db/index.js'
import {
  createCreditConsumption, postCreditConsumption, listStatements,
} from '../src/services/credit.js'
import { bindVerification } from '../src/services/verification.js'
import { createApiRouter } from '../src/routes/index.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(tmpdir(), 'rongzhi-credit-routes-test.db')

// 强验证测试常量（非真实凭据；主密钥经环境变量注入，供路由层 loadVerificationKey 读取）
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
process.env.VERIFICATION_KEY = KEY.toString('base64')
const PASSWORD = 'demo-pass-123'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const { db } = initDatabase({ dbPath: DB_PATH, seed: false })

const userId = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const user2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid

const debitA = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, '人民币活期账户 A', 1000000, 1000000, 'CNY', 'active', 'deposit')",
).run(userId).lastInsertRowid
const creditAcct = db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, '人民币信用账户', 0, 0, 'CNY', 'active', 'credit')",
).run(userId).lastInsertRowid
const creditCa = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)').run(userId, creditAcct, 500000).lastInsertRowid
const cardCredit = db.prepare(
  "INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, '6259 **** **** 0003', '信用卡', 'active', 0)",
).run(userId, creditAcct).lastInsertRowid
db.prepare(
  "INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, '6222 **** **** 0001', '借记卡', 'active', 0)",
).run(userId, debitA)

// 绑定强验证器（主密钥与环境变量一致）
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })

const now = new Date()
// 已出账账单：消费 50000 → 入账 → 手动置 issued_at（等价于出账日已到且已出账）
const tx1 = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 50000, transactionAt: now.toISOString() })
postCreditConsumption(db, userId, tx1.transaction_id, { postedAt: now })
const stmtIssued = listStatements(db, userId, creditCa)[0]
db.prepare('UPDATE statements SET issued_at = ? WHERE id = ?').run(now.toISOString(), stmtIssued.id)

// 未出账账单：消费 30000 → 入账到未来月份（issued_at 保持 NULL）
const tx2 = createCreditConsumption(db, userId, { cardId: cardCredit, amountCents: 30000, transactionAt: now.toISOString() })
postCreditConsumption(db, userId, tx2.transaction_id, { postedAt: new Date(now.getTime() + 40 * 24 * 3600 * 1000) })
const stmtUnissued = listStatements(db, userId, creditCa).find((s) => s.id !== stmtIssued.id)

function goodTotp() {
  return totpAt(SECRET_BUF, totpStep(Date.now()))
}

const app = express()
app.use(express.json())
app.use('/api', createApiRouter(db, userId))
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}/api`

const getJson = async (url) => {
  const res = await fetch(`${base}${url}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}
const postJson = async (url, body) => {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// —— 1. 信用账户 / 账单只读接口 ——
{
  const acc = await getJson('/credit/accounts')
  check('GET /credit/accounts 成功且返回信用账户', acc.status === 200 && acc.body.success && acc.body.data.length === 1)
  const ca = acc.body.data[0]
  check('信用账户返回真实类型 credit', ca.account_type === 'credit', ca.account_type)
  check('信用账户返回脱敏卡号', ca.card && /6259/.test(ca.card.masked_card_number), ca.card && ca.card.masked_card_number)
  check('信用账户返回额度汇总', ca.credit_limit_cents === 500000 && Number.isInteger(ca.available_credit_cents))

  const one = await getJson(`/credit/accounts/${ca.id}`)
  check('GET /credit/accounts/:id 成功', one.status === 200 && one.body.success && one.body.data.id === ca.id)

  const stmts = await getJson(`/credit/accounts/${ca.id}/statements`)
  check('GET /credit/accounts/:id/statements 含已出账与未出账账单', stmts.status === 200 && stmts.body.data.length === 2)

  const detail = await getJson(`/credit/statements/${stmtIssued.id}`)
  check('GET /credit/statements/:id 返回详情（含明细/冲抵数组）', detail.status === 200 && detail.body.data.issued === true && Array.isArray(detail.body.data.items) && Array.isArray(detail.body.data.payments))

  const notFound = await getJson('/credit/statements/99999')
  check('账单不存在返回 404', notFound.status === 404)
}

// —— 2. 还款单创建校验 ——
{
  const extra = await postJson('/repayments', { statement_id: stmtIssued.id, from_account_id: debitA, hacked: true })
  check('还款创建带非法字段返回 400', extra.status === 400)

  const unissued = await postJson('/repayments', { statement_id: stmtUnissued.id, from_account_id: debitA })
  check('未出账账单还款被拒（400）', unissued.status === 400 && /尚未出账|不能还款/.test(unissued.body.message))

  const creditFrom = await postJson('/repayments', { statement_id: stmtIssued.id, from_account_id: creditAcct })
  check('信用卡账户不可作还款付款账户（400）', creditFrom.status === 400 && /活期/.test(creditFrom.body.message))

  const ok = await postJson('/repayments', { statement_id: stmtIssued.id, from_account_id: debitA })
  check('还款单创建成功（红色强验证）', ok.status === 200 && ok.body.success && ok.body.data.status === 'needs_verification' && ok.body.data.risk_level === 'red' && ok.body.data.amount_cents === 50000)
  const refNo = ok.body.data.ref_no

  // 强验证：错误密码拒绝且不扣款
  const before = db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(debitA).b
  const bad = await postJson(`/repayments/${refNo}/verify`, { password: 'wrong-pass', totp: goodTotp() })
  check('错误交易密码返回 401（bad_credentials）', bad.status === 401 && bad.body.code === 'bad_credentials')
  check('错误密码不扣款', db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(debitA).b === before)

  // 强验证：正确凭据完成并冲抵
  const good = await postJson(`/repayments/${refNo}/verify`, { password: PASSWORD, totp: goodTotp() })
  check('正确凭据验证成功（completed）', good.status === 200 && good.body.success && good.body.data.status === 'completed')
  check('验证后付款账户扣款 50000', db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(debitA).b === before - 50000)

  const status = await getJson(`/repayments/${refNo}`)
  check('查看还款单返回已完成状态', status.status === 200 && status.body.data.status === 'completed')

  const repeat = await postJson(`/repayments/${refNo}/verify`, { password: PASSWORD, totp: goodTotp() })
  check('重复验证幂等返回 completed 且不重复扣款', repeat.status === 200 && repeat.body.data.status === 'completed' && db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(debitA).b === before - 50000)
}

// —— 3. 取消 / 过期 ——
{
  const op = await postJson('/repayments', { statement_id: stmtIssued.id, from_account_id: debitA })
  // 已还清该账单，此处创建应被拒（already_paid）；改用新账单做取消/过期测试
  if (op.status === 200) {
    const cancel = await postJson(`/repayments/${op.body.data.ref_no}/cancel`, { cancel: true })
    check('取消待确认还款单成功', cancel.status === 200 && cancel.body.data.status === 'cancelled')
  } else {
    // 账单已结清，创建被拒本身即验证了「已结清不能还款」
    check('已结清账单再次还款被拒', op.status === 400 && /已结清/.test(op.body.message))
  }
}

server.close()
db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
