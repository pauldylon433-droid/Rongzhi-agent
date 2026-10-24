// 「完成同步」验证脚本：银行卡 / 订阅操作单完成（确认执行）后，清除发起该单的会话「待确认」引用，
// 与转账行为一致，避免会话保留已完成的旧「待确认」上下文。反向清除（按 ref 全局唯一）精确、不误伤其它会话。
// 独立临时数据库，不清空、不触碰开发数据库，不调用收费模型。用法：node scripts/verify-completion-sync.js [临时库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createCardOperation, confirmCardOperation } from '../src/services/card-operations.js'
import { createSubscriptionOperation, confirmSubscriptionOperation } from '../src/services/subscription-operations.js'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-completion-sync.db')
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

const activeCard = db.prepare("SELECT id FROM cards WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId)
const activeSub = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(userId)
if (!activeCard) throw new Error('种子数据缺少 active 银行卡，无法验证冻结')
if (!activeSub) throw new Error('种子数据缺少 active 订阅，无法验证暂停')

function insertSession({ cardRef = null, subRef = null }) {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO chat_sessions (id, user_id, messages_json, pending_transfer_ref, pending_card_op_ref, pending_subscription_op_ref, created_at, last_active_at)
     VALUES (?, ?, '[]', NULL, ?, ?, ?, ?)`,
  ).run(id, userId, cardRef, subRef, now, now)
  return id
}
function refs(sid) {
  return db.prepare('SELECT pending_card_op_ref AS c, pending_subscription_op_ref AS s FROM chat_sessions WHERE id = ?').get(sid)
}

// 供 C 段复用：已完成操作单的引用号与发起会话（无需第二张 active 卡）
let completedCardRef = null
let completedCardSid = null

console.log('—— A. 银行卡操作完成清除会话「待确认」引用（精确、不误伤其它会话）——')
{
  const op = createCardOperation(db, userId, { cardId: activeCard.id, action: 'freeze' })
  const sidMatch = insertSession({ cardRef: op.ref_no })
  const sidOther = insertSession({ cardRef: 'other-card-ref' })

  check('A.1 建单返回 pending', op.status === 'pending', op.status)
  check('A.2 发起会话待确认引用已指向该单', refs(sidMatch).c === op.ref_no)

  const r = confirmCardOperation(db, userId, op.ref_no)
  check('A.3 确认成功 completed', r.outcome === 'completed', r.outcome)
  check('A.4 完成后发起会话引用被清除', refs(sidMatch).c === null)
  check('A.5 其它会话不同引用不受影响', refs(sidOther).c === 'other-card-ref')

  completedCardRef = op.ref_no
  completedCardSid = sidMatch
}

console.log('—— B. 订阅操作完成清除会话「待确认」引用（精确）——')
{
  const op = createSubscriptionOperation(db, userId, { subscriptionId: activeSub.id, action: 'pause' })
  const sidMatch = insertSession({ subRef: op.ref_no })
  const sidOther = insertSession({ subRef: 'other-sub-ref' })

  check('B.1 建单返回 pending', op.status === 'pending', op.status)
  check('B.2 发起会话待确认引用已指向该单', refs(sidMatch).s === op.ref_no)

  const r = confirmSubscriptionOperation(db, userId, op.ref_no)
  check('B.3 确认成功 completed', r.outcome === 'completed', r.outcome)
  check('B.4 完成后发起会话引用被清除', refs(sidMatch).s === null)
  check('B.5 其它会话不同引用不受影响', refs(sidOther).s === 'other-sub-ref')
}

console.log('—— C. 幂等：重复确认不误清其它、不报错 ——')
{
  // 复用 A 段已完成的银行卡操作单，重复确认应幂等返回 completed，且引用保持清除
  const r2 = confirmCardOperation(db, userId, completedCardRef)
  check('C.1 重复确认幂等返回 completed', r2.outcome === 'completed', r2.outcome)
  check('C.2 重复确认后引用仍为 null（不报错、不误清）', refs(completedCardSid).c === null)
}

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
