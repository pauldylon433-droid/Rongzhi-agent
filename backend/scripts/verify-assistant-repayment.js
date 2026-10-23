// AI 助手·信用卡还款工具 + 「切卡不改变付款账户」定向验证脚本。
// 使用「模拟模型响应 + 独立临时库」，不触碰开发库、不调用收费模型。
//
// 补齐以下关键验收证据（此前仅转账侧有覆盖，还款助手侧与「切卡不改变付款账户」无断言）：
//  R2-1 明确指定付款账户被采纳：prepare_repayment 带 from_account_id → 建单并冻结该账户；
//  R2-2 多付款账户未指定 → 澄清，不建单（歧义澄清）；
//  R2-3 信用卡账户不可作还款来源（还款侧「禁止对外转账」的对称约束）；
//  R2-4 未出账账单拒绝还款；
//  R3-1 页面切卡（selectedCardId 指向另一张卡）不改变付款账户：付款账户由建单时的明确指定决定，
//       与当前选中卡无关，且建单后读取、切换到另一张卡再读，付款账户仍冻结为原账户；
//  R3-0 get_credit_accounts 仅用选中卡做「看哪张信用卡」的过滤，不用来决定付款账户。
//
// 用法：node scripts/verify-assistant-repayment.js
import { initDatabase } from '../src/db/index.js'
import { createAssistant } from '../src/services/assistant.js'
import {
  createCreditConsumption, postCreditConsumption, listStatements, issueStatements,
  getRepaymentOperation,
} from '../src/services/credit.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-assistant-repayment-test.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function makeScriptedMock(script) {
  let i = 0
  const fn = async ({ messages }) => {
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }
  return fn
}
function chatOnce(script, message, selectedCardId) {
  const assistant = createAssistant({ db, demoUserId: u1, chatFn: makeScriptedMock(script) })
  return assistant.chat({ message, selectedCardId })
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
function shDate(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS)
}
function shIso(year, month, day, hour = 12, minute = 0) {
  return shDate(year, month, day, hour, minute).toISOString()
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
const { db } = initDatabase({ dbPath: DB_PATH, seed: false })

const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
db.prepare("INSERT INTO users (name) VALUES ('李四')").run()

function insertAccount(uid, name, type, balance) {
  return db.prepare(
    "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status, account_type) VALUES (?, ?, ?, ?, 'CNY', 'active', ?)",
  ).run(uid, name, balance, balance, type).lastInsertRowid
}
function insertCard(uid, accountId, masked, type) {
  return db.prepare(
    "INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, ?, ?, 'active', 0)",
  ).run(uid, accountId, masked, type).lastInsertRowid
}

// 两张借记卡各自独立活期账户 + 一张信用卡独立信用账户（全 CNY）
const debitA = insertAccount(u1, '活期账户 A', 'deposit', 1000000)
const debitB = insertAccount(u1, '活期账户 B', 'deposit', 300000)
const creditAcct = insertAccount(u1, '人民币信用账户', 'credit', 0)
const creditCa = db.prepare('INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents) VALUES (?, ?, ?)').run(u1, creditAcct, 500000).lastInsertRowid
const cardA = insertCard(u1, debitA, '6222 **** **** 0001', '借记卡')
const cardB = insertCard(u1, debitB, '6222 **** **** 0002', '借记卡')
const cardCredit = insertCard(u1, creditAcct, '6259 **** **** 0003', '信用卡')

function consumeAndPost(amount, month, postedDay = 20) {
  const [y, mo] = month.split('-').map(Number)
  const r = createCreditConsumption(db, u1, { cardId: cardCredit, amountCents: amount, category: '购物', merchant: '测试商户', transactionAt: shIso(y, mo, 15) })
  postCreditConsumption(db, u1, r.transaction_id, { postedAt: shDate(y, mo, postedDay) })
  return r.transaction_id
}
function stmtIdOf(month) {
  const s = listStatements(db, u1, creditCa).find((x) => x.statement_month === month)
  return s ? s.id : null
}
function opCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM repayment_operations').get().c
}

// 三个账期：8 月（已出账，用于「明确指定 + 切卡」）、9 月（已出账，用于「澄清 / 信用卡拒绝」）、10 月（未出账）
consumeAndPost(30000, '2026-08')
consumeAndPost(40000, '2026-09')
consumeAndPost(20000, '2026-10')
// 在 10 月 5 日出账：8 月（出账日 9/1）与 9 月（出账日 10/1）被冻结；10 月（出账日 11/1）保持未出账
issueStatements(db, u1, creditCa, shDate(2026, 10, 5))
const augId = stmtIdOf('2026-08')
const sepId = stmtIdOf('2026-09')
const octId = stmtIdOf('2026-10')
check('SETUP 8/9 月已出账、10 月未出账', !!augId && !!sepId && !!octId && db.prepare('SELECT issued_at FROM statements WHERE id = ?').get(octId).issued_at === null)

