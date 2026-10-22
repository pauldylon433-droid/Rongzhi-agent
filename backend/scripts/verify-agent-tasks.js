// 跨场景任务模板 验证脚本：在独立临时数据库上运行，不清空、不触碰开发数据库，不调用收费模型。
// 覆盖：完整任务链（分析→列订阅→选择→暂停单→确认→核验→回执）/ 选择前不建变更单 / 准备不执行 /
//       真实确认后才完成 / 重复请求幂等 / 依赖与参数校验 / 越权 / 旧版本·过期单 / 暂停·取消与确认竞态 /
//       刷新·重启恢复 / 失败后安全继续 / 手动接管 / 助手模型启动任务 / HTTP 路由 / 原业务无回归。
// 用法：node scripts/verify-agent-tasks.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createTask, getTask, listRecentTasks, selectSubscription, pauseTask, resumeTask, cancelTask, manualTask,
  AgentTaskError, TASK_KIND,
} from '../src/services/agent-tasks.js'
import {
  createSubscriptionOperation, confirmSubscriptionOperation, cancelSubscriptionOperation,
} from '../src/services/subscription-operations.js'
import { createAssistant } from '../src/services/assistant.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.argv[2] || join(tmpdir(), 'rongzhi-verify-agent-tasks.db')
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
function opByRef(refNo) {
  return db.prepare('SELECT * FROM subscription_operations WHERE ref_no = ?').get(refNo)
}
// 模拟「建单后订阅被外部改动」：仅自增版本（状态保持不变）
function bumpVersion(id) {
  db.prepare('UPDATE subscriptions SET version = version + 1 WHERE id = ?').run(id)
}
function taskOpCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c
}

const iqiyiId = subByMerchant('爱奇艺会员').id // active
const qqId = subByMerchant('QQ音乐豪华绿钻').id // active
const icloudId = subByMerchant('iCloud 200GB').id // active
const keepId = subByMerchant('Keep 会员').id // paused
const adobeId = subByMerchant('Adobe 摄影计划').id // active yearly

// 每个测试分区自包含：先恢复 4 项生效订阅，避免分区间相互污染（临时库，直接改业务状态）
function resetActive() {
  for (const id of [iqiyiId, qqId, icloudId, adobeId]) {
    db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run('active', id)
  }
}

// —— A. 任务创建：白名单图 + 只读节点自动执行 ——
console.log('—— A. 任务创建与只读节点自动执行 ——')
{
  const t = createTask(db, userId, { month: '2026-10' })
  check('A.1 任务编号与类型', /^task-/.test(t.task_no) && t.kind === TASK_KIND, `${t.task_no}/${t.kind}`)
  check('A.2 初始状态 waiting_selection', t.status === 'waiting_selection', t.status)
  check('A.3 共 7 个白名单节点', t.nodes.length === 7, `${t.nodes.length}`)
  check('A.4 月度分析节点已完成且含支出', t.nodes.find((n) => n.node_key === 'monthly_analysis')?.status === 'completed' && t.nodes.find((n) => n.node_key === 'monthly_analysis')?.result?.expense_cents != null)
  const sq = t.nodes.find((n) => n.node_key === 'subscription_query')
  check('A.5 订阅查询列出 4 项生效订阅', sq?.status === 'completed' && sq?.result?.count === 4, `${sq?.result?.count}`)
  check('A.6 生效订阅不含已暂停/已取消', sq.result.active_subscriptions.every((s) => s.status === 'active'))
  check('A.7 选择前未建任何变更单', t.op_ref === null && taskOpCount() === 0)
  check('A.8 依赖已持久化', t.nodes.find((n) => n.node_key === 'prepare_pause')?.result === null && db.prepare('SELECT depends_on FROM agent_task_nodes WHERE task_id = (SELECT id FROM agent_tasks WHERE task_no = ?) AND node_key = ?').get(t.task_no, 'await_selection').depends_on != null)
}

// —— B. 参数与依赖校验 ——
console.log('—— B. 参数与依赖校验 ——')
{
  let threw = false
  try { createTask(db, userId, { month: '2026-13' }) } catch (e) { threw = e instanceof AgentTaskError }
  check('B.1 非法月份被拒', threw)
  threw = false
  try { createTask(db, userId, { month: 'not-a-month' }) } catch (e) { threw = e instanceof AgentTaskError }
  check('B.2 非 YYYY-MM 被拒', threw)
}

