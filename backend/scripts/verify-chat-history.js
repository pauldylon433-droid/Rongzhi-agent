// 聊天历史回归验证脚本：使用「模拟模型 + 独立临时数据库」验证「新增对话后旧会话保留、可列表、可重开」。
// 覆盖（对应修复需求）：
//  1. 旧会话 A → 新增 B 后，历史列表仍含 A（数据未被删除，仅非当前）；
//  2. 历史列表按最近活跃倒序、标题取首条用户消息、含最近活跃时间；
//  3. 打开 A 恢复其消息，且服务端当前指针切到 A（刷新 / 重启仍可恢复）；
//  4. 再次打开 B 恢复 B 消息；
//  5. 闲置会话仍可列表与查看（不把闲置等同于删除）；
//  6. 会话按用户隔离：他用户不能列出 / 打开本用户会话；不存在的会话返回 null；
//  7. 列表 / 打开均为只读：不调用模型。
// 不修改开发数据库，不调用真实模型。用法：node scripts/verify-chat-history.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-chat-history-test.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

// 可脚本化模拟 chatFn（记录调用次数，用于断言列表/打开不触发模型）
function makeScriptedMock(script) {
  let i = 0
  const fn = async () => {
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  fn.calls = i
  return fn
}

const db = openDatabase(DB_PATH)
createSchema(db)
migrate(db)
const u1 = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
  .run(u1, '人民币活期账户', 500000, 500000, 'CNY', 'active')
db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
  .run(u2, '李四测试账户', 999999, 999999, 'CNY', 'active')

const demoUserId = u1

// ---------- 1 + 2. 旧会话保留、列表顺序与标题 ----------
const mockA = makeScriptedMock([
  { content: 'A 回答一' },
  { content: 'A 回答二' },
  { content: 'B 回答一' },
])
const assistant = createAssistant({ db, demoUserId, chatFn: mockA })
const rA = await assistant.chat({ message: '旧会话问题' })
await assistant.chat({ message: '旧会话追问', sessionId: rA.sessionId })

// 新增对话：只切指针，不删历史
assistant.newConversation()
const listAfterNew = assistant.listConversations()
check('1.1 新增对话后旧会话仍在列表', listAfterNew.some((c) => c.id === rA.sessionId), JSON.stringify(listAfterNew.map((c) => c.id)))
check('1.2 新增对话后当前对话为空', assistant.getCurrent().sessionId === null)

const rB = await assistant.chat({ message: '新会话问题' })
const list = assistant.listConversations()
check('2.1 列表含 A、B 两个会话', list.length === 2, String(list.length))
check('2.2 按最近活跃倒序（B 在前）', list[0].id === rB.sessionId && list[1].id === rA.sessionId)
check('2.3 标题取首条用户消息', list.find((c) => c.id === rA.sessionId).title === '旧会话问题' && list.find((c) => c.id === rB.sessionId).title === '新会话问题')
check('2.4 含最近活跃时间（毫秒）', typeof list[0].lastActiveAt === 'number' && list[0].lastActiveAt > 0)

// ---------- 3 + 4. 打开历史会话恢复消息并切换当前指针 ----------
const viewA = assistant.getConversation(rA.sessionId)
check('3.1 打开 A 返回其消息（2 用户 + 2 助手）', viewA.sessionId === rA.sessionId && viewA.messages.length === 4, String(viewA.messages.length))
check('3.2 打开 A 恢复内容顺序', viewA.messages[0].text === '旧会话问题' && viewA.messages[3].text === 'A 回答二')
check('3.3 打开 A 后当前指针切到 A', assistant.getCurrent().sessionId === rA.sessionId)

const viewB = assistant.getConversation(rB.sessionId)
check('4.1 再次打开 B 恢复其消息', viewB.sessionId === rB.sessionId && viewB.messages.length === 2, String(viewB.messages.length))
check('4.2 打开 B 后当前指针切到 B', assistant.getCurrent().sessionId === rB.sessionId)

// ---------- 5. 闲置会话仍可列表与查看 ----------
db.prepare('UPDATE chat_sessions SET last_active_at = ? WHERE id = ?').run(Date.now() - 31 * 60 * 1000, rA.sessionId)
const assistantIdle = createAssistant({ db, demoUserId, chatFn: makeScriptedMock([{ content: 'x' }]) })
const viewIdle = assistantIdle.getConversation(rA.sessionId)
check('5.1 闲置会话仍可查看消息', viewIdle.sessionId === rA.sessionId && viewIdle.messages.length === 4, String(viewIdle.messages.length))
const listIdle = assistantIdle.listConversations()
check('5.2 闲置会话仍在历史列表', listIdle.some((c) => c.id === rA.sessionId))

// ---------- 6. 越权 / 不存在 ----------
const assistantU2 = createAssistant({ db, demoUserId: u2, chatFn: makeScriptedMock([{ content: 'u2' }]) })
check('6.1 他用户列表为空', assistantU2.listConversations().length === 0)
check('6.2 他用户无法打开本用户会话', assistantU2.getConversation(rA.sessionId) === null)
check('6.3 不存在的会话返回 null', assistant.getConversation('no-such-session') === null)
check('6.4 空字符串返回 null', assistant.getConversation('') === null)

// ---------- 7. 列表 / 打开只读：不调用模型 ----------
const mockReadonly = makeScriptedMock([{ content: '不应被调用' }])
const assistantRO = createAssistant({ db, demoUserId, chatFn: mockReadonly })
assistantRO.listConversations()
assistantRO.getConversation(rA.sessionId)
check('7.1 列表与打开不调用模型', mockReadonly.calls === 0, String(mockReadonly.calls))

// ---------- 8. 延迟响应不串会话、不覆盖最后指针（后端持久化为准） ----------
{
  let resolveA
  const gateA = new Promise((r) => { resolveA = r })
  const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

  const mock = async ({ messages }) => {
    const lastUser = messages.filter((m) => m.role === 'user').map((m) => m.content).pop()
    if (lastUser === 'A转账') {
      const hasTool = messages.some((m) => m.role === 'tool')
      if (!hasTool) {
        await gateA // A 首轮模型调用挂起，模拟在途
        return { content: '', toolCalls: [tc('a1', 'prepare_transfer', { recipient_id: 1, amount_yuan: '100' })], usage: null }
      }
      return { content: '已生成待确认转账单。', toolCalls: [], usage: null }
    }
    return { content: 'B回复', toolCalls: [], usage: null }
  }

  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  assistant.newConversation() // 清空指针，隔离此前场景
  const aPromise = assistant.chat({ message: 'A转账' }) // 挂起在 gateA
  assistant.newConversation() // 模拟用户切到空白新对话
  const rB = await assistant.chat({ message: 'B问题' }) // B 立即返回
  resolveA() // 放行 A
  const rA = await aPromise

  // 关键：A 的延迟完成不得覆盖 B 的当前指针（在读取会话之前先断言）
  check('8.1 延迟 A 完成后当前指针仍为 B', assistant.getCurrent().sessionId === rB.sessionId, JSON.stringify({ cur: assistant.getCurrent().sessionId, B: rB.sessionId, A: rA.sessionId }))

  // B 不出现 A 的消息（含回复与结果卡）
  const viewB = assistant.getConversation(rB.sessionId)
  const bTexts = viewB.messages.map((m) => m.text)
  const bHasTransferCard = viewB.messages.some((m) => (m.toolRecords || []).some((t) => t.name === 'prepare_transfer'))
  check('8.2 B 会话不含 A 消息', viewB.messages.length === 2 && bTexts[0] === 'B问题' && bTexts[1] === 'B回复' && !bHasTransferCard, JSON.stringify(bTexts))

  // A 已持久化：回复 + 结果卡 + 业务单引用
  const viewA = assistant.getConversation(rA.sessionId)
  const transferRec = viewA.messages[1] && viewA.messages[1].toolRecords && viewA.messages[1].toolRecords.find((t) => t.name === 'prepare_transfer')
  // 事实保护：持久化内容与返回内容一致，且业务声明使用服务端权威回执。
  check('8.3 A 回复已持久化（权威回执 + 结构化块）', viewA.messages.length === 2
    && viewA.messages[1].text.startsWith('该笔转账待确认（尚未扣款）。')
    && viewA.messages[1].text.includes('转账操作单（服务端核验）'))
  check('8.4 A 结果卡含业务单引用 ref_no', !!transferRec && typeof transferRec.data.ref_no === 'string' && transferRec.data.ref_no.length > 0)
  const opRow = transferRec ? db.prepare('SELECT ref_no FROM transfer_operations WHERE ref_no = ?').get(transferRec.data.ref_no) : null
  check('8.5 业务单已入库且可回读', !!opRow)
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
