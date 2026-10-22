// 聊天持久化验证脚本：使用「模拟模型 + 独立临时数据库」验证刷新恢复当前对话（本轮新增）。
// 覆盖（对应需求 9 场景）：
//  1. 两轮对话保存/恢复顺序与内容一致；
//  2. 有效会话重启后恢复合法模型上下文（含工具配对）；
//  3. 后端重启 + 过期（历史仍可查看、上下文重新开始）；
//  4. 工具调用与结果配对完整；伪造/越权历史被拒；
//  5. 新建对话切换服务端当前对话，旧对话不泄漏；
//  6. 恢复只读（不调用模型、不重发、不伪造中断请求）；
//  7. 历史操作卡保存真实操作引用，回读业务库最新状态；
//  8. 验证凭据不进入历史；
//  9. 存储/读取失败明确处理（不崩溃）。
// 不修改开发数据库，不调用真实模型。用法：node scripts/verify-chat-persistence.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { confirmTransfer, getTransfer } from '../src/services/transfers.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-chat-persist-test.db')
const CAP_DB_PATH = join(tmpdir(), 'rongzhi-chat-persist-cap.db')
const FAIL_DB_PATH = join(tmpdir(), 'rongzhi-chat-persist-fail.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

// 可脚本化模拟 chatFn（记录每次收到的 messages 深拷贝）
function makeScriptedMock(script) {
  let i = 0
  const calls = []
  const fn = async ({ messages }) => {
    calls.push({ index: i, messages: JSON.parse(JSON.stringify(messages)) })
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }
  fn.calls = calls
  return fn
}

function buildDb(path) {
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const db = openDatabase(path)
  createSchema(db)
  migrate(db) // 种子 4 个收款人
  const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
  const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
  db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u1, '人民币活期账户', 500000, 500000, 'CNY', 'active')
  db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u2, '李四测试账户', 999999, 999999, 'CNY', 'active')
  return { db, u1, u2 }
}

function msgCount(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(sessionId).c
}

// ================= 主库：场景 1-5、7、8 =================
const { db, u1, u2 } = buildDb(DB_PATH)
const demoUserId = u1

// ---------- 1. 两轮对话保存 / 恢复顺序与内容 ----------
{
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_accounts', {})] },
    { content: '您的账户余额为 5000.00 元。' },
    { content: '这是第二次回答。' },
  ])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const r1 = await assistant.chat({ message: '我的余额是多少？' })
  const r2 = await assistant.chat({ message: '再问一次', sessionId: r1.sessionId })

  const cur = assistant.getCurrent()
  check('1.1 当前会话标识等于最近会话', cur.sessionId === r1.sessionId && cur.sessionId === r2.sessionId)
  check('1.2 恢复 4 条消息（2 用户 + 2 助手）', cur.messages.length === 4, String(cur.messages.length))
  check('1.3 顺序与角色正确', cur.messages[0].role === 'user' && cur.messages[0].text === '我的余额是多少？' &&
    cur.messages[1].role === 'assistant' && cur.messages[1].text === '您的账户余额为 5000.00 元。' &&
    cur.messages[2].role === 'user' && cur.messages[2].text === '再问一次' &&
    cur.messages[3].role === 'assistant' && cur.messages[3].text === '这是第二次回答。')
  check('1.4 助手消息含工具展示记录', Array.isArray(cur.messages[1].toolRecords) && cur.messages[1].toolRecords[0]?.name === 'get_accounts')
  check('1.5 未过期', cur.expired === false)
}

