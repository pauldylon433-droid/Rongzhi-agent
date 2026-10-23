// 转账「状态一致性·权威回执」验证脚本：使用「模拟模型响应 + 独立临时数据库」验证
// 界面确认成功后的权威回执能关联回发起转账的原始会话，使后续查询 / 提问得到一致结果。
// 覆盖：建单 pending 不扣款、确认成功扣款一次且流水一次、回执注入（completed + 流水 + 确认时间）、
//       余额查询/追问是否完成得到一致结果、切换会话与重启后回执仍正确关联、幂等重复确认不重复扣款/追加、
//       旧 pending 结果不覆盖新 completed 状态、无关联会话不注入、查询失败不编造、独立转账页建单不注入。
// 不修改开发数据库，不调用真实模型，不依赖外部服务。用法：node scripts/verify-transfer-receipt.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { confirmTransfer, getTransfer, latestTransferForSession } from '../src/services/transfers.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-transfer-receipt-test.db')

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
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }
  fn.calls = calls
  return fn
}
function systemContent(mock, callIndex = 0) {
  const m = mock.calls[callIndex] && mock.calls[callIndex].messages
  return (m && m[0] && m[0].content) || ''
}
// 提取真正的权威回执块（以方括号 [权威回执·最近转账] 开头，区别于系统提示规则里的中文书名号「权威回执·最近转账」）
function receiptBlock(sys) {
  const idx = sys.indexOf('[权威回执·最近转账]')
  return idx === -1 ? '' : sys.slice(idx)
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

const balanceOf = (userId) => db.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(userId).b
const txCount = () => db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c
const sessionPendingRef = (sid) =>
  db.prepare('SELECT pending_transfer_ref AS r FROM chat_sessions WHERE id = ?').get(sid)?.r ?? null

// ---------- 1. 建单 pending，不扣款，会话已关联 ----------
let sessionId
let refNo
{
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'search_transfer_recipients', { name: '李雷' })] },
    { toolCalls: [tc('c2', 'prepare_transfer', { recipient_id: 1, amount_yuan: '30', remark: '测试' })] },
    { content: '已生成待确认转账单，请在下方确认。' },
  ])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const bal0 = balanceOf(demoUserId)
  const r = await assistant.chat({ message: '给李雷转30元' })
  sessionId = r.sessionId
  const prep = r.toolRecords.find((t) => t.name === 'prepare_transfer')
  refNo = prep?.data?.ref_no

  check('1.1 建单返回 pending', prep?.data?.status === 'pending', prep?.data?.status)
  check('1.2 建单不扣款（余额不变）', balanceOf(demoUserId) === bal0, `${bal0}->${balanceOf(demoUserId)}`)
  check('1.3 转账单记录发起会话 session_id', db.prepare('SELECT session_id AS s FROM transfer_operations WHERE ref_no = ?').get(refNo)?.s === sessionId)
  check('1.4 会话待确认引用指向该单', sessionPendingRef(sessionId) === refNo)

  // 建单后的下一次提问（新请求）注入权威状态：待确认
  const mockQ = makeScriptedMock([{ content: '该转账待确认。' }])
  const aQ = createAssistant({ db, demoUserId, chatFn: mockQ })
  await aQ.chat({ message: '那笔转账怎么样了', sessionId })
  const block = receiptBlock(systemContent(mockQ, 0))
  check('1.5 建单后（下一请求）注入权威状态为待确认', /状态：待确认（尚未扣款）/.test(block), block.slice(0, 80))
}

