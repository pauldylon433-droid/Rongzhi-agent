// 会话标识协议回归验证（针对「首次发送报 sessionId 必须是字符串」问题）。
// 覆盖：
//   A. 前端 buildChatPayload：首次请求实际 JSON 不含 sessionId；null/undefined/空/纯空白均省略；
//      非空字符串才附带并去空格；新建对话（清除标识后）再次省略该字段。
//   B. 后端会话流（模拟模型）：首次无 sessionId 创建会话返回非空标识；二次携带标识沿用同一会话并保留上下文。
//   C. 后端参数校验：字段缺省允许；显式非字符串（null/数字/对象）与空白字符串均返回 400。
// 使用模拟模型，不调用真实模型；不改开发库；不依赖运行中服务。
// 用法：node scripts/verify-assistant-session.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { parseChatBody } from '../src/routes/assistant.js'
import { buildChatPayload } from '../../frontend/src/api/index.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-assistant-session-test.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// ---------- A. 前端请求体构造 ----------
{
  const first = buildChatPayload('我的账户余额是多少？', null)
  const firstJson = JSON.stringify(first)
  check('A1 首次请求 JSON 不含 sessionId（null）', !hasKey(first, 'sessionId') && firstJson.indexOf('sessionId') === -1, firstJson)

  const undef = buildChatPayload('你好', undefined)
  const emptyStr = buildChatPayload('你好', '')
  const blankStr = buildChatPayload('你好', '   ')
  check('A2 undefined 省略 sessionId', !hasKey(undef, 'sessionId'))
  check('A3 空字符串省略 sessionId', !hasKey(emptyStr, 'sessionId'))
  check('A4 纯空白字符串省略 sessionId', !hasKey(blankStr, 'sessionId'))

  const withId = buildChatPayload('追问', '  abc-123  ')
  check('A5 非空字符串附带并去空格', hasKey(withId, 'sessionId') && withId.sessionId === 'abc-123', JSON.stringify(withId))
  check('A6 附带时仅含 message 与 sessionId', JSON.stringify(Object.keys(withId).sort()) === JSON.stringify(['message', 'sessionId']))

  // 新建对话：清除旧标识后（sessionId 回到 null）再次请求省略该字段
  const afterNewChat = buildChatPayload('新对话第一条', null)
  check('A7 新建对话后不再发送旧标识', !hasKey(afterNewChat, 'sessionId'))
}

// ---------- B. 后端会话流（模拟模型） ----------
{
  const db = openDatabase(DB_PATH)
  createSchema(db)
  migrate(db)
  const uid = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid

  const script = [{ content: '第一次回复' }, { content: '第二次回复' }]
  const calls = []
  const mock = async ({ messages }) => {
    calls.push(JSON.parse(JSON.stringify(messages)))
    const step = script.shift() || { content: '' }
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }

  const assistant = createAssistant({ db, demoUserId: uid, chatFn: mock })
  const r1 = await assistant.chat({ message: '你好' })
  check('B1 首次无 sessionId 创建会话并返回非空字符串标识', typeof r1.sessionId === 'string' && r1.sessionId.length > 0, r1.sessionId)

  const r2 = await assistant.chat({ message: '刚才呢？', sessionId: r1.sessionId })
  check('B2 第二次携带返回标识沿用同一会话', r2.sessionId === r1.sessionId)

  const secondUserMsgs = calls[1].filter((m) => m.role === 'user').map((m) => m.content)
  check('B3 第二次请求保留首次上下文', secondUserMsgs.length === 2 && secondUserMsgs[0] === '你好' && secondUserMsgs[1] === '刚才呢？', JSON.stringify(secondUserMsgs))

  db.close()
}

// ---------- C. 后端参数校验 ----------
{
  check('C1 非字符串 null 返回 400', parseChatBody({ message: 'hi', sessionId: null }).error === 'sessionId 必须是字符串')
  check('C2 非字符串数字返回 400', parseChatBody({ message: 'hi', sessionId: 123 }).error === 'sessionId 必须是字符串')
  check('C3 非字符串对象返回 400', parseChatBody({ message: 'hi', sessionId: {} }).error === 'sessionId 必须是字符串')
  check('C4 空字符串返回 400', parseChatBody({ message: 'hi', sessionId: '' }).error === 'sessionId 不能是空白字符串')
  check('C5 纯空格字符串返回 400', parseChatBody({ message: 'hi', sessionId: '   ' }).error === 'sessionId 不能是空白字符串')
  check('C6 字段缺省允许（不含 sessionId）', parseChatBody({ message: 'hi' }).error === undefined)
  const okBody = parseChatBody({ message: ' hi ', sessionId: ' abc ' })
  check('C7 合法 sessionId 正常解析', okBody.error === undefined && okBody.message === 'hi' && okBody.sessionId === 'abc')
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
