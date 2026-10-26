// 四类操作单权威回执验证：卡操作 / 订阅操作在模型生成期间被界面确认时，
// 助手回复必须用服务端最新状态替换模型草稿，并持久化同一内容。
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { createCardOperation, confirmCardOperation } from '../src/services/card-operations.js'
import { createSubscriptionOperation, confirmSubscriptionOperation } from '../src/services/subscription-operations.js'

const DB_PATH = join(tmpdir(), 'rongzhi-receipts-test.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const db = openDatabase(DB_PATH)
createSchema(db)
migrate(db)
const now = new Date().toISOString()
const userId = Number(db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid)
const acctId = Number(db.prepare(
  "INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status) VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active')",
).run(userId, '活期账户', 100000, 100000).lastInsertRowid)
const cardId = Number(db.prepare(
  "INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, version) VALUES (?, ?, ?, '借记卡', 'active', 100000, '2026-01-01', 1)",
).run(userId, acctId, '6222 **** **** 0001').lastInsertRowid)
const subId = Number(db.prepare(
  "INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, version) VALUES (?, ?, '测试会员', 1500, 'monthly', '2026-11-01', 'active', 1)",
).run(userId, acctId).lastInsertRowid)

function makeSession(id, pendingCard, pendingSub) {
  db.prepare(
    `INSERT INTO chat_sessions (id, user_id, messages_json, pending_card_op_ref, pending_subscription_op_ref, created_at, last_active_at)
     VALUES (?, ?, '[]', ?, ?, ?, ?)`,
  ).run(id, userId, pendingCard || null, pendingSub || null, Date.now(), Date.now())
}
function chatFnThatConfirms(onConfirm, finalText) {
  const calls = []
  const fn = async ({ messages }) => {
    calls.push(JSON.parse(JSON.stringify(messages)))
    if (calls.length === 1) {
      onConfirm()
      return { content: finalText, toolCalls: [], usage: { total_tokens: 1 } }
    }
    return { content: '（不应再次调用）', toolCalls: [], usage: { total_tokens: 1 } }
  }
  fn.calls = calls
  return fn
}

try {
  // 卡操作：模型生成期间外部确认冻结单
  const cardOp = createCardOperation(db, userId, { cardId, action: 'freeze' })
  makeSession('sess-card', cardOp.ref_no, null)
  const cardMock = chatFnThatConfirms(() => confirmCardOperation(db, userId, cardOp.ref_no), '该卡仍待确认，请继续点击确认')
  const cardAssistant = createAssistant({ db, demoUserId: userId, chatFn: cardMock })
  const cardRes = await cardAssistant.chat({ message: '这张卡冻结了吗？', sessionId: 'sess-card' })
  const cardSystem = cardMock.calls[0].find((m) => m.role === 'system')?.content || ''
  check('卡操作：系统提示注入权威回执', /权威回执·最近银行卡操作/.test(cardSystem))
  check('卡操作：模型草稿被服务端完成状态替换', /冻结操作已完成/.test(cardRes.reply) && !/待确认/.test(cardRes.reply), cardRes.reply)
  const cardVisible = db.prepare("SELECT text FROM chat_messages WHERE session_id='sess-card' AND role='assistant' ORDER BY id DESC LIMIT 1").get()
  check('卡操作：持久化回复与返回内容一致', cardVisible && cardVisible.text === cardRes.reply)

  // 订阅操作：模型生成期间外部确认暂停单
  const subOp = createSubscriptionOperation(db, userId, { subscriptionId: subId, action: 'pause' })
  makeSession('sess-sub', null, subOp.ref_no)
  const subMock = chatFnThatConfirms(() => confirmSubscriptionOperation(db, userId, subOp.ref_no), '该订阅仍待确认')
  const subAssistant = createAssistant({ db, demoUserId: userId, chatFn: subMock })
  const subRes = await subAssistant.chat({ message: '订阅暂停了吗？', sessionId: 'sess-sub' })
  const subSystem = subMock.calls[0].find((m) => m.role === 'system')?.content || ''
  check('订阅操作：系统提示注入权威回执', /权威回执·最近订阅操作/.test(subSystem))
  check('订阅操作：模型草稿被服务端完成状态替换', /订阅暂停操作已完成/.test(subRes.reply) && !/待确认/.test(subRes.reply), subRes.reply)
  const subVisible = db.prepare("SELECT text FROM chat_messages WHERE session_id='sess-sub' AND role='assistant' ORDER BY id DESC LIMIT 1").get()
  check('订阅操作：持久化回复与返回内容一致', subVisible && subVisible.text === subRes.reply)
} catch (e) {
  failures += 1
  console.error('RECEIPT TEST ERROR:', e.stack || e.message)
} finally {
  db.close()
  console.log(`\n== 四类权威回执验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