// ---------- 2 + 3. 后端重启恢复合法上下文；过期后历史仍可查看 ----------
{
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_monthly_analytics', { month: '2026-10' })] },
    { content: '本月支出 5500 元。' },
    { toolCalls: [tc('c2', 'get_monthly_analytics', { month: '2026-09' })] },
    { content: '上月支出 1500 元。' },
  ])
  const assistantA = createAssistant({ db, demoUserId, chatFn: mock })
  const r1 = await assistantA.chat({ message: '这个月花了多少？' })

  // 模拟重启：新实例（内存会话清空），从库恢复
  const assistantB = createAssistant({ db, demoUserId, chatFn: mock })
  const cur = assistantB.getCurrent()
  check('2.1 重启后恢复当前对话', cur.sessionId === r1.sessionId && cur.messages.length === 2, String(cur.messages.length))

  // 重启后追问：应恢复合法模型上下文（含上一轮工具结果配对）
  const r2 = await assistantB.chat({ message: '上个月呢？', sessionId: r1.sessionId })
  const secondCall = mock.calls[1].messages
  const hasPriorUser = secondCall.some((m) => m.role === 'user' && m.content === '这个月花了多少？')
  const priorTool = secondCall.find((m) => m.role === 'tool' && m.tool_call_id === 'c1')
  check('2.2 重启后保留上一轮用户消息', hasPriorUser)
  check('2.3 重启后保留上一轮工具结果（配对完整）', !!priorTool && JSON.parse(priorTool.content).month === '2026-10')
  check('2.4 system 消息不持久化', secondCall.filter((m) => m.role === 'system').length === 1 && secondCall[0].role === 'system', '每次由服务端生成')

  // 过期：手动把 last_active_at 调到 31 分钟前
  db.prepare('UPDATE chat_sessions SET last_active_at = ? WHERE id = ?').run(Date.now() - 31 * 60 * 1000, r1.sessionId)
  // 新实例模拟再次重启，避免内存缓存
  const assistantC = createAssistant({ db, demoUserId, chatFn: mock })
  const curExpired = assistantC.getCurrent()
  check('3.1 过期会话历史仍可查看', curExpired.expired === true && curExpired.sessionId === r1.sessionId && curExpired.messages.length >= 2, JSON.stringify({ expired: curExpired.expired, n: curExpired.messages.length }))

  // 过期后发送：沿用同一 sessionId，但上下文重新开始（不假装记得）
  const mockFresh = makeScriptedMock([{ content: '全新回答' }])
  const assistantD = createAssistant({ db, demoUserId, chatFn: mockFresh })
  const r3 = await assistantD.chat({ message: '新消息', sessionId: r1.sessionId })
  check('3.2 过期后沿用同一 sessionId（历史延续）', r3.sessionId === r1.sessionId)
  const freshCall = mockFresh.calls[0].messages
  const freshUsers = freshCall.filter((m) => m.role === 'user').map((m) => m.content)
  check('3.3 过期后上下文重新开始（不含旧用户消息）', freshUsers.length === 1 && freshUsers[0] === '新消息', JSON.stringify(freshUsers))
}

// ---------- 4. 工具调用与结果配对完整；越权被拒 ----------
{
  // 用转账工具制造 tool_calls / tool 消息，检查持久化的模型上下文结构
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'search_transfer_recipients', { name: '李雷' }), tc('c2', 'prepare_transfer', { recipient_id: 1, amount_yuan: '100' })] },
    { content: '已生成待确认转账单。' },
  ])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const r = await assistant.chat({ message: '给李雷转100元' })

  const row = db.prepare('SELECT messages_json FROM chat_sessions WHERE id = ? AND user_id = ?').get(r.sessionId, u1)
  const ctx = JSON.parse(row.messages_json)
  const hasToolCallsMsg = ctx.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 2)
  const toolMsgs = ctx.filter((m) => m.role === 'tool')
  const pairsComplete = toolMsgs.length === 2 && toolMsgs.every((m) => typeof m.tool_call_id === 'string')
  check('4.1 模型上下文保留完整 tool_calls', hasToolCallsMsg)
  check('4.2 tool 结果配对完整（按 tool_call_id）', pairsComplete, String(toolMsgs.length))
  check('4.3 模型上下文不含 system', !ctx.some((m) => m.role === 'system'))

  // 越权：另一用户（u2）不能加载 u1 的会话
  const assistantU2 = createAssistant({ db, demoUserId: u2, chatFn: makeScriptedMock([{ content: 'u2' }]) })
  const curU2 = assistantU2.getCurrent()
  check('4.4 他用户当前对话为空（会话按用户隔离）', curU2.sessionId === null && curU2.messages.length === 0)
  const rU2 = await assistantU2.chat({ message: 'hi', sessionId: r.sessionId }) // 传 u1 的 sessionId
  check('4.5 他用户用他人 sessionId 不加载他人上下文（新建会话）', rU2.sessionId !== r.sessionId)
}

