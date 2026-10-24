// 右侧「业务信息」随任务变化 验证脚本：在独立临时数据库上运行，不触碰开发数据库，不调用收费模型。
// 验证前端修复所依赖的后端契约：任务视图暴露 session_id（前端据此把任务绑定到当前对话），
// 以及「尚未选择 → 待确认（不提前成功）→ 真实确认后完成」的状态序列、会话切换 / 刷新不串任务。
// 用法：node scripts/verify-business-info-binding.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createTask, getTask, listRecentTasks, selectSubscription,
} from '../src/services/agent-tasks.js'
import { confirmSubscriptionOperation } from '../src/services/subscription-operations.js'
import { createAssistant } from '../src/services/assistant.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.argv[2] || join(tmpdir(), 'rongzhi-verify-business-binding.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: true })
const userId = resolveDemoUser(db).id

function subByMerchant(m) {
  return db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND merchant = ?').get(userId, m)
}
function subById(id) {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
}
const iqiyiId = subByMerchant('爱奇艺会员').id // active

// 可脚本化 mock 模型：按序返回 tool_calls / 文本，不调用收费模型。
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
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

// 模拟「前端当前会话」的过滤：当前任务 = session_id 与当前会话一致且非终态，否则取该会话最近一条。
function currentTaskFor(sessionId) {
  const mine = listRecentTasks(db, userId, 100).filter((t) => t.session_id === sessionId)
  if (!mine.length) return null
  return mine.find((t) => !['completed', 'cancelled', 'manual'].includes(t.status)) || mine[0] || null
}

// —— 1. 助手启动任务 → 任务绑定会话，右侧可据此关联 ——
console.log('—— 1. 助手启动任务 → 任务绑定当前会话 ——')
{
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'start_subscription_review', { month: '2026-10' })] },
      { content: '已启动订阅审查任务。' },
    ]),
  })
  const r = await assistant.chat({ message: '分析本月支出并列出生效订阅，让我选择后暂停一项' })
  const sessionA = r.sessionId
  const rec = r.toolRecords.find((x) => x.name === 'start_subscription_review')
  check('1.1 助手调用 start_subscription_review 成功', !!rec && rec.status === 'ok')
  const task = currentTaskFor(sessionA)
  check('1.2 最近任务视图暴露 session_id（前端可绑定）', task !== null && typeof task.session_id === 'string')
  check('1.3 任务 session_id 与会话一致', task && task.session_id === sessionA, `${task && task.session_id}`)
  check('1.4 启动后为等待选择', task && task.status === 'waiting_selection', task && task.status)
  check('1.5 尚未选择：selected_subscription 为空', task && task.selected_subscription_id === null && task.selected_subscription === null)
  check('1.6 未完成：result_summary 为空（不提前显示成功）', task && task.result_summary === null)
  const monthly = task.nodes.find((n) => n.node_key === 'monthly_analysis')
  const sq = task.nodes.find((n) => n.node_key === 'subscription_query')
  check('1.7 月度分析快照已生成', monthly && monthly.status === 'completed' && monthly.result && monthly.result.expense_cents != null)
  check('1.8 生效订阅查询快照已生成', sq && sq.status === 'completed' && typeof sq.result.count === 'number')
}

// —— 2. 选择订阅 → 待确认（不提前执行成功，业务状态不变）——
console.log('—— 2. 选择订阅 → 待确认（不提前执行成功）——')
{
  const beforeOps = db.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c
  const t = createTask(db, userId, { month: '2026-10', sessionId: 'session-2-demo' })
  const sel = selectSubscription(db, userId, t.task_no, iqiyiId)
  check('2.1 选择成功', sel.outcome === 'selected')
  check('2.2 落到等待确认', sel.task.status === 'waiting_confirmation', sel.task.status)
  check('2.3 展示已选订阅信息', sel.task.selected_subscription && sel.task.selected_subscription.merchant === '爱奇艺会员')
  check('2.4 待确认：操作单为 pending（未执行）', sel.task.op && sel.task.op.status === 'pending')
  check('2.5 待确认：result_summary 仍为空（不显示执行成功）', sel.task.result_summary === null)
  check('2.6 准备阶段业务状态不变：订阅仍 active', subById(iqiyiId).status === 'active')
  check('2.7 选择后恰好新增一张操作单', db.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c === beforeOps + 1)
  check('2.8 任务视图暴露 session_id', sel.task.session_id === 'session-2-demo')
}

