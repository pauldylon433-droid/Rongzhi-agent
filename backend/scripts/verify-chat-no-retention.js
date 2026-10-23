// 定向验证：聊天历史“不按闲置时长自动删除”。
//
// 覆盖：A/B 两个用户分别有 8 天 / 30 天未活跃会话；读取当前对话、历史列表、新建会话、打开旧会话后，
//       两侧会话与消息内容均不变；只有显式导航更新当前指针；重建 assistant 实例仍可读取旧消息；
//       后续聊天在模型上下文中包含保留窗口内的既有内容；纯列表 / 打开不调用模型；
//       8 轮裁剪与工具消息配对保持完整。
// 独立临时库、mock 模型，不触达外部模型。用法：node scripts/verify-chat-no-retention.js
import { initDatabase } from '../src/db/index.js'
import { createAssistant } from '../src/services/assistant.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const DB_PATH = join(tmpdir(), 'rongzhi-verify-no-retention.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function mock() {
  const state = { calls: 0, captured: [] }
  const fn = async ({ messages }) => {
    state.calls += 1
    state.captured.push(JSON.parse(JSON.stringify(messages)))
    return { content: '好的。', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  return { fn, state }
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: false })
const uA = db.prepare("INSERT INTO users (name) VALUES ('用户A')").run().lastInsertRowid
const uB = db.prepare("INSERT INTO users (name) VALUES ('用户B')").run().lastInsertRowid
const DAY = 24 * 3600 * 1000
const now = Date.now()

function insertSession(uid, id, daysAgo, rounds) {
  const messages = []
  for (const [q, a] of rounds) {
    messages.push({ role: 'user', content: q }, { role: 'assistant', content: a })
  }
  const last = now - daysAgo * DAY
  db.prepare(
    'INSERT INTO chat_sessions (id, user_id, messages_json, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, uid, JSON.stringify(messages), last, last)
  let seq = 0
  for (const m of messages) {
    seq += 1
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, seq, role, text, tool_records_json, incomplete, error, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)`,
    ).run(id, uid, seq, m.role, m.content, last)
  }
  return messages
}

const oldA = 'sess-a-8d'
const oldB = 'sess-b-30d'
insertSession(uA, oldA, 8, [['A 的旧问题：我的余额是多少', 'A 的旧回答']])
insertSession(uB, oldB, 30, [['B 的旧问题：我的银行卡', 'B 的旧回答']])
db.prepare('INSERT INTO chat_state (user_id, current_session_id) VALUES (?, ?)').run(uA, oldA)

const snapSessions = () => JSON.stringify(db.prepare('SELECT id, user_id, messages_json, created_at, last_active_at FROM chat_sessions ORDER BY id').all())
const snapMessages = () => JSON.stringify(db.prepare('SELECT id, session_id, user_id, seq, role, text FROM chat_messages ORDER BY id').all())
const beforeSessions = snapSessions()
const beforeMessages = snapMessages()
const callsOf = (assistant) => assistant._mockState.calls

function makeAssistant(uid) {
  const m = mock()
  const a = createAssistant({ db, demoUserId: uid, chatFn: m.fn })
  a._mockState = m.state
  return a
}

console.log('—— 读取 / 列表 / 新建 / 打开：不删历史、不调用模型 ——')
{
  const a = makeAssistant(uA)
  const cur = a.getCurrent()
  check('getCurrent 读取 8 天前会话', cur.sessionId === oldA && cur.messages.length === 2, JSON.stringify(cur.sessionId))
  const list = a.listConversations()
  check('历史列表包含 8 天前会话', list.some((s) => s.id === oldA), JSON.stringify(list.map((s) => s.id)))
  check('历史列表不含他人会话', !list.some((s) => s.id === oldB))
  check('列表标题 / 消息数正确', list.find((s) => s.id === oldA).title.includes('A 的旧问题') && list.find((s) => s.id === oldA).messageCount === 2)

  a.newConversation()
  check('新建会话只清除当前指针', db.prepare('SELECT COUNT(*) c FROM chat_state WHERE user_id = ?').get(uA).c === 0)
  const opened = a.getConversation(oldA)
  check('打开旧会话返回原消息并显式更新指针', opened.sessionId === oldA && opened.messages.length === 2 &&
    db.prepare('SELECT current_session_id c FROM chat_state WHERE user_id = ?').get(uA).c === oldA)
  check('上述操作未调用模型', callsOf(a) === 0, String(callsOf(a)))
  check('A / B 会话内容均未改变', snapSessions() === beforeSessions && snapMessages() === beforeMessages)
}

console.log('—— 重建实例仍可读取；30 天未活跃的 B 会话仍在 ——')
{
  const a2 = makeAssistant(uA)
  const cur = a2.getCurrent()
  check('重建实例后读取旧消息', cur.sessionId === oldA && cur.messages[0].text.includes('A 的旧问题'))
  check('B 的 30 天会话仍可被其本人打开', makeAssistant(uB).getConversation(oldB).messages.length === 2)
  check('读取不调用模型', callsOf(a2) === 0)
}

console.log('—— 后续聊天：上下文包含保留窗口内的既有内容 ——')
{
  const a = makeAssistant(uA)
  const r = await a.chat({ message: '继续问', sessionId: oldA })
  check('聊天成功且调用模型 1 次', r.sessionId === oldA && callsOf(a) === 1, String(callsOf(a)))
  const sent = JSON.stringify(a._mockState.captured[0])
  check('模型上下文包含旧会话内容', sent.includes('A 的旧问题') && sent.includes('A 的旧回答'))
  // 会话持久化仍保留旧消息（新增 2 条可见消息）
  check('聊天后旧消息仍在', db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE session_id = ? AND text LIKE '%A 的旧问题%'").get(oldA).c === 1)
}

console.log('—— 8 轮窗口与工具配对 ——')
{
  const sid = 'sess-trim'
  const rounds = []
  for (let i = 1; i <= 10; i += 1) rounds.push([`第${i}轮问题`, `第${i}轮回答`])
  const messages = []
  for (const [q, a] of rounds) messages.push({ role: 'user', content: q }, { role: 'assistant', content: a })
  // 在最后一轮插入工具调用 / 结果配对
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_accounts', arguments: '{}' } }],
  })
  messages.push({ role: 'tool', tool_call_id: 'call_x', content: '{"ok":true}' })
  messages.push({ role: 'assistant', content: '（工具结果已处理）' })
  const last = now - 3600 * 1000
  db.prepare('INSERT INTO chat_sessions (id, user_id, messages_json, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
    .run(sid, uA, JSON.stringify(messages), last, last)

  const a = makeAssistant(uA)
  await a.chat({ message: '现在的问题', sessionId: sid })
  const sent = a._mockState.captured[0]
  const userMsgs = sent.filter((m) => m.role === 'user')
  check('模型上下文仅保留最近 8 轮 + 本轮问题', userMsgs.length === 9, String(userMsgs.length))
  check('裁剪从第 3 轮开始（最近 8 轮）', userMsgs[0].content === '第3轮问题' && userMsgs[7].content === '第10轮问题', userMsgs[0].content)
  const toolCall = sent.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === 'call_x'))
  const toolResult = sent.find((m) => m.role === 'tool' && m.tool_call_id === 'call_x')
  check('工具调用与结果配对完整保留', !!toolCall && !!toolResult)
  const idxCall = sent.indexOf(toolCall)
  const idxResult = sent.indexOf(toolResult)
  check('工具结果紧随调用消息之后', idxResult === idxCall + 1, `${idxCall}/${idxResult}`)
}

console.log('—— 仅列表 / 打开不调用模型（用户 B）——')
{
  const b = makeAssistant(uB)
  b.getCurrent()
  b.listConversations()
  b.getConversation(oldB)
  check('B 的列表 / 打开均不调用模型', callsOf(b) === 0, String(callsOf(b)))
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
console.log(failures === 0 ? '\n聊天历史不自动删除定向验证全部通过 ✅（独立临时库 + mock）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