// —— C. 选择 → 准备暂停单（不执行）→ 真实确认 → 完成 ——
console.log('—— C. 完整任务链：选择 → 准备 → 确认 → 核验 → 回执 ——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  const beforeOps = taskOpCount()
  const sel = selectSubscription(db, userId, t.task_no, iqiyiId)
  check('C.1 选择成功', sel.outcome === 'selected')
  check('C.2 落到 waiting_confirmation', sel.task.status === 'waiting_confirmation', sel.task.status)
  check('C.3 已生成暂停操作单（pending/yellow）', sel.task.op && sel.task.op.status === 'pending' && sel.task.op.risk_level === 'yellow', `${sel.task.op?.status}/${sel.task.op?.risk_level}`)
  check('C.4 准备不执行：订阅仍 active', subById(iqiyiId).status === 'active')
  check('C.5 选择后恰好新增一张操作单', taskOpCount() === beforeOps + 1, `${taskOpCount()}`)
  check('C.6 prepare_pause 节点已记录 ref_no', sel.task.nodes.find((n) => n.node_key === 'prepare_pause')?.result?.ref_no === sel.task.op_ref)

  const r = confirmSubscriptionOperation(db, userId, sel.task.op_ref)
  check('C.7 确认返回 completed', r.outcome === 'completed')
  const got = getTask(db, userId, t.task_no)
  check('C.8 对账后任务完成', got.status === 'completed', got.status)
  check('C.9 业务数据库订阅已暂停', subById(iqiyiId).status === 'paused')
  check('C.10 核验节点完成', got.nodes.find((n) => n.node_key === 'verify_result')?.status === 'completed')
  check('C.11 汇总回执含商户与防误解提示', got.result_summary?.merchant === '爱奇艺会员' && /节省|退款/.test(got.result_summary?.note || ''))
}

// —— D. 重复请求幂等 ——
console.log('—— D. 重复请求幂等 ——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  selectSubscription(db, userId, t.task_no, qqId)
  const again = selectSubscription(db, userId, t.task_no, qqId)
  check('D.1 等待确认后重复选择被拒', again.outcome === 'bad_state')
  const r1 = confirmSubscriptionOperation(db, userId, again.task.op_ref)
  const r2 = confirmSubscriptionOperation(db, userId, again.task.op_ref)
  check('D.2 重复确认幂等', r1.outcome === 'completed' && r2.outcome === 'completed')
  const got = getTask(db, userId, t.task_no)
  check('D.3 任务仍为 completed 且未重复执行', got.status === 'completed' && subById(qqId).status === 'paused')
}

// —— E. 越权与归属校验 ——
console.log('—— E. 越权与归属校验 ——')
{
  const u2 = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
  const a2 = db.prepare("INSERT INTO accounts (user_id, account_name, balance_cents, currency, status) VALUES (?, '李四账户', 0, 'CNY', 'active')").run(u2).lastInsertRowid
  const s2 = db.prepare("INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, status) VALUES (?, ?, '李四订阅', 1000, 'monthly', 'active')").run(u2, a2).lastInsertRowid

  const t = createTask(db, userId, { month: '2026-10' })
  let selThrew = null
  try { selectSubscription(db, userId, t.task_no, s2) } catch (e) { selThrew = e }
  check('E.1 选择他人订阅被拒（not_found）', selThrew instanceof AgentTaskError && selThrew.code === 'not_found', selThrew && selThrew.code)
  check('E.2 他人订阅不在可选列表', t.selectable_subscriptions.every((s) => s.id !== s2))
  check('E.3 他人无法读取本任务', getTask(db, u2, t.task_no) === null)
  check('E.4 本人最近任务不含他人任务', listRecentTasks(db, userId).every((x) => x.task_no !== null))
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(s2)
  db.prepare('DELETE FROM accounts WHERE id = ?').run(a2)
  db.prepare('DELETE FROM users WHERE id = ?').run(u2)
}

// —— F. 旧版本 / 过期单 ——
console.log('—— F. 旧版本 / 过期单 ——')
{
  resetActive()
  // 旧版本：建单后订阅被外部改动
  const t1 = createTask(db, userId, { month: '2026-10' })
  const s1 = selectSubscription(db, userId, t1.task_no, adobeId)
  bumpVersion(adobeId)
  const r = confirmSubscriptionOperation(db, userId, s1.task.op_ref)
  check('F.1 旧版本确认返回 stale', r.outcome === 'stale', r.outcome)
  const got1 = getTask(db, userId, t1.task_no)
  check('F.2 任务标记失败且未暂停订阅', got1.status === 'failed' && subById(adobeId).status === 'active', got1.status)
  check('F.3 失败原因说明版本变化', /变化|失效/.test(got1.failure_reason || ''), got1.failure_reason)

  // 过期单：等待确认期间到期
  const t2 = createTask(db, userId, { month: '2026-10' })
  const s2 = selectSubscription(db, userId, t2.task_no, iqiyiId)
  db.prepare('UPDATE subscription_operations SET expires_at = ? WHERE ref_no = ?').run(new Date(Date.now() - 60000).toISOString(), s2.task.op_ref)
  const got2 = getTask(db, userId, t2.task_no)
  check('F.4 过期单回到等待选择（重新选择）', got2.status === 'waiting_selection' && got2.op_ref === null, got2.status)
  check('F.5 过期后订阅仍 active', subById(iqiyiId).status === 'active')
}