// ---------- 5. 新建对话切换服务端当前对话，旧对话不泄漏 ----------
{
  const mock = makeScriptedMock([
    { content: '旧对话回答。' },
    { content: '新对话回答。' },
  ])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const rOld = await assistant.chat({ message: '旧对话' })
  const beforeNew = assistant.getCurrent()
  check('5.1 新建前当前对话含旧消息', beforeNew.sessionId === rOld.sessionId && beforeNew.messages.length === 2)

  assistant.newConversation()
  const afterNew = assistant.getCurrent()
  check('5.2 新建对话后当前对话为空', afterNew.sessionId === null && afterNew.messages.length === 0)

  const rNew = await assistant.chat({ message: '新对话' })
  const curNew = assistant.getCurrent()
  check('5.3 新对话成为当前，且不含旧对话内容', curNew.sessionId === rNew.sessionId && curNew.messages.length === 2 && !curNew.messages.some((m) => m.text === '旧对话'))
  check('5.4 旧对话历史未被删除（仍在库中，仅非当前）', msgCount(db, rOld.sessionId) === 2, String(msgCount(db, rOld.sessionId)))
}

// ---------- 6. 恢复只读：不调用模型、不重发、不伪造中断请求 ----------
{
  const modelCalled = { n: 0 }
  const assistant = createAssistant({
    db, demoUserId,
    chatFn: async () => { modelCalled.n += 1; return { content: 'x', toolCalls: [], usage: null } },
  })
  // 先造一段已持久化历史
  await assistant.chat({ message: '已有历史' })
  const before = modelCalled.n

  const cur = assistant.getCurrent()
  check('6.1 恢复（getCurrent）不调用模型', modelCalled.n === before, `${before}->${modelCalled.n}`)

  // 模型失败（模拟中断/失败）：该轮不持久化、不伪造为失败历史
  const failing = createAssistant({
    db, demoUserId,
    chatFn: async () => { throw new Error('模型挂了') },
  })
  let threw = false
  try {
    await failing.chat({ message: '这条会失败', sessionId: cur.sessionId })
  } catch { threw = true }
  check('6.2 模型失败抛错', threw === true)
  // 失败轮的用户消息不得出现在当前对话（不伪造）
  const afterFail = assistant.getCurrent()
  check('6.3 失败轮不伪造为历史', !afterFail.messages.some((m) => m.text === '这条会失败'))
}

// ---------- 7. 历史操作卡保存真实操作引用，回读业务库最新状态 ----------
{
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_transfer', { recipient_id: 1, amount_yuan: '100' })] },
    { content: '已生成待确认转账单。' },
  ])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const r = await assistant.chat({ message: '给李雷转100元' })
  const prep = r.toolRecords.find((t) => t.name === 'prepare_transfer')
  const refNo = prep.data.ref_no

  // 快照时为 pending；随后在业务库确认（状态变 completed）
  check('7.1 历史工具记录保存操作引用 ref_no', typeof refNo === 'string' && refNo.length > 0)
  const confirmRes = confirmTransfer(db, u1, refNo)
  check('7.2 业务库确认成功', confirmRes.outcome === 'completed', confirmRes.outcome)

  // 恢复的历史快照仍记录 pending（快照语义），但操作卡用 ref_no 回读业务库得到 completed
  const restored = assistant.getCurrent().messages[1].toolRecords[0]
  check('7.3 历史为快照（pending）', restored.data.status === 'pending', restored.data.status)
  check('7.4 用 ref_no 回读业务库得到最新状态（completed）', getTransfer(db, u1, refNo)?.status === 'completed')
}