// —— 3. 真实确认 → 完成（状态同步）——
console.log('—— 3. 真实确认 → 完成（状态同步）——')
{
  const t = createTask(db, userId, { month: '2026-10', sessionId: 'session-3-demo' })
  const sel = selectSubscription(db, userId, t.task_no, iqiyiId)
  const r = confirmSubscriptionOperation(db, userId, sel.task.op_ref)
  check('3.1 确认返回 completed', r.outcome === 'completed')
  const got = getTask(db, userId, t.task_no)
  check('3.2 对账后任务完成', got.status === 'completed', got.status)
  check('3.3 完成后 result_summary 生成（真实成功回执）', got.result_summary && got.result_summary.merchant === '爱奇艺会员')
  check('3.4 完成后订阅已暂停（真实业务）', subById(iqiyiId).status === 'paused')
}

// —— 4. 区分「当前任务」与「最近任务」：多会话隔离 ——
console.log('—— 4. 区分当前任务 / 最近任务：多会话隔离 ——')
{
  // 会话 A 与 B 各启动一条任务
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'start_subscription_review', { month: '2026-09' })] },
      { content: 'A 会话任务' },
      { toolCalls: [tc('c2', 'start_subscription_review', { month: '2026-08' })] },
      { content: 'B 会话任务' },
    ]),
  })
  const rA = await assistant.chat({ message: '分析上月支出' })
  assistant.newConversation()
  const rB = await assistant.chat({ message: '分析上上月支出' })
  const sessionA = rA.sessionId
  const sessionB = rB.sessionId
  check('4.1 A/B 是两个不同会话', sessionA !== sessionB)

  const tA = currentTaskFor(sessionA)
  const tB = currentTaskFor(sessionB)
  check('4.2 会话 A 的当前任务归属 A', tA && tA.session_id === sessionA && tA.month === '2026-09', `${tA && tA.month}`)
  check('4.3 会话 B 的当前任务归属 B', tB && tB.session_id === sessionB && tB.month === '2026-08', `${tB && tB.month}`)
  check('4.4 不把上一会话任务当当前任务', tA && tA.task_no !== tB.task_no)
  check('4.5 最近任务同时含两条且可区分', listRecentTasks(db, userId, 100).filter((x) => x.session_id === sessionA || x.session_id === sessionB).length >= 2)
}

// —— 5. 会话切换 / 刷新恢复，旧请求不覆盖新会话绑定 ——
console.log('—— 5. 会话切换 / 刷新恢复，任务不串会话 ——')
{
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'start_subscription_review', { month: '2026-10' })] },
      { content: '启动任务' },
    ]),
  })
  const rA = await assistant.chat({ message: '启动订阅审查' })
  const sessionA = rA.sessionId
  const taskNoA = currentTaskFor(sessionA).task_no

  assistant.newConversation() // 切到空白新对话
  check('5.1 切到空白新对话后当前指针为空', assistant.getCurrent().sessionId === null)
  check('5.2 空白新对话无当前任务（前端显示空态）', currentTaskFor(null) === null)

  // 打开历史会话 A：服务端切回 A，任务仍绑定 A
  const viewA = assistant.getConversation(sessionA)
  check('5.3 打开 A 恢复其会话', viewA.sessionId === sessionA)
  const tA = currentTaskFor(sessionA)
  check('5.4 刷新后任务仍绑定 A 且状态一致', tA && tA.task_no === taskNoA && tA.session_id === sessionA)

  // 再在 B 会话发起任务，A 的任务 session_id 不变（旧会话不被覆盖）
  const assistant2 = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'start_subscription_review', { month: '2026-07' })] },
      { content: 'B 会话任务' },
    ]),
  })
  await assistant2.chat({ message: '再启动一次订阅审查' })
  const tA2 = listRecentTasks(db, userId, 100).find((x) => x.task_no === taskNoA)
  check('5.5 A 的任务 session_id 不因其他会话而变化', tA2 && tA2.session_id === sessionA, `${tA2 && tA2.session_id}`)
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
process.exit(failures === 0 ? 0 : 1)