// ---------- 2. 确认成功：扣款一次、流水一次、状态一致 ----------
{
  const bal0 = balanceOf(demoUserId)
  const tx0 = txCount()
  const conf = confirmTransfer(db, demoUserId, refNo)
  check('2.1 确认成功 completed', conf.outcome === 'completed', conf.outcome)
  check('2.2 余额仅减少一次（3000 分）', balanceOf(demoUserId) === bal0 - 3000, `${bal0}->${balanceOf(demoUserId)}`)
  check('2.3 流水仅新增一次', txCount() === tx0 + 1, `${tx0}->${txCount()}`)
  const tx = db.prepare('SELECT id, amount_cents, status FROM transactions WHERE transfer_ref = ?').get(refNo)
  check('2.4 流水金额/状态正确且含流水引用', !!tx && tx.amount_cents === 3000 && tx.status === 'posted', JSON.stringify(tx))
  check('2.5 确认回执含流水编号', typeof conf.op?.transaction_id === 'number', String(conf.op?.transaction_id))
  check('2.6 会话待确认引用已被清除', sessionPendingRef(sessionId) === null, String(sessionPendingRef(sessionId)))
  check('2.7 最新状态以数据库为准（completed）', getTransfer(db, demoUserId, refNo)?.status === 'completed')
}

// ---------- 3. 确认后查询余额/询问是否完成：注入权威回执为已完成 ----------
{
  const mock = makeScriptedMock([{ content: '你的余额是 40,963.38 元。' }])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  const r = await assistant.chat({ message: '查一下我的余额', sessionId })
  const block = receiptBlock(systemContent(mock, 0))
  check('3.1 注入权威回执', block !== '')
  check('3.2 状态为已完成（已扣款）', /已完成（已扣款）/.test(block))
  check('3.3 含流水编号与确认时间', /流水编号 \d+/.test(block) && /确认时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(block), block.slice(0, 120))
  check('3.4 回执块不含「尚未确认/待确认」旧状态', !/尚未确认/.test(block) && !/待确认（尚未扣款）/.test(block))
  check('3.5 模型回复不引入旧待确认结论', r.reply === '你的余额是 40,963.38 元。', r.reply)
}

// ---------- 4. 成功后追问「为什么没扣款」：注入已完成，不要求再次确认 ----------
{
  const mock = makeScriptedMock([{ content: '该笔转账已完成并扣款。' }])
  const assistant = createAssistant({ db, demoUserId, chatFn: mock })
  await assistant.chat({ message: '为什么那笔转账没扣款？', sessionId })
  const block = receiptBlock(systemContent(mock, 0))
  check('4.1 追问时注入已完成回执', /已完成（已扣款）/.test(block))
  check('4.2 回执要求以权威状态为准、不编造时间线', /不要编造确认时间或操作顺序/.test(block), block.slice(-60))
}

// ---------- 5. 幂等：重复确认不重复扣款、不重复追加、不重复流水 ----------
{
  const bal0 = balanceOf(demoUserId)
  const tx0 = txCount()
  const c2 = confirmTransfer(db, demoUserId, refNo)
  check('5.1 重复确认返回 completed（幂等）', c2.outcome === 'completed', c2.outcome)
  check('5.2 重复确认不重复扣款', balanceOf(demoUserId) === bal0, `${bal0}->${balanceOf(demoUserId)}`)
  check('5.3 重复确认不重复流水', txCount() === tx0, `${tx0}->${txCount()}`)
}

// ---------- 6. 重启恢复：新助手实例（空内存缓存）从库恢复会话，回执仍正确关联 ----------
{
  const mock = makeScriptedMock([{ content: '该转账已完成。' }])
  const assistant2 = createAssistant({ db, demoUserId, chatFn: mock })
  await assistant2.chat({ message: '那笔转账完成了吗？', sessionId })
  const block = receiptBlock(systemContent(mock, 0))
  check('6.1 重启后（新实例）仍注入已完成回执', /已完成（已扣款）/.test(block))
  check('6.2 最新转账回读会话正确', latestTransferForSession(db, demoUserId, sessionId)?.status === 'completed')
}

