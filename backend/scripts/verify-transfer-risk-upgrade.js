// 定向验证：转账确认时「当日累计越过 ¥1000」的风险升级。
//
// 覆盖：两张 600 元黄色单，第一张确认后第二张普通确认返回 needs_verification + risk_level='red'，
//       余额 / 流水不变；GET 与助手工具读取同一权威 red；强验证后只扣一次且保持 red；重复确认幂等；
//       恰好 1000 元黄色、1000.01 元红色；两个付款账户合并累计；上海跨日边界重置；
//       风险升级审计只记业务元数据。
// 独立临时库、mock 模型，不触达外部模型。用法：node scripts/verify-transfer-risk-upgrade.js
import { initDatabase } from '../src/db/index.js'
import { createTransfer, confirmTransfer, getTransfer } from '../src/services/transfers.js'
import { bindVerification, verifyAndConfirmTransfer } from '../src/services/verification.js'
import { createAssistant } from '../src/services/assistant.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-risk-upgrade.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'Risk-Upgrade-Pass'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const pay1 = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
   VALUES (?, '活期账户 A', 10000000, 10000000, 'CNY', 'deposit', 'active', '2026-08-01')`,
).run(u1).lastInsertRowid
const pay2 = db.prepare(
  `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
   VALUES (?, '活期账户 B', 10000000, 10000000, 'CNY', 'deposit', 'active', '2026-08-01')`,
).run(u1).lastInsertRowid
const r1 = db.prepare("INSERT INTO transfer_recipients (name, masked_account) VALUES ('李雷', '6217 **** **** 8801')").run().lastInsertRowid
bindVerification(db, u1, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })

const bal = (id) => db.prepare('SELECT balance_cents b FROM accounts WHERE id = ?').get(id).b
const txCount = () => db.prepare('SELECT COUNT(*) c FROM transactions').get().c
const row = (ref) => db.prepare('SELECT * FROM transfer_operations WHERE ref_no = ?').get(ref)
const at = (iso) => new Date(iso)
function create(amount, account, iso) {
  return createTransfer(db, u1, { recipientId: r1, amountCents: amount, fromAccountId: account }, at(iso))
}
let stepOffset = 1
function strongVerify(ref, iso) {
  const now = at(iso)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  return verifyAndConfirmTransfer(db, u1, ref, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now })
}

console.log('—— 两张 600 元黄色单：第二张确认时升级 ——')
{
  // 使用“当前时间 + 10 分钟”作为合成时间，避免 GET / 助手工具按真实时间判为过期；同一场景内时间一致
  const iso = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const op1 = create(60000, pay1, iso)
  const op2 = create(60000, pay2, iso)
  check('两张单建单时均为黄色待确认', op1.status === 'pending' && op1.risk_level === 'yellow' && op2.status === 'pending' && op2.risk_level === 'yellow')
  const bal0 = bal(pay1)
  const tx0 = txCount()
  check('第一张普通确认成功', confirmTransfer(db, u1, op1.ref_no, at(iso)).outcome === 'completed')
  check('第一张扣款一次', bal(pay1) === bal0 - 60000 && txCount() === tx0 + 1)
  const bal1 = bal(pay2)
  const tx1 = txCount()
  const conf2 = confirmTransfer(db, u1, op2.ref_no, at(iso))
  check('第二张普通确认升级为 needs_verification', conf2.outcome === 'needs_verification', conf2.outcome)
  check('返回视图 risk_level = red', conf2.op.risk_level === 'red', conf2.op.risk_level)
  check('数据库行同为 red / needs_verification', row(op2.ref_no).risk_level === 'red' && row(op2.ref_no).status === 'needs_verification')
  check('升级时余额 / 流水不变', bal(pay2) === bal1 && txCount() === tx1, `${bal1}→${bal(pay2)}`)
  const got = getTransfer(db, u1, op2.ref_no)
  check('再次 GET 仍为 red / needs_verification', got.risk_level === 'red' && got.status === 'needs_verification')

  const audits = db.prepare("SELECT detail FROM audit_logs WHERE operation_type='transfer' AND operation_ref=? AND action='risk_upgrade'").all(op2.ref_no)
  check('风险升级审计仅 1 条', audits.length === 1, String(audits.length))
  const detail = audits.length ? JSON.parse(audits[0].detail) : {}
  check('审计只含业务元数据（金额 / 累计 / 阈值）',
    Object.keys(detail).sort().join(',') === 'amount_cents,limit_cents,today_completed_cents' &&
    !JSON.stringify(detail).match(/password|totp|code|密钥/i), JSON.stringify(detail))

  // 助手工具读取同一权威字段
  let captured = null
  const mock = async ({ messages }) => {
    captured = messages
    if (!mock.done) {
      mock.done = true
      return {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'get_transfer_status', arguments: JSON.stringify({ ref_no: op2.ref_no }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    }
    return { content: '该转账需要强验证。', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: mock })
  const res = await assistant.chat({ message: '那笔转账状态如何' })
  const tool = res.toolRecords[0]
  check('助手 get_transfer_status 返回 risk_level=red', tool.status === 'ok' && tool.data.risk_level === 'red' && tool.data.status === 'needs_verification', tool.error || JSON.stringify({ r: tool.data?.risk_level, s: tool.data?.status }))

  // 强验证后只扣一次且保持 red
  const ver = strongVerify(op2.ref_no, new Date(Date.parse(iso) + 60000).toISOString())
  check('强验证后完成', ver.outcome === 'completed', ver.outcome)
  check('强验证只扣一次', bal(pay2) === bal1 - 60000 && txCount() === tx1 + 1, `${bal1}→${bal(pay2)}`)
  check('完成后 risk_level 仍为 red', row(op2.ref_no).risk_level === 'red' && ver.op.risk_level === 'red')
  const dup = strongVerify(op2.ref_no, new Date(Date.parse(iso) + 120000).toISOString())
  check('重复强验证幂等（不重复扣款）', dup.outcome === 'completed' && bal(pay2) === bal1 - 60000 && txCount() === tx1 + 1)
}

console.log('—— 阈值边界：恰好 1000 黄色 / 1000.01 红色 ——')
{
  const op1000 = create(100000, pay1, '2026-10-11T02:00:00Z')
  check('恰好 1000 元建单为黄色待确认', op1000.risk_level === 'yellow' && op1000.status === 'pending')
  check('恰好 1000 元普通确认成功', confirmTransfer(db, u1, op1000.ref_no, at('2026-10-11T02:00:00Z')).outcome === 'completed')
  const op1001 = create(100001, pay1, '2026-10-12T02:00:00Z')
  check('1000.01 元建单即为红色强验证', op1001.risk_level === 'red' && op1001.status === 'needs_verification')
}

console.log('—— 两个付款账户合并累计 ——')
{
  const iso = '2026-10-13T02:00:00Z'
  const a = create(60000, pay1, iso)
  const b = create(60000, pay2, iso)
  check('第一张（付款账户 A）成功', confirmTransfer(db, u1, a.ref_no, at(iso)).outcome === 'completed')
  const b0 = bal(pay2)
  const t0 = txCount()
  const rb = confirmTransfer(db, u1, b.ref_no, at(iso))
  check('另一付款账户的第二张仍按合计升级', rb.outcome === 'needs_verification' && row(b.ref_no).risk_level === 'red', rb.outcome)
  check('升级不扣款 / 不写流水', bal(pay2) === b0 && txCount() === t0)
}

console.log('—— 上海跨日边界 ——')
{
  // 上海 2026-10-14 23:59（UTC 15:59）成功一笔 600 元
  const late = create(60000, pay1, '2026-10-14T15:59:00Z')
  check('跨日前最后一笔成功', confirmTransfer(db, u1, late.ref_no, at('2026-10-14T15:59:00Z')).outcome === 'completed')
  // 上海次日 00:01（UTC 16:01）再建 600 元 → 新自然日累计为 0
  const next = create(60000, pay1, '2026-10-14T16:01:00Z')
  check('次日新建为黄色', next.risk_level === 'yellow' && next.status === 'pending', next.risk_level)
  const r = confirmTransfer(db, u1, next.ref_no, at('2026-10-14T16:01:00Z'))
  check('次日普通确认成功（跨日重置累计）', r.outcome === 'completed' && row(next.ref_no).risk_level === 'yellow', r.outcome)
}

const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('integrity_check = ok', ic.length === 1 && ic[0].integrity_check === 'ok')
check('foreign_key_check 无违例', fk.length === 0)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n转账风险升级定向验证全部通过 ✅（独立临时库 + mock）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
