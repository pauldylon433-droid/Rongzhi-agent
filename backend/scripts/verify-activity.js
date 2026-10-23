// 「业务活动聚合」验证脚本：四类记录统一列表（转账 / 银行卡 / 订阅 / 跨场景任务）的事实来源、去重、
// 排序、筛选、分页、用户隔离、只读不新增、状态变化后更新。独立临时数据库，不触碰开发库、不调用收费模型。
// 用法：node scripts/verify-activity.js [临时库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createTransfer, confirmTransfer } from '../src/services/transfers.js'
import { createCardOperation, confirmCardOperation } from '../src/services/card-operations.js'
import { createSubscriptionOperation, confirmSubscriptionOperation } from '../src/services/subscription-operations.js'
import { createTask, selectSubscription, getTask } from '../src/services/agent-tasks.js'
import { listActivity } from '../src/services/activity.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-activity.db')
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
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

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const userId = resolveDemoUser(db).id

const recipient = db.prepare('SELECT id FROM transfer_recipients ORDER BY id LIMIT 1').get()
const activeSub = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId)
const pausedSub = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'paused' ORDER BY id LIMIT 1").get(userId)
const activeCard = db.prepare("SELECT id FROM cards WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId)
if (!recipient || !activeSub || !pausedSub || !activeCard) throw new Error('种子数据不足，无法验证活动列表')

const keys = (list) => list.rows.map((r) => r.key)
const kindOf = (list, key) => list.rows.find((r) => r.key === key)

console.log('—— A. 四类记录均进入列表，且按创建时间倒序 ——')
{
  const t = createTransfer(db, userId, { recipientId: recipient.id, amountCents: 1000, remark: 'A', sessionId: null }, new Date('2026-10-20T09:00:00.000Z'))
  const c = createCardOperation(db, userId, { cardId: activeCard.id, action: 'freeze' }, new Date('2026-10-20T10:00:00.000Z'))
  const s = createSubscriptionOperation(db, userId, { subscriptionId: activeSub.id, action: 'pause' }, new Date('2026-10-20T11:00:00.000Z'))
  const tk = createTask(db, userId, { month: '2026-09', sessionId: null }, new Date('2026-10-20T12:00:00.000Z').getTime())

  const list = listActivity(db, userId, {})
  check('A.1 转账在列', keys(list).includes(`transfer:${t.ref_no}`))
  check('A.2 银行卡操作在列', keys(list).includes(`card_op:${c.ref_no}`))
  check('A.3 订阅操作在列', keys(list).includes(`subscription_op:${s.ref_no}`))
  check('A.4 跨场景任务在列', keys(list).includes(`task:${tk.task_no}`))
  check('A.5 倒序：最新（任务）在前', list.rows[0].key === `task:${tk.task_no}`, list.rows[0].key)
  check('A.6 倒序：最旧（转账）在后', list.rows[list.rows.length - 1].key === `transfer:${t.ref_no}`, list.rows[list.rows.length - 1].key)
  check('A.7 任务对象取 selected 前的空态（未选择订阅）', kindOf(list, `task:${tk.task_no}`).object === '', String(kindOf(list, `task:${tk.task_no}`).object))
}

console.log('—— B. 跨场景任务关联子操作单不重复列出 ——')
{
  const t = createTask(db, userId, { month: '2026-08', sessionId: null }, new Date('2026-10-20T13:00:00.000Z').getTime())
  const sel = selectSubscription(db, userId, t.task_no, activeSub.id)
  check('B.1 选择订阅后任务落到等待确认', sel.outcome === 'selected', sel.outcome)
  const taskAfter = getTask(db, userId, t.task_no)
  check('B.2 任务带 op_ref（关联子操作单）', !!taskAfter.op_ref, taskAfter.op_ref)

  const list = listActivity(db, userId, {})
  const hasSubOp = list.rows.some((r) => r.kind === 'subscription_op' && r.ref_no === taskAfter.op_ref)
  check('B.3 任务关联子操作单不在订阅列表（不重复计数）', hasSubOp === false)
  check('B.4 任务本身在列', list.rows.some((r) => r.kind === 'task' && r.task_no === t.task_no))
}

console.log('—— C. 筛选与分页 ——')
{
  const list = listActivity(db, userId, { type: 'subscription_op' })
  check('C.1 type 筛选只剩订阅', list.rows.every((r) => r.kind === 'subscription_op'), String(list.rows.length))

  const pending = listActivity(db, userId, { status: 'pending' })
  check('C.2 status=pending 全部为待确认', pending.rows.every((r) => r.status === 'pending') && pending.rows.length > 0, String(pending.rows.length))

  const page1 = listActivity(db, userId, { limit: 2, offset: 0 })
  const page2 = listActivity(db, userId, { limit: 2, offset: 2 })
  check('C.3 分页 limit=2 生效', page1.rows.length === 2)
  check('C.4 分页 offset 不重叠', page1.rows[0].key !== page2.rows[0].key)
  check('C.5 total 为过滤后总量', page1.total >= page1.rows.length, String(page1.total))

  const all = listActivity(db, userId, {})
  const seen = new Set()
  let dup = false
  for (const r of all.rows) { if (seen.has(r.key)) dup = true; seen.add(r.key) }
  check('C.6 键（类型+编号）全局唯一去重', dup === false)
}

console.log('—— D. 多会话 / 无 session_id 历史记录均进入（按用户归属，不猜会话） ——')
{
  const tSess = createTransfer(db, userId, { recipientId: recipient.id, amountCents: 500, remark: 'D-sess', sessionId: 'sess-xyz' }, new Date('2026-10-20T14:00:00.000Z'))
  const tNone = createTransfer(db, userId, { recipientId: recipient.id, amountCents: 600, remark: 'D-none', sessionId: null }, new Date('2026-10-20T14:01:00.000Z'))
  const cHist = createCardOperation(db, userId, { cardId: activeCard.id, action: 'freeze' }, new Date('2026-10-20T14:02:00.000Z'))
  const list = listActivity(db, userId, {})
  const keysArr = keys(list)
  check('D.1 带会话转账在列', keysArr.includes(`transfer:${tSess.ref_no}`))
  check('D.2 无会话（独立）转账在列', keysArr.includes(`transfer:${tNone.ref_no}`))
  check('D.3 无 session_id 列的银行卡历史在列', keysArr.includes(`card_op:${cHist.ref_no}`))
}

console.log('—— E. 用户隔离 ——')
{
  const otherId = db.prepare("INSERT INTO users (name) VALUES ('李四')").run().lastInsertRowid
  db.prepare(
    `INSERT INTO transfer_operations (ref_no, user_id, from_account_id, from_account_name, recipient_id, recipient_name, recipient_masked_account, amount_cents, status, risk_level, created_at, expires_at)
     VALUES ('other-ref', ?, 1, '其它账户', ?, '其它', '****', 100, 'pending', 'yellow', ?, ?)`,
  ).run(otherId, recipient.id, new Date('2026-10-20T15:00:00.000Z').toISOString(), new Date('2026-10-20T15:05:00.000Z').toISOString())
  const list = listActivity(db, userId, {})
  check('E.1 其它用户记录不出现', keys(list).includes('transfer:other-ref') === false)
}

console.log('—— F. 只读：查询不新增记录、不改变总量 ——')
{
  const before = listActivity(db, userId, {}).total
  const some = listActivity(db, userId, { type: 'transfer' }).rows[0]
  if (some) confirmTransfer(db, userId, some.ref_no) // 确认属于既有记录的状态变化，不是「查询新增」
  const after = listActivity(db, userId, {}).total
  check('F.1 读取后总量不变', before === after, `${before} -> ${after}`)
}

console.log('—— G. 状态变化后列表正确更新 ——')
{
  // 用未来时间建单并确认，避免待确认单 5 分钟有效期在验证时已过期
  const op = createSubscriptionOperation(db, userId, { subscriptionId: activeSub.id, action: 'pause' }, new Date('2026-12-01T10:00:00.000Z'))
  const p1 = listActivity(db, userId, { type: 'subscription_op' })
  const rowPending = p1.rows.find((r) => r.ref_no === op.ref_no)
  check('G.1 建单后列表显示 pending', rowPending && rowPending.status === 'pending', rowPending && rowPending.status)

  confirmSubscriptionOperation(db, userId, op.ref_no, new Date('2026-12-01T10:01:00.000Z'))
  const p2 = listActivity(db, userId, { type: 'subscription_op' })
  const rowDone = p2.rows.find((r) => r.ref_no === op.ref_no)
  check('G.2 确认后列表显示 completed', rowDone && rowDone.status === 'completed', rowDone && rowDone.status)
}

console.log('—— H. 「待确认」合并筛选（pending + waiting_confirmation）——')
{
  const tPending = createTransfer(db, userId, { recipientId: recipient.id, amountCents: 700, remark: 'H-pending', sessionId: null }, new Date('2026-12-02T10:00:00.000Z'))
  const merged = listActivity(db, userId, { status: 'pending,waiting_confirmation' })
  check('H.1 合并筛选含独立待确认操作单（pending）', merged.rows.some((r) => r.kind === 'transfer' && r.ref_no === tPending.ref_no && r.status === 'pending'))

  const waitTask = db.prepare("SELECT task_no FROM agent_tasks WHERE user_id = ? AND status = 'waiting_confirmation' ORDER BY id LIMIT 1").get(userId)
  check('H.2 合并筛选含等待确认任务（waiting_confirmation）', !!waitTask && merged.rows.some((r) => r.kind === 'task' && r.task_no === waitTask.task_no && r.status === 'waiting_confirmation'))

  check('H.3 合并筛选不含已完成', merged.rows.every((r) => r.status !== 'completed'))
  check('H.4 合并筛选每项均为待确认语义', merged.rows.every((r) => r.status === 'pending' || r.status === 'waiting_confirmation'))

  const single = listActivity(db, userId, { status: 'waiting_confirmation' })
  check('H.5 单状态 waiting_confirmation 仍精确匹配（仅任务）', single.rows.length > 0 && single.rows.every((r) => r.status === 'waiting_confirmation' && r.kind === 'task'))
}

console.log('\n共 ' + checks + ' 项检查，' + (failures === 0 ? '全部通过 ✅' : '失败 ' + failures + ' 项 ❌'))
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}
process.exit(failures === 0 ? 0 : 1)
