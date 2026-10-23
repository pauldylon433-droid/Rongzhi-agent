// 转账「状态一致性」边界验证（补充 Task 9）：历史单只读兼容 + 请求与确认交错。
// 使用「模拟模型响应 + 独立临时数据库」，不修改开发库、不调用真实模型。
// 用法：node scripts/verify-transfer-receipt-edge.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { confirmTransfer } from '../src/services/transfers.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-transfer-receipt-edge.db')

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
  const calls = []
  const fn = async ({ messages }) => {
    calls.push({ index: i, messages: JSON.parse(JSON.stringify(messages)) })
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  fn.calls = calls
  return fn
}
function systemContent(mock, callIndex = 0) {
  const m = mock.calls[callIndex] && mock.calls[callIndex].messages
  return (m && m[0] && m[0].content) || ''
}
function receiptBlock(sys) {
  const idx = sys.indexOf('[权威回执·最近转账]')
  return idx === -1 ? '' : sys.slice(idx)
}
// 权威回执业务数据为单行 JSON（标准序列化），解析后断言字段
function receiptData(block) {
  const line = block.split('\n').find((l) => l.startsWith('{"ref_tail"'))
  try { return line ? JSON.parse(line) : null } catch { return null }
}

for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
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

const txCount = () => db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c