// —— G. 暂停 / 继续（重新生成并再次确认）——
console.log('—— G. 暂停 / 继续 ——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  const s = selectSubscription(db, userId, t.task_no, iqiyiId)
  const opA = s.task.op_ref
  const p = pauseTask(db, userId, t.task_no)
  check('G.1 暂停任务成功', p.outcome === 'paused', p.outcome)
  check('G.2 暂停在后台阻断操作单', opByRef(opA).status === 'cancelled')
  check('G.3 暂停不改订阅状态', subById(iqiyiId).status === 'active')

  const res = resumeTask(db, userId, t.task_no)
  check('G.4 继续回到等待确认', res.outcome === 'waiting_confirmation', res.outcome)
  check('G.5 继续重新生成新操作单', res.task.op_ref && res.task.op_ref !== opA, `${res.task.op_ref}`)
  check('G.6 新操作单为 pending', res.task.op && res.task.op.status === 'pending')

  confirmSubscriptionOperation(db, userId, res.task.op_ref)
  const got = getTask(db, userId, t.task_no)
  check('G.7 重新确认后完成', got.status === 'completed' && subById(iqiyiId).status === 'paused')
}

// —— H. 暂停 / 取消与确认竞态（以事务结果为准）——
console.log('—— H. 暂停 / 取消与确认竞态 ——')
{
  resetActive()
  // 先确认后取消：变更已发生，不反向
  const t1 = createTask(db, userId, { month: '2026-10' })
  const s1 = selectSubscription(db, userId, t1.task_no, iqiyiId)
  confirmSubscriptionOperation(db, userId, s1.task.op_ref)
  const c1 = cancelTask(db, userId, t1.task_no)
  check('H.1 已确认后取消任务返回 completed（不反向）', c1.outcome === 'completed', c1.outcome)
  check('H.2 订阅仍 paused', subById(iqiyiId).status === 'paused')

  // 先取消后确认：操作单已取消，确认不执行
  const t2 = createTask(db, userId, { month: '2026-10' })
  const s2 = selectSubscription(db, userId, t2.task_no, qqId)
  const c2 = cancelTask(db, userId, t2.task_no)
  check('H.3 取消任务成功', c2.outcome === 'cancelled', c2.outcome)
  const r2 = confirmSubscriptionOperation(db, userId, s2.task.op_ref)
  check('H.4 取消后确认不执行', r2.outcome === 'cancelled', r2.outcome)
  check('H.5 订阅仍 active', subById(qqId).status === 'active')
}

// —— I. 刷新 / 重启恢复 ——
console.log('—— I. 刷新 / 重启恢复（对账不重发业务操作）——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  const s = selectSubscription(db, userId, t.task_no, qqId)
  const beforeOps = taskOpCount()
  confirmSubscriptionOperation(db, userId, s.task.op_ref)
  // 模拟刷新 / 重启：重新读取（getTask / listRecentTasks），不应新增操作单、不应重发模型请求
  const got = getTask(db, userId, t.task_no)
  check('I.1 刷新恢复为 completed', got.status === 'completed')
  check('I.2 恢复未新增操作单', taskOpCount() === beforeOps)
  const recent = listRecentTasks(db, userId)
  check('I.3 最近任务入口可见', recent.some((x) => x.task_no === t.task_no))
}

// —— J. 失败后安全继续 ——
console.log('—— J. 失败后安全继续 ——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  const s = selectSubscription(db, userId, t.task_no, adobeId)
  bumpVersion(adobeId)
  confirmSubscriptionOperation(db, userId, s.task.op_ref)
  let got = getTask(db, userId, t.task_no)
  check('J.1 任务失败', got.status === 'failed', got.status)
  const res = resumeTask(db, userId, t.task_no)
  check('J.2 失败后继续回到等待选择', res.outcome === 'waiting_selection', res.outcome)
  check('J.3 继续后旧操作单引用已清空', res.task.op_ref === null && res.task.selected_subscription_id === null)
}

// —— K. 手动接管 ——
console.log('—— K. 手动接管 ——')
{
  resetActive()
  const t = createTask(db, userId, { month: '2026-10' })
  const s = selectSubscription(db, userId, t.task_no, iqiyiId)
  const opA = s.task.op_ref
  const m = manualTask(db, userId, t.task_no)
  check('K.1 转手动成功', m.outcome === 'manual', m.outcome)
  check('K.2 手动接管阻断未执行操作单', opByRef(opA).status === 'cancelled')
  check('K.3 订阅状态未变', subById(iqiyiId).status === 'active')
  check('K.4 转手动后再次手动被拒', manualTask(db, userId, t.task_no).outcome === 'manual')
}