// ---------- 7. 跨会话切换：确认时当前会话不是发起会话，回执仍关联原始会话 ----------
{
  const mockA = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_transfer', { recipient_id: 2, amount_yuan: '50' })] },
    { content: '已生成。' },
  ])
  const a1 = createAssistant({ db, demoUserId, chatFn: mockA })
  const ra = await a1.chat({ message: '给韩梅梅转50元' })
  const refA = ra.toolRecords.find((t) => t.name === 'prepare_transfer')?.data?.ref_no
  const sidA = ra.sessionId

  // 打开一个不同的会话（当前指针切到别处），再从「别处」确认 A 会话的单
  const mockB = makeScriptedMock([{ content: 'B 会话无关回答。' }])
  const a2 = createAssistant({ db, demoUserId, chatFn: mockB })
  await a2.chat({ message: 'B 会话随便问一句', sessionId })

  confirmTransfer(db, demoUserId, refA)
  check('7.1 A 会话待确认引用被清除', sessionPendingRef(sidA) === null)
  check('7.2 回执关联到原始会话 A（而非当前打开会话）', latestTransferForSession(db, demoUserId, sidA)?.status === 'completed')

  const mockCheck = makeScriptedMock([{ content: 'ok' }])
  const a3 = createAssistant({ db, demoUserId, chatFn: mockCheck })
  await a3.chat({ message: '确认成功了吗', sessionId: sidA })
  check('7.3 A 会话注入已完成回执', /已完成（已扣款）/.test(receiptBlock(systemContent(mockCheck, 0))))
}

// ---------- 8. 异步一致性：较早的 pending 快照不覆盖已确认状态 ----------
{
  const mockP = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_transfer', { recipient_id: 3, amount_yuan: '20' })] },
    { content: '已生成。' },
  ])
  const aP = createAssistant({ db, demoUserId, chatFn: mockP })
  const rp = await aP.chat({ message: '给王强转20元' })
  const refP = rp.toolRecords.find((t) => t.name === 'prepare_transfer')?.data?.ref_no
  const sidP = rp.sessionId

  // 确认前查询（新请求）：注入为待确认
  const mockQ1 = makeScriptedMock([{ content: '状态是待确认。' }])
  const aQ1 = createAssistant({ db, demoUserId, chatFn: mockQ1 })
  await aQ1.chat({ message: '那笔转账状态？', sessionId: sidP })
  check('8.1 确认前注入为待确认', /待确认（尚未扣款）/.test(receiptBlock(systemContent(mockQ1, 0))))

  confirmTransfer(db, demoUserId, refP)

  // 确认后查询（新请求）：注入必须为已完成，旧 pending 不覆盖
  const mockQ2 = makeScriptedMock([{ content: '已完成。' }])
  const aQ2 = createAssistant({ db, demoUserId, chatFn: mockQ2 })
  await aQ2.chat({ message: '那笔转账状态？', sessionId: sidP })
  const block = receiptBlock(systemContent(mockQ2, 0))
  check('8.2 确认后注入为已完成（旧 pending 不覆盖）', /已完成（已扣款）/.test(block) && !/待确认（尚未扣款）/.test(block), block.slice(0, 80))
}

// ---------- 9. 无关联会话（独立转账页建单）不注入、不关联 ----------
{
  db.prepare(
    `INSERT INTO transfer_operations (ref_no, user_id, session_id, from_account_id, from_account_name, recipient_id, recipient_name, recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('nosession-ref', demoUserId, 1, '人民币活期账户', 1, '李雷', '6217 **** **** 8801', 1000, '', 'pending', 'yellow', new Date().toISOString(), new Date(Date.now() + 300000).toISOString())
  check('9.1 无会话转账最新回执为 null', latestTransferForSession(db, demoUserId, 'nonexistent-session') === null)
  const mockNoSession = makeScriptedMock([{ content: 'ok' }])
  const aNo = createAssistant({ db, demoUserId, chatFn: mockNoSession })
  await aNo.chat({ message: '随便问一句', sessionId: 'no-such-session-xyz' })
  check('9.2 无会话时系统提示不注入转账回执', receiptBlock(systemContent(mockNoSession, 0)) === '')
}

// ---------- 10. 他人会话/越权：回执按会话 + 用户隔离 ----------
{
  check('10.1 他人（u2）读不到该会话转账回执', latestTransferForSession(db, u2, sessionId) === null)
}

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