// —— R3-0. get_credit_accounts：选中卡只决定「看哪张信用卡」，不决定付款账户 ——
{
  const r = await chatOnce(
    [{ toolCalls: [tc('c1', 'get_credit_accounts', {})] }, { content: 'done' }],
    '查我的信用卡', cardCredit,
  )
  const rec = r.toolRecords.find((t) => t.name === 'get_credit_accounts')
  check('R3-0.1 选中信用卡 → 返回该卡信用账户', rec?.status === 'ok' && rec?.data?.account_id === creditAcct && rec?.data?.account_type === 'credit', JSON.stringify(rec?.data))

  const r2 = await chatOnce(
    [{ toolCalls: [tc('c1', 'get_credit_accounts', {})] }, { content: 'done' }],
    '查我的信用卡', cardA,
  )
  const rec2 = r2.toolRecords.find((t) => t.name === 'get_credit_accounts')
  check('R3-0.2 选中借记卡 → 提示不是信用卡', rec2?.status === 'error' && /不是信用卡/.test(rec2?.error || ''), rec2?.error)
}

// —— R2-1 + R3-1. 明确指定付款账户 + 切卡不改变付款账户 ——
{
  const before = opCount()
  // 前端当前选中卡 = cardB（对应活期账户 B），但用户明确说「用活期账户 A 还」→ 模型传 from_account_id=debitA
  const r = await chatOnce(
    [{ toolCalls: [tc('c1', 'prepare_repayment', { statement_id: augId, from_account_id: debitA })] }, { content: '已生成还款单' }],
    '用活期账户A还8月账单', cardB,
  )
  const rec = r.toolRecords.find((t) => t.name === 'prepare_repayment')
  check('R2-1.1 明确指定付款账户被采纳（from_account_id 精确为账户 A）', rec?.status === 'ok' && rec?.data?.from_account_id === debitA, JSON.stringify(rec?.data && { fa: rec.data.from_account_id }))
  check('R2-1.2 付款账户名快照冻结为「活期账户 A」', rec?.data?.from_account_name === '活期账户 A', rec?.data?.from_account_name)
  check('R2-1.3 还款单恒为红色强验证、待确认', rec?.data?.risk_level === 'red' && rec?.data?.status === 'needs_verification')
  check('R2-1.4 金额 = 8 月剩余应还 30000', rec?.data?.amount_cents === 30000, String(rec?.data?.amount_cents))
  const refNo = rec?.data?.ref_no
  check('R2-1.5 建单成功（新增 1 单）', opCount() === before + 1 && typeof refNo === 'string')

  // 切卡不改变付款账户：读取操作单，付款账户仍冻结为账户 A
  const op = getRepaymentOperation(db, u1, refNo)
  check('R3-1.1 建单后读取操作单付款账户 = 账户 A（冻结）', op?.from_account_id === debitA, String(op?.from_account_id))

  // 用户把选中卡切到另一张（cardA），再经助手读取同一张还款单，付款账户仍为账户 A
  const r3 = await chatOnce(
    [{ toolCalls: [tc('c1', 'get_repayment_status', { ref_no: refNo })] }, { content: 'done' }],
    '看下这张还款单', cardA,
  )
  const st = r3.toolRecords.find((t) => t.name === 'get_repayment_status')
  check('R3-1.2 切到另一张卡再读，付款账户仍为账户 A', st?.status === 'ok' && st?.data?.from_account_id === debitA, JSON.stringify(st?.data && { fa: st.data.from_account_id }))
}

// —— R2-2. 多付款账户未指定 → 澄清，不建单 ——
{
  const before = opCount()
  const r = await chatOnce(
    [{ toolCalls: [tc('c1', 'prepare_repayment', { statement_id: sepId })] }],
    '还9月账单',
  )
  const rec = r.toolRecords.find((t) => t.name === 'prepare_repayment')
  check('R2-2.1 多付款账户且未指定 → 澄清（不建单）', rec?.status === 'error' && /多个付款活期账户/.test(rec?.error || ''), rec?.error)
  check('R2-2.2 澄清时不新增操作单', opCount() === before, String(opCount()))
}

// —— R2-3. 信用卡账户不可作还款来源 ——
{
  const before = opCount()
  const r = await chatOnce(
    [{ toolCalls: [tc('c1', 'prepare_repayment', { statement_id: sepId, from_account_id: creditAcct })] }],
    '用信用卡还9月账单',
  )
  const rec = r.toolRecords.find((t) => t.name === 'prepare_repayment')
  check('R2-3.1 信用卡账户作还款来源被拒', rec?.status === 'error' && /不是活期账户|不可用/.test(rec?.error || ''), rec?.error)
  check('R2-3.2 拒绝时不新增操作单', opCount() === before, String(opCount()))
}

// —— R2-4. 未出账账单拒绝还款 ——
{
  const before = opCount()
  const r = await chatOnce(
    [{ toolCalls: [tc('c1', 'prepare_repayment', { statement_id: octId, from_account_id: debitA })] }],
    '还10月账单',
  )
  const rec = r.toolRecords.find((t) => t.name === 'prepare_repayment')
  check('R2-4.1 未出账账单拒绝还款', rec?.status === 'error' && /尚未出账/.test(rec?.error || ''), rec?.error)
  check('R2-4.2 拒绝时不新增操作单', opCount() === before, String(opCount()))
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