// ============ 边界一：历史单（无 session_id）只读兼容 ============
console.log('—— 边界一：历史单（无 session_id）只读兼容 ——')
{
  // 模拟修复前：转账单无 session_id，但会话 pending_transfer_ref 仍指向该真实操作单
  const legacyRef = '0e0e8420-0336-4127-95c6-8653a99cacba'
  const nowMs = Date.now()
  db.prepare(
    `INSERT INTO transfer_operations (ref_no, user_id, session_id, from_account_id, from_account_name, recipient_id, recipient_name, recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at, confirmed_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'completed', 'yellow', ?, ?, ?)`,
  ).run(legacyRef, u1, 1, '人民币活期账户', 1, '李雷', '6217 **** **** 8801', 3000, '历史单', new Date(nowMs - 3600000).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString())
  // 流水 63（引用该转账单）
  const txId = db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, transfer_ref)
     VALUES (?, 1, 'expense', 3000, '转账', '李雷', '历史单', ?, 'posted', ?)`,
  ).run(u1, new Date(nowMs).toISOString(), legacyRef).lastInsertRowid
  // 会话：pending_transfer_ref 指向该真实单
  db.prepare(
    `INSERT INTO chat_sessions (id, user_id, messages_json, pending_transfer_ref, pending_card_op_ref, pending_subscription_op_ref, created_at, last_active_at)
     VALUES ('legacy-session', ?, '[]', ?, NULL, NULL, ?, ?)`,
  ).run(u1, legacyRef, nowMs, nowMs)

  const mock = makeScriptedMock([{ content: '该转账已完成。' }])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  await assistant.chat({ message: '这笔转账完成了吗', sessionId: 'legacy-session' })
  const block = receiptBlock(systemContent(mock, 0))

  check('1.1 历史单经 pending_transfer_ref 回退注入权威回执', block !== '', block.slice(0, 60))
  check('1.2 读取到真实状态 completed', /已完成（已扣款）/.test(block))
  const d1 = receiptData(block)
  check('1.3 含真实流水编号', !!d1 && d1.transaction_id != null, d1 && String(d1.transaction_id))
  check('1.4 不按姓名/金额猜测（回执即真实单）', block.includes(refTail(legacyRef)), block.slice(0, 40))

  // 只读性：不回填 session_id、不重放转账、不新增流水
  const afterSessionId = db.prepare('SELECT session_id AS s FROM transfer_operations WHERE ref_no = ?').get(legacyRef).s
  check('1.5 不回填 session_id（仍为 NULL）', afterSessionId === null, String(afterSessionId))
  check('1.6 不重放转账（流水条数不变）', txCount() === 1, String(txCount()))

  // 归属核验：他人会话不能读到他人操作单（回退被拒）
  db.prepare(
    `INSERT INTO chat_sessions (id, user_id, messages_json, pending_transfer_ref, pending_card_op_ref, pending_subscription_op_ref, created_at, last_active_at)
     VALUES ('cross-session', ?, '[]', ?, NULL, NULL, ?, ?)`,
  ).run(u2, legacyRef, nowMs, nowMs)
  const mockCross = makeScriptedMock([{ content: 'ok' }])
  const aCross = createAssistant({ db, demoUserId: u2, chatFn: mockCross })
  await aCross.chat({ message: '这笔转账完成了吗', sessionId: 'cross-session' })
  check('1.7 他人归属核验被拒（不注入该单回执）', receiptBlock(systemContent(mockCross, 0)) === '')
}

function refTail(refNo) {
  return typeof refNo === 'string' && refNo.length >= 8 ? `${refNo.slice(0, 8)}…` : refNo || ''
}

// ============ 边界二：请求与确认交错 ============
console.log('—— 边界二：请求与确认交错 ——')
{
  // 新链路建单
  const mockP = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_transfer', { recipient_id: 1, amount_yuan: '30' })] },
    { content: '已生成待确认转账单。' },
  ])
  const aP = createAssistant({ db, demoUserId, chatFn: mockP })
  const rp = await aP.chat({ message: '给李雷转30元' })
  const ref = rp.toolRecords.find((t) => t.name === 'prepare_transfer')?.data?.ref_no
  const sid = rp.sessionId

  // 可控延迟 mock：第一次模型调用捕获系统提示（此时 pending），随后等待；等待期间测试执行「用户确认」
  let releaseResolve
  const release = new Promise((res) => { releaseResolve = res })
  let captured = null
  const chatFn = async ({ messages }) => {
    if (captured === null) {
      captured = JSON.parse(JSON.stringify(messages))
      await release
    }
    return { content: '（模型最终回复）', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  const aInter = createAssistant({ db, demoUserId, chatFn })
  const chatPromise = aInter.chat({ message: '这笔转账扣款了吗', sessionId: sid })
  // 让第一次模型调用执行到 await release（捕获 pending 快照）
  await new Promise((r) => setImmediate(r))

  // 用户在请求未返回期间完成确认
  const conf = confirmTransfer(db, demoUserId, ref)
  releaseResolve()
  await chatPromise

  const sys = captured[0].content
  const block = receiptBlock(sys)
  check('2.1 交错中确认成功（数据库 completed）', conf.outcome === 'completed', conf.outcome)
  const d2 = receiptData(block)
  check('2.2 请求开始时的快照为待确认', !!d2 && /待确认（尚未扣款）/.test(d2.status_text || ''))
  check('2.3 快照为查询时点数据块（含查询时间与状态文案）', !!d2 && d2.status_text === '待确认（尚未扣款）' && /查询时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(block), d2 && d2.status_text)
  check('2.4 快照保留正确查询时间', /查询时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(block))
  check('2.5 系统提示要求不得断言「尚未扣款」', /不要断言「尚未扣款」/.test(sys))
  check('2.6 系统提示要求不得再次引导确认', /不要再次引导确认/.test(sys))
  check('2.7 确认后数据库仍为真实完成态（旧快照不覆盖新状态）', db.prepare('SELECT status AS s FROM transfer_operations WHERE ref_no = ?').get(ref).s === 'completed')

  // 交错后的下一次请求恢复权威「已完成」（系统自我纠正）
  const mockAfter = makeScriptedMock([{ content: '已完成。' }])
  const aAfter = createAssistant({ db, demoUserId, chatFn: mockAfter })
  await aAfter.chat({ message: '现在到底扣款了没', sessionId: sid })
  check('2.8 交错后的下一次请求注入已完成（不被旧快照带偏）', /已完成（已扣款）/.test(receiptBlock(systemContent(mockAfter, 0))))
}

// ============ 边界三：确定性状态回复（生成期状态变化 → 用权威回复替换模型草稿） ============
console.log('—— 边界三：确定性状态回复（生成期确认成功，旧待确认表述被替换为权威成功回执） ——')
{
  // 新链路建单（待确认）
  const mockP = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_transfer', { recipient_id: 1, amount_yuan: '20' })] },
    { content: '已生成待确认转账单。' },
  ])
  const aP = createAssistant({ db, demoUserId, chatFn: mockP })
  const rp = await aP.chat({ message: '给李雷转20元' })
  const ref3 = rp.toolRecords.find((t) => t.name === 'prepare_transfer')?.data?.ref_no
  const sid3 = rp.sessionId

  // 可控延迟 mock：首次模型调用捕获快照（此时 pending）并等待；模型「已生成」旧的待确认表述，期间测试执行确认
  let releaseResolve3
  const release3 = new Promise((res) => { releaseResolve3 = res })
  let captured3 = null
  let modelCalls3 = 0
  const staleText = '该转账仍在待确认状态，尚未扣款，请先在下方点击确认后再查询余额。'
  const chatFn3 = async ({ messages }) => {
    modelCalls3 += 1
    if (captured3 === null) {
      captured3 = JSON.parse(JSON.stringify(messages))
      await release3
    }
    return { content: staleText, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  const a3 = createAssistant({ db, demoUserId, chatFn: chatFn3 })
  const chatPromise3 = a3.chat({ message: '这笔转账扣款了吗', sessionId: sid3 })
  await new Promise((r) => setImmediate(r))

  // 生成期间用户完成确认
  const conf3 = confirmTransfer(db, demoUserId, ref3)
  releaseResolve3()
  const resp3 = await chatPromise3

  const sys3 = captured3[0].content
  check('3.1 生成期快照确为待确认', /待确认（尚未扣款）/.test(receiptBlock(sys3)))
  check('3.2 生成期间确认成功（completed）', conf3.outcome === 'completed', conf3.outcome)
  // 最终可见回复：不再断言当前「待确认 / 尚未扣款」，也不含要求再次确认的指引
  check('3.3 最终回复不再断言待确认/尚未扣款', resp3.reply.includes('已完成') && !resp3.reply.includes('待确认') && !resp3.reply.includes('尚未扣款'), resp3.reply)
  check('3.4 回复为权威成功回执（金额 + 流水编号）', /金额 \d+(\.\d+)? 元/.test(resp3.reply) && /流水编号 \d+/.test(resp3.reply), resp3.reply)
  check('3.5 不含要求再次确认的指引', !resp3.reply.includes('再次确认') && !/请[^。]*确认/.test(resp3.reply) && !resp3.reply.includes('待确认'))
  check('3.6 不向用户展示内部指令（权威回执/以此为准/查询时间/不要再次要求确认）', !resp3.reply.includes('权威回执') && !resp3.reply.includes('以此为准') && !resp3.reply.includes('查询时间') && !resp3.reply.includes('不要再次要求确认'))

  // 持久化一致性：可见 assistant 消息文本与返回一致（同样被替换、不含旧状态）
  const persisted = db.prepare("SELECT text FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC, id DESC LIMIT 1").get(sid3)
  check('3.7 持久化可见回复与返回一致', !!persisted && persisted.text === resp3.reply)
  check('3.8 持久化内容同样不含旧状态/再次确认指引', !!persisted && !persisted.text.includes('待确认') && !persisted.text.includes('尚未扣款') && !persisted.text.includes('再次确认'))

  // 只读性与无重放：只扣款一次、流水一次；确定性回复不追加模型调用
  const txByRef3 = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE transfer_ref = ?').get(ref3).c
  check('3.9 确认只扣款一次/流水一次', txByRef3 === 1, String(txByRef3))
  check('3.10 确定性回复不追加模型调用（仍一次）', modelCalls3 === 1, String(modelCalls3))
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