// ---------- 8. 验证凭据不进入历史 ----------
{
  const row = db.prepare('SELECT messages_json FROM chat_sessions ORDER BY last_active_at DESC LIMIT 1').get()
  const msgs = db.prepare('SELECT text, tool_records_json, error FROM chat_messages').all()
  const allText = JSON.stringify(row) + JSON.stringify(msgs)
  const leaks = ['password', 'totp', 'secret', 'DEEPSEEK', 'apiKey', 'api_key', '验证码']
  const found = leaks.filter((k) => allText.toLowerCase().includes(k.toLowerCase()))
  check('8.1 持久化数据不含密码/密钥/验证码字段', found.length === 0, found.join(','))
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

// ================= 独立库：记录上限 + 保留期 =================
{
  const { db: capDb, u1: cu1 } = buildDb(CAP_DB_PATH)
  const mock = makeScriptedMock([{ content: 'ok' }])
  const assistant = createAssistant({ db: capDb, demoUserId: cu1, chatFn: mock })
  let sessionId = null
  for (let i = 0; i < 101; i++) {
    const r = await assistant.chat({ message: `消息${i}`, sessionId: sessionId || undefined })
    sessionId = r.sessionId
  }
  const cnt = msgCount(capDb, sessionId)
  check('9.1 单会话可见消息不超过上限（101 轮 → 202 条截断为 200）', cnt === 200, String(cnt))

  // 保留期：插入一条 8 天前的旧会话 + 消息，恢复时被懒清理
  const oldId = '00000000-0000-0000-0000-000000000001'
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000
  capDb.prepare("INSERT INTO chat_sessions (id, user_id, messages_json, created_at, last_active_at) VALUES (?, ?, '[]', ?, ?)").run(oldId, cu1, cutoff, cutoff)
  capDb.prepare("INSERT INTO chat_messages (session_id, user_id, seq, role, text, created_at) VALUES (?, ?, 1, 'user', '老消息', ?)").run(oldId, cu1, cutoff)
  const a2 = createAssistant({ db: capDb, demoUserId: cu1, chatFn: mock })
  a2.getCurrent() // 触发懒清理
  const oldRow = capDb.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(oldId)
  const oldMsgs = capDb.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(oldId).c
  check('9.2 超过保留期（7 天）的会话与其消息被清理', !oldRow && oldMsgs === 0)
  capDb.close()
  for (const p of [CAP_DB_PATH, CAP_DB_PATH + '-wal', CAP_DB_PATH + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
}

// ================= 独立库：存储 / 读取失败明确处理 =================
{
  const { db: failDb, u1: fu1 } = buildDb(FAIL_DB_PATH)
  const mock = makeScriptedMock([{ content: 'ok' }])
  const assistant = createAssistant({ db: failDb, demoUserId: fu1, chatFn: mock })
  const r = await assistant.chat({ message: '正常一条' })

  // 损坏模型上下文 JSON → chat 应安全回退为空上下文，不崩溃
  failDb.prepare('UPDATE chat_sessions SET messages_json = ? WHERE id = ?').run('{not valid json', r.sessionId)
  let crashed = false
  try {
    const r2 = await createAssistant({ db: failDb, demoUserId: fu1, chatFn: mock }).chat({ message: '再来', sessionId: r.sessionId })
    check('9.3 损坏上下文 JSON 安全回退（返回会话且不崩溃）', typeof r2.sessionId === 'string')
  } catch { crashed = true }
  check('9.4 损坏上下文不崩溃', crashed === false)

  // 当前指针指向不存在会话 → 返回空，不崩溃
  failDb.prepare(
    "INSERT INTO chat_state (user_id, current_session_id) VALUES (?, 'no-such-session') ON CONFLICT(user_id) DO UPDATE SET current_session_id = excluded.current_session_id",
  ).run(fu1)
  const cur = createAssistant({ db: failDb, demoUserId: fu1, chatFn: mock }).getCurrent()
  check('9.5 当前会话不存在时返回空', cur.sessionId === null && cur.messages.length === 0)

  failDb.close()
  for (const p of [FAIL_DB_PATH, FAIL_DB_PATH + '-wal', FAIL_DB_PATH + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