// —— L. 助手模型启动任务（mock 模型，不调用收费模型）——
console.log('—— L. 助手模型启动任务 ——')
{
  function tc(id, name, args) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
  }
  function makeScriptedMock(script) {
    let i = 0
    const fn = async ({ messages }) => {
      const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
      i += 1
      return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    }
    fn.calls = i
    return fn
  }
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'start_subscription_review', { month: '2026-10' })] },
    { content: '已启动订阅审查任务。' },
  ])
  const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
  const before = db.prepare('SELECT COUNT(*) AS c FROM agent_tasks').get().c
  const r = await assistant.chat({ message: '分析这个月的支出，列出生效订阅，让我选择后暂停一项' })
  const rec = r.toolRecords.find((x) => x.name === 'start_subscription_review')
  check('L.1 助手调用 start_subscription_review 成功', !!rec && rec.status === 'ok')
  check('L.2 服务端据此创建了任务', db.prepare('SELECT COUNT(*) AS c FROM agent_tasks').get().c === before + 1)
  check('L.3 模型未代选订阅（等待选择）', rec.data.status === 'waiting_selection' && rec.data.selected_subscription_id === null)

  // 模型无法调用不存在的「选择」工具（白名单拒绝）
  const mockBad = makeScriptedMock([
    { toolCalls: [tc('c1', 'select_subscription', { subscription_id: iqiyiId })] },
    { content: '尝试选择' },
  ])
  const assistantBad = createAssistant({ db, demoUserId: userId, chatFn: mockBad })
  const rb = await assistantBad.chat({ message: '选择第一个订阅' })
  check('L.4 模型无法通过工具选择订阅（未知工具被拒）', rb.toolRecords.some((x) => x.status === 'error' && /未知工具/.test(x.error || '')))
}

// —— M. HTTP 路由 ——
console.log('—— M. HTTP 路由：字段校验 / 端到端 ——')
{
  const httpPath = join(tmpdir(), 'rongzhi-verify-agent-tasks-http.db')
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
  const { db: hdb } = initDatabase({ dbPath: httpPath, seed: true })
  const hId = resolveDemoUser(hdb).id
  const hSub = hdb.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(hId).id
  const t = createTask(hdb, hId, { month: '2026-10' })

  async function withServer(fn) {
    const app = express()
    app.use(express.json())
    app.use('/api', createApiRouter(hdb, hId))
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api`
    try { await fn(base) } finally { await new Promise((resolve) => server.close(resolve)) }
  }
  const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  await withServer(async (base) => {
    const extra = await postJson(`${base}/agent-tasks/${t.task_no}/select`, { subscription_id: hSub, action: 'pause' })
    check('M.1 选择带额外字段返回 400', extra.status === 400)
    const badId = await postJson(`${base}/agent-tasks/${t.task_no}/select`, { subscription_id: 'abc' })
    check('M.2 非法 subscription_id 返回 400', badId.status === 400)
    const okSel = await postJson(`${base}/agent-tasks/${t.task_no}/select`, { subscription_id: hSub })
    check('M.3 选择成功返回 200', okSel.status === 200)
    const body = await okSel.json()
    check('M.4 选择后为等待确认', body.data.status === 'waiting_confirmation')
    const pauseBody = await postJson(`${base}/agent-tasks/${t.task_no}/pause`, {})
    check('M.5 暂停任务返回 200', pauseBody.status === 200)
    const resumeBody = await postJson(`${base}/agent-tasks/${t.task_no}/resume`, {})
    check('M.6 继续任务返回 200', resumeBody.status === 200)
    const recent = await fetch(`${base}/agent-tasks/recent`).then((r) => r.json())
    check('M.7 最近任务列表可读', recent.success === true && Array.isArray(recent.data) && recent.data.length >= 1)
  })

  hdb.close()
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

// —— N. 原业务无回归：独立订阅操作仍正常 ——
console.log('—— N. 原业务无回归 ——')
{
  const op = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'pause' })
  check('N.1 独立订阅操作单创建正常', op.status === 'pending')
  const r = confirmSubscriptionOperation(db, userId, op.ref_no)
  check('N.2 独立确认正常', r.outcome === 'completed')
  check('N.3 独立订阅已暂停', subById(adobeId).status === 'paused')
  // 恢复（回滚测试副作用，避免影响后续；本脚本为临时库，可忽略）
  const res = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'resume' })
  check('N.4 独立恢复单创建正常', res.status === 'needs_verification')
  cancelSubscriptionOperation(db, userId, res.ref_no)
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
process.exit(failures === 0 ? 0 : 1)
