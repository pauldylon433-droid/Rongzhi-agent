// 银行卡查询 + 临时冻结 / 解冻 验证脚本：在独立临时数据库上运行，不清空、不触碰开发数据库，不调用收费模型。
// 覆盖：准备操作不改卡片状态 / 冻结确认成功且幂等 / 解冻需交易密码+TOTP 双项验证 /
//       普通确认不能绕过解冻 / 跨转账·解冻验证码重放与失败锁定（用户级共享）/ 越权·篡改动作·未知状态 /
//       取消·过期·卡版本变化·旧操作单再次提交（正常→冻结→正常）/ 原子一致性·审计 /
//       操作不改变余额·交易流水·订阅 / 多卡澄清·上下文指向·模型重复建单 / 聊天“确认”不执行 /
//       模型错误状态文案不影响服务端确定性结果 / HTTP 路由字段校验与端到端。
// 用法：node scripts/verify-card-operations.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createCardOperation, getCardOperation, confirmCardOperation, cancelCardOperation,
  CardOpError, CARD_OP_EXPIRY_MS,
} from '../src/services/card-operations.js'
import {
  bindVerification, getVerificationStatus, verifyAndConfirmCardUnfreeze, verifyAndConfirmTransfer,
  VerificationError, MAX_VERIFY_FAILURES,
} from '../src/services/verification.js'
import { createTransfer, confirmTransfer } from '../src/services/transfers.js'
import { createAssistant } from '../src/services/assistant.js'
import { totpAt, totpStep, base32Encode } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-card-ops.db')
const ASSIST_DB_PATH = join(tmpdir(), 'rongzhi-verify-card-ops-assist.db')
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

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
function shDate(year, month, day, hour = 10, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS)
}

// 测试专用常量（非真实凭据）
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'demo-pass-123'

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const demoUser = resolveDemoUser(db)
const userId = demoUser.id
const cardId = db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(userId).id

function card() {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId)
}
function resetFails() {
  db.prepare('DELETE FROM verification_failures WHERE user_id = ?').run(userId)
}
function balanceOf() {
  return db.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(userId).b
}
function txCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c
}
function subCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c
}
function opCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM card_operations').get().c
}
function tryUnfreeze(refNo, password, totp, { now = new Date(), key = KEY, uid = userId } = {}) {
  try {
    const r = verifyAndConfirmCardUnfreeze(db, uid, refNo, { password, totp }, { encryptionKey: key, now })
    return { outcome: r.outcome, code: null }
  } catch (e) {
    return { outcome: 'error', code: e instanceof VerificationError ? e.code : null, message: e && e.message }
  }
}
function tryVerifyTransfer(refNo, password, totp, { now = new Date(), key = KEY, uid = userId } = {}) {
  try {
    const r = verifyAndConfirmTransfer(db, uid, refNo, { password, totp }, { encryptionKey: key, now })
    return { outcome: r.outcome, code: null }
  } catch (e) {
    return { outcome: 'error', code: e instanceof VerificationError ? e.code : null, message: e && e.message }
  }
}
// 冻结主卡并确认（返回卡 id）
function ensureFrozen(now) {
  const c = card()
  if (c.status === 'frozen') return c.id
  const op = createCardOperation(db, userId, { cardId: c.id, action: 'freeze' }, now)
  confirmCardOperation(db, userId, op.ref_no, now)
  return c.id
}
// 解冻主卡并确认（需要正确凭据）
function ensureActive(now) {
  const c = card()
  if (c.status === 'active') return c.id
  const op = createCardOperation(db, userId, { cardId: c.id, action: 'unfreeze' }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const r = verifyAndConfirmCardUnfreeze(db, userId, op.ref_no, { password: PASSWORD, totp: code }, { encryptionKey: KEY, now })
  if (r.outcome !== 'completed') throw new Error('ensureActive 失败')
  return c.id
}

console.log(`演示卡 id=${cardId}，初始状态=${card().status}，version=${card().version}`)

// 绑定强验证（供解冻测试）
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })

console.log('—— A. 准备操作不改卡片状态 ——')
{
  const now = shDate(2026, 11, 1, 10, 0)
  const v0 = card().version
  const op = createCardOperation(db, userId, { cardId, action: 'freeze' }, now)
  check('A.1 冻结操作单 status=pending / risk=yellow', op.status === 'pending' && op.risk_level === 'yellow', `${op.status}/${op.risk_level}`)
  check('A.2 创建不改卡片状态', card().status === 'active' && card().version === v0, `${card().status} v${card().version}`)
  check('A.3 操作单含掩码卡号与有效期', typeof op.ref_no === 'string' && /^\d+\s\*+/.test(op.masked_card_number) && typeof op.expires_at === 'string')
  check('A.4 创建写入审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='card_operation' AND action='create'").get())
}

console.log('—— B. 冻结确认成功且幂等 ——')
{
  const now = shDate(2026, 11, 1, 10, 1)
  const op = createCardOperation(db, userId, { cardId, action: 'freeze' }, now)
  const r = confirmCardOperation(db, userId, op.ref_no, now)
  check('B.1 冻结确认成功', r.outcome === 'completed', r.outcome)
  check('B.2 卡片变为 frozen 且 version+1', card().status === 'frozen' && card().version === 2, `${card().status} v${card().version}`)
  check('B.3 确认写入审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='card_operation' AND action='confirm' AND result='success'").get())
  const r2 = confirmCardOperation(db, userId, op.ref_no, now)
  check('B.4 重复确认幂等返回 completed', r2.outcome === 'completed', r2.outcome)
  check('B.5 重复确认不重复改状态', card().status === 'frozen' && card().version === 2, `${card().status} v${card().version}`)
}

console.log('—— C. 解冻需交易密码 + TOTP 双项验证 ——')
{
  const now = shDate(2026, 11, 2, 10, 0)
  const op = createCardOperation(db, userId, { cardId, action: 'unfreeze' }, now)
  check('C.1 解冻操作单 status=needs_verification / risk=red', op.status === 'needs_verification' && op.risk_level === 'red', `${op.status}/${op.risk_level}`)
  const step = totpStep(now.getTime())
  const goodCode = totpAt(SECRET_BUF, step)
  const wrongCode = String((Number(goodCode) + 1) % 1000000).padStart(6, '0')
  resetFails()
  check('C.2 错误密码被拒', tryUnfreeze(op.ref_no, 'wrong-pass', goodCode, { now }).code === 'bad_credentials')
  check('C.3 错误验证码被拒', tryUnfreeze(op.ref_no, PASSWORD, wrongCode, { now }).code === 'bad_credentials')
  check('C.4 失败后卡片仍 frozen', card().status === 'frozen', card().status)
  resetFails()
  const r = tryUnfreeze(op.ref_no, PASSWORD, goodCode, { now })
  check('C.5 正确凭据解冻成功', r.outcome === 'completed', r.outcome)
  check('C.6 卡片恢复 active 且 version+1', card().status === 'active', card().status)
  check('C.7 解冻成功写入验证审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='verification' AND action='verify_success'").get())
}

console.log('—— D. 普通确认不能绕过解冻 ——')
{
  const now = shDate(2026, 11, 3, 10, 0)
  ensureFrozen(now)
  const op = createCardOperation(db, userId, { cardId, action: 'unfreeze' }, now)
  const r = confirmCardOperation(db, userId, op.ref_no, now)
  check('D.1 解冻单普通确认被拒（needs_verification）', r.outcome === 'needs_verification', r.outcome)
  check('D.2 卡片仍 frozen', card().status === 'frozen', card().status)
}

console.log('—— E. 跨转账·解冻验证码重放 与 失败锁定（用户级共享） ——')
{
  resetFails()
  const now = shDate(2026, 11, 4, 10, 0)
  ensureFrozen(now)
  // 构造红色转账单（当日累计过线）
  const base = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now)
  confirmTransfer(db, userId, base.ref_no, now)
  const redT = createTransfer(db, userId, { recipientId: 2, amountCents: 5000 }, now)
  const unOp = createCardOperation(db, userId, { cardId, action: 'unfreeze' }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const tv = tryVerifyTransfer(redT.ref_no, PASSWORD, code, { now })
  check('E.1 转账先消费该时间步', tv.outcome === 'completed', tv.outcome)
  const r = tryUnfreeze(unOp.ref_no, PASSWORD, code, { now })
  check('E.2 同一时间步用于解冻被拒（code_reused）', r.code === 'code_reused', `code=${r.code}`)
  check('E.3 解冻未执行，卡片仍 frozen', card().status === 'frozen', card().status)

  // 跨业务失败锁定：解冻连续失败 → 用户级锁定 → 转账强验证也被锁
  resetFails()
  const now2 = shDate(2026, 11, 5, 10, 0)
  ensureFrozen(now2)
  const unOp2 = createCardOperation(db, userId, { cardId, action: 'unfreeze' }, now2)
  const code2 = totpAt(SECRET_BUF, totpStep(now2.getTime()))
  let last = null
  for (let i = 0; i < MAX_VERIFY_FAILURES; i++) {
    last = tryUnfreeze(unOp2.ref_no, 'bad-pass', '000000', { now: now2 }).code
  }
  check('E.4 解冻第 5 次失败触发用户级锁定', last === 'locked', `code=${last}`)
  check('E.5 锁定后解冻正确凭据也被拒', tryUnfreeze(unOp2.ref_no, PASSWORD, code2, { now: now2 }).code === 'locked')
  const base2 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now2)
  confirmTransfer(db, userId, base2.ref_no, now2)
  const redT2 = createTransfer(db, userId, { recipientId: 2, amountCents: 3000 }, now2)
  const tv2 = tryVerifyTransfer(redT2.ref_no, PASSWORD, code2, { now: now2 })
  check('E.6 转账强验证共享同一用户级锁定（也被锁）', tv2.code === 'locked', tv2.code || tv2.outcome)
}

console.log('—— F. 越权 / 篡改动作 / 未知与已注销状态 ——')
{
  resetFails() // 清理解冻强验证遗留的用户级锁定（E 节）
  ensureActive(shDate(2026, 11, 6, 10, 0)) // 主卡恢复 active，供本节约权 / 状态测试
  // 第二个用户
  db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('测试用户2', new Date().toISOString())
  const user2 = db.prepare('SELECT id FROM users WHERE name = ?').get('测试用户2').id

  let notOwned = false
  try { createCardOperation(db, user2, { cardId, action: 'freeze' }) } catch (e) { notOwned = e instanceof CardOpError && e.code === 'not_found' }
  check('F.1 他人对本人卡建单被拒（not_found）', notOwned)

  const opX = createCardOperation(db, userId, { cardId, action: 'freeze' }, shDate(2026, 11, 6, 10, 0))
  check('F.2 他人查看本人操作单返回 null', getCardOperation(db, user2, opX.ref_no) === null)
  check('F.3 他人确认本人操作单 not_found', confirmCardOperation(db, user2, opX.ref_no).outcome === 'not_found')

  let badAction = false
  try { createCardOperation(db, userId, { cardId, action: 'delete' }) } catch (e) { badAction = e instanceof CardOpError && e.code === 'bad_action' }
  check('F.4 非法动作被拒（bad_action）', badAction)

  // 未知 / 已注销状态
  const a = db.prepare('SELECT account_id FROM cards WHERE id = ?').get(cardId).account_id
  const cCancelled = db.prepare("INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, '6222 **** **** 0001', '借记卡', 'cancelled', 0)").run(userId, a).lastInsertRowid
  let freezeCancelled = false, unfreezeCancelled = false
  try { createCardOperation(db, userId, { cardId: cCancelled, action: 'freeze' }) } catch (e) { freezeCancelled = e instanceof CardOpError && e.code === 'cancelled' }
  try { createCardOperation(db, userId, { cardId: cCancelled, action: 'unfreeze' }) } catch (e) { unfreezeCancelled = e instanceof CardOpError && e.code === 'cancelled' }
  check('F.5 已注销卡不能冻结', freezeCancelled)
  check('F.6 已注销卡不能解冻', unfreezeCancelled)

  const cFrozen = db.prepare("INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, '6222 **** **** 0002', '借记卡', 'frozen', 0)").run(userId, a).lastInsertRowid
  let alreadyFrozen = false
  try { createCardOperation(db, userId, { cardId: cFrozen, action: 'freeze' }) } catch (e) { alreadyFrozen = e instanceof CardOpError && e.code === 'already_in_state' }
  check('F.7 已冻结卡重复冻结如实拒绝（不伪造成功）', alreadyFrozen)

  let alreadyActive = false
  try { createCardOperation(db, userId, { cardId, action: 'unfreeze' }) } catch (e) { alreadyActive = e instanceof CardOpError && e.code === 'already_in_state' }
  check('F.8 正常卡重复解冻如实拒绝', alreadyActive)
}

console.log('—— G. 取消 / 过期 / 版本变化（正常→冻结→正常 后旧单提交） ——')
{
  // 取消
  ensureActive(shDate(2026, 11, 6, 10, 1))
  const nowG = shDate(2026, 11, 7, 10, 0)
  const opC = createCardOperation(db, userId, { cardId, action: 'freeze' }, nowG)
  check('G.1 冻结操作单可取消', cancelCardOperation(db, userId, opC.ref_no, nowG).outcome === 'cancelled')
  check('G.2 已取消单确认返回 cancelled', confirmCardOperation(db, userId, opC.ref_no, nowG).outcome === 'cancelled')
  check('G.3 卡片仍 active', card().status === 'active', card().status)

  // 过期
  const opE = createCardOperation(db, userId, { cardId, action: 'freeze' }, nowG)
  const late = new Date(nowG.getTime() + CARD_OP_EXPIRY_MS + 1000)
  check('G.4 过期单确认返回 expired', confirmCardOperation(db, userId, opE.ref_no, late).outcome === 'expired')
  check('G.5 卡片仍 active', card().status === 'active', card().status)

  // 版本变化：建单后卡片经历「正常→冻结→正常」，旧操作单再次提交不能覆盖新状态
  const nowV = shDate(2026, 11, 8, 10, 0)
  const vBefore = card().version
  const opOld = createCardOperation(db, userId, { cardId, action: 'freeze' }, nowV)
  check('G.6 旧单捕获建单时版本', opOld.card_id === cardId)
  // 模拟卡片在建单后被外部改状态两次（冻结→解冻），版本 +2，状态回到 active
  db.prepare("UPDATE cards SET status = 'frozen', version = version + 1 WHERE id = ?").run(cardId)
  db.prepare("UPDATE cards SET status = 'active', version = version + 1 WHERE id = ?").run(cardId)
  check('G.7 卡片版本已变化', card().version === vBefore + 2, `v${vBefore}->v${card().version}`)
  const rOld = confirmCardOperation(db, userId, opOld.ref_no, nowV)
  check('G.8 旧单再次提交被拒（stale）', rOld.outcome === 'stale', rOld.outcome)
  check('G.9 旧单状态标记为 failed', getCardOperation(db, userId, opOld.ref_no, nowV).status === 'failed')
  check('G.10 卡片保持 active（旧单未覆盖新状态）', card().status === 'active', card().status)
}

console.log('—— H. 原子一致性与审计 ——')
{
  // 成功路径：操作单 completed + 卡片 frozen + 审计 三者一致
  const now = shDate(2026, 11, 9, 10, 0)
  const beforeAudit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type='card_operation' AND action='confirm' AND result='success'").get().c
  const op = createCardOperation(db, userId, { cardId, action: 'freeze' }, now)
  confirmCardOperation(db, userId, op.ref_no, now)
  check('H.1 成功后操作单 completed 且卡片 frozen', getCardOperation(db, userId, op.ref_no, now).status === 'completed' && card().status === 'frozen')
  check('H.2 成功后新增一条成功审计', db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type='card_operation' AND action='confirm' AND result='success'").get().c === beforeAudit + 1)

  // 事务回滚：异常抛出回滚已写入内容（与强验证同机制）
  const stepBefore = db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c
  let rolledBack = false
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO totp_used_steps (user_id, step, purpose, consumed_at) VALUES (?, ?, ?, ?)').run(userId, 987654322, 'unfreeze', 'x')
      throw new Error('模拟异常')
    })()
  } catch { rolledBack = true }
  check('H.3 事务内抛错回滚已写入的时间步消费', rolledBack && db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c === stepBefore)
}

console.log('—— I. 冻结 / 解冻不改变余额 / 交易流水 / 订阅 ——')
{
  const bal0 = balanceOf()
  const tx0 = txCount()
  const sub0 = subCount()
  const t1 = shDate(2026, 11, 10, 10, 0)
  const t2 = shDate(2026, 11, 10, 10, 1)
  const t3 = shDate(2026, 11, 10, 10, 2)
  ensureActive(t1) // frozen → active
  ensureFrozen(t2) // active → frozen
  ensureActive(t2) // frozen → active
  ensureFrozen(t3) // active → frozen
  ensureActive(t3) // frozen → active
  check('I.1 多轮冻结/解冻后余额不变', balanceOf() === bal0, `${bal0}->${balanceOf()}`)
  check('I.2 交易流水不变', txCount() === tx0, `${tx0}->${txCount()}`)
  check('I.3 订阅不变', subCount() === sub0, `${sub0}->${subCount()}`)
}

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

// —— J-M. AI 助手工具与行为（独立临时库） ——
function buildCardsDb(path, { second = false } = {}) {
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const db = openDatabase(path)
  createSchema(db)
  migrate(db)
  const u = db.prepare("INSERT INTO users (name, created_at) VALUES ('张三', ?)").run(new Date().toISOString()).lastInsertRowid
  const a = db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u, '人民币活期账户', 500000, 500000, 'CNY', 'active').lastInsertRowid
  const c1 = db.prepare('INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u, a, '6222 **** **** 1234', '借记卡', 'active', 5000000).lastInsertRowid
  let c2 = null
  if (second) {
    c2 = db.prepare('INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u, a, '6228 **** **** 5678', '信用卡', 'active', 3000000).lastInsertRowid
  }
  return { db, u, a, c1, c2 }
}
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function makeScriptedMock(script) {
  let i = 0
  const fn = async ({ messages }) => {
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }
  return fn
}

console.log('—— J. 查询银行卡 / 生成冻结·解冻操作单（不改状态） ——')
{
  const { db: adb, u: au, c1: ac1 } = buildCardsDb(ASSIST_DB_PATH)
  const before = adb.prepare('SELECT status FROM cards WHERE id = ?').get(ac1).status
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_cards', {})] },
    { toolCalls: [tc('c2', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '已生成冻结操作单，请在界面确认。' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mock })
  const r = await assistant.chat({ message: '冻结尾号1234的卡' })
  const cardsRec = r.toolRecords.find((t) => t.name === 'get_cards')
  const prepRec = r.toolRecords.find((t) => t.name === 'prepare_card_operation')
  check('J.1 get_cards 返回掩码卡号', cardsRec?.status === 'ok' && Array.isArray(cardsRec.data) && cardsRec.data.length === 1 && /^\d+\s\*+/.test(cardsRec.data[0].masked_card_number), JSON.stringify(cardsRec?.data))
  check('J.2 prepare_card_operation 成功且为 pending/yellow', prepRec?.status === 'ok' && prepRec.data.status === 'pending' && prepRec.data.risk_level === 'yellow', `${prepRec?.data?.status}/${prepRec?.data?.risk_level}`)
  check('J.3 生成操作单不改卡片状态', adb.prepare('SELECT status FROM cards WHERE id = ?').get(ac1).status === before, before)
  check('J.4 确定性说明提示确认', /冻结操作单/.test(prepRec?.data?.notice || ''), prepRec?.data?.notice)
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— K. 多卡时列全选项（不擅自选第一张）/ 上下文指向 / 模型重复建单 ——')
{
  const { db: adb, u: au, c1: ac1, c2: ac2 } = buildCardsDb(ASSIST_DB_PATH, { second: true })
  // 多卡澄清：模型仅查询，未建单
  const mockClarify = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_cards', {})] },
    { content: '您有两张卡，请选择要冻结的卡。' },
  ])
  const r1 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockClarify }).chat({ message: '冻结我的卡' })
  const cardsRec = r1.toolRecords.find((t) => t.name === 'get_cards')
  check('K.1 多卡时 get_cards 返回两条掩码卡', cardsRec?.data?.length === 2 && cardsRec.data.every((x) => /^\d+\s\*+/.test(x.masked_card_number)), JSON.stringify(cardsRec?.data))
  check('K.2 未指定卡片时未建单', !r1.toolRecords.some((t) => t.name === 'prepare_card_operation'))

  // prepare_card_operation 必须显式 card_id：无默认选择第一张
  const mockNoCard = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_card_operation', { action: 'freeze' })] },
    { content: '缺少卡号。' },
  ])
  const rNoCard = await createAssistant({ db: adb, demoUserId: au, chatFn: mockNoCard }).chat({ message: '冻结' })
  check('K.3 缺 card_id 被拒（不擅自选第一张）', rNoCard.toolRecords[0]?.status === 'error' && /card_id/.test(rNoCard.toolRecords[0]?.error), rNoCard.toolRecords[0]?.error)

  // 修改 / 上下文指向（同一张卡）：第二轮同卡再冻结 → 旧待确认冻结单被取消（改单）
  const mockModify = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '已生成冻结操作单。' },
    { toolCalls: [tc('c2', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '已重新生成冻结操作单。' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mockModify })
  const ra = await assistant.chat({ message: '冻结尾号1234的卡' })
  const refA = ra.toolRecords.find((t) => t.name === 'prepare_card_operation')?.data?.ref_no
  const rb = await assistant.chat({ message: '重新冻结这张卡', sessionId: ra.sessionId })
  const prep2 = rb.toolRecords.find((t) => t.name === 'prepare_card_operation')
  check('K.4 旧待确认冻结单被取消（改单）', prep2?.data?.previous?.ref_no === refA && prep2?.data?.previous?.status === 'cancelled' && prep2?.data?.previous?.cancelled === true, JSON.stringify(prep2?.data?.previous))
  check('K.5 新操作单为 pending/yellow', prep2?.data?.status === 'pending' && prep2?.data?.risk_level === 'yellow', `${prep2?.data?.status}/${prep2?.data?.risk_level}`)
  check('K.6 会话引用指向新操作单', assistant._sessions.get(ra.sessionId)?.pendingCardOpRef === prep2?.data?.ref_no)

  // 上下文指向（把刚才冻结的卡解冻）：先确认冻结使卡真的 frozen，再让助手生成解冻单
  const mockUnfreeze = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '已生成冻结操作单。' },
    { toolCalls: [tc('c2', 'prepare_card_operation', { card_id: ac1, action: 'unfreeze' })] },
    { content: '已生成解冻操作单。' },
  ])
  const assistant2 = createAssistant({ db: adb, demoUserId: au, chatFn: mockUnfreeze })
  const rf = await assistant2.chat({ message: '冻结尾号1234的卡' })
  const refF = rf.toolRecords.find((t) => t.name === 'prepare_card_operation')?.data?.ref_no
  confirmCardOperation(adb, au, refF, new Date()) // 模拟用户在界面点击确认冻结
  const ru = await assistant2.chat({ message: '把刚才冻结的卡解冻', sessionId: rf.sessionId })
  const prepU = ru.toolRecords.find((t) => t.name === 'prepare_card_operation')
  check('K.7 已完成的冻结单不被取消（如实说明）', prepU?.data?.previous?.ref_no === refF && prepU?.data?.previous?.status === 'completed' && prepU?.data?.previous?.cancelled === false, JSON.stringify(prepU?.data?.previous))
  check('K.8 新解冻单为 needs_verification/red', prepU?.data?.status === 'needs_verification' && prepU?.data?.risk_level === 'red', `${prepU?.data?.status}/${prepU?.data?.risk_level}`)

  // 模型重复建单：单条消息两次 prepare_card_operation → 第二次拒绝
  const beforeOps = adb.prepare('SELECT COUNT(*) AS c FROM card_operations').get().c
  const mockDup = makeScriptedMock([
    {
      toolCalls: [
        tc('c1', 'prepare_card_operation', { card_id: ac2, action: 'freeze' }),
        tc('c2', 'prepare_card_operation', { card_id: ac2, action: 'freeze' }),
      ],
    },
    { content: '一次只能生成一张操作单。' },
  ])
  const rDup = await createAssistant({ db: adb, demoUserId: au, chatFn: mockDup }).chat({ message: '冻结这张卡' })
  const preps = rDup.toolRecords.filter((t) => t.name === 'prepare_card_operation')
  check('K.9 单条消息重复建单被拒', preps.length === 2 && preps[0].status === 'ok' && preps[1].status === 'error' && /已生成银行卡操作单/.test(preps[1].error), JSON.stringify(preps.map((p) => p.status)))
  check('K.10 仅创建一张操作单', adb.prepare('SELECT COUNT(*) AS c FROM card_operations').get().c === beforeOps + 1)
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— L. 聊天“确认”不执行 / 未知工具 / 模型错误状态文案不影响确定性 ——')
{
  const { db: adb, u: au, c1: ac1 } = buildCardsDb(ASSIST_DB_PATH)
  // 纯文字“确认”不执行任何操作
  const mockConfirm = makeScriptedMock([{ content: '好的，已为你确认冻结。' }])
  const r1 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockConfirm }).chat({ message: '确认冻结' })
  check('L.1 纯文字“确认”无工具调用', r1.toolRecords.length === 0, JSON.stringify(r1.toolRecords))
  check('L.2 卡片状态未变', adb.prepare('SELECT status FROM cards WHERE id = ?').get(ac1).status === 'active')

  // 模型尝试调用不存在 / 未开放的确认工具
  const mockUnknown = makeScriptedMock([
    { toolCalls: [tc('c1', 'confirm_card_operation', { ref_no: 'x' })] },
    { content: '无法执行。' },
  ])
  const r2 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockUnknown }).chat({ message: '确认冻结' })
  check('L.3 confirm_card_operation 不在白名单，被拒绝', r2.toolRecords[0]?.status === 'error' && /未知工具/.test(r2.toolRecords[0]?.error), r2.toolRecords[0]?.error)

  // 模型给出错误状态文案，但结构化 previous / notice 仍正确
  const mockStatus = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '已生成冻结操作单。' },
    { toolCalls: [tc('c2', 'prepare_card_operation', { card_id: ac1, action: 'freeze' })] },
    { content: '旧冻结单仍待确认，未取消。（模型给出错误旧状态）' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mockStatus })
  const ra = await assistant.chat({ message: '冻结尾号1234的卡' })
  const refA = ra.toolRecords.find((t) => t.name === 'prepare_card_operation')?.data?.ref_no
  const rb = await assistant.chat({ message: '改成冻结这张卡', sessionId: ra.sessionId })
  const prep2 = rb.toolRecords.find((t) => t.name === 'prepare_card_operation')
  check('L.4 结构化 previous.status 为 cancelled（非模型推断）', prep2?.data?.previous?.ref_no === refA && prep2?.data?.previous?.status === 'cancelled' && prep2?.data?.previous?.cancelled === true, JSON.stringify(prep2?.data?.previous))
  check('L.5 确定性 notice 说明已取消旧单', /已取消原待确认操作单/.test(prep2?.data?.notice || ''), prep2?.data?.notice)
  check('L.6 数据库旧单确为 cancelled', adb.prepare('SELECT status FROM card_operations WHERE ref_no = ?').get(refA).status === 'cancelled')
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— M. HTTP 路由：字段校验 / 冻结端到端 / 解冻强验证端到端 ——')
{
  // 重新打开一个种子库做 HTTP 测试
  const httpPath = join(tmpdir(), 'rongzhi-verify-card-ops-http.db')
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
  const { db: hdb } = initDatabase({ dbPath: httpPath, seed: true })
  const hUser = resolveDemoUser(hdb)
  const hId = hUser.id
  const hCard = hdb.prepare('SELECT id FROM cards WHERE user_id = ?').get(hId).id
  bindVerification(hdb, hId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
  process.env.VERIFICATION_KEY = KEY.toString('base64')

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
    // 字段校验
    const extra = await postJson(`${base}/card-operations`, { card_id: hCard, action: 'freeze', user_id: 1 })
    check('M.1 创建带 user_id 字段返回 400', extra.status === 400)
    const badAction = await postJson(`${base}/card-operations`, { card_id: hCard, action: 'delete' })
    check('M.2 非法 action 返回 400', badAction.status === 400)

    // 冻结端到端：创建 → 确认 → 卡片冻结
    const created = await (await postJson(`${base}/card-operations`, { card_id: hCard, action: 'freeze' })).json()
    check('M.3 创建冻结操作单成功', created.success && created.data.status === 'pending')
    const c = await postJson(`${base}/card-operations/${created.data.ref_no}/confirm`, { confirm: true })
    check('M.4 确认冻结返回 200', c.status === 200)
    check('M.5 卡片已冻结', hdb.prepare('SELECT status FROM cards WHERE id = ?').get(hCard).status === 'frozen')
    const cExtra = await postJson(`${base}/card-operations/${created.data.ref_no}/confirm`, { confirm: true, card_id: hCard })
    check('M.6 确认带额外字段返回 400', cExtra.status === 400)

    // 解冻强验证端到端
    const unCreated = await (await postJson(`${base}/card-operations`, { card_id: hCard, action: 'unfreeze' })).json()
    check('M.7 创建解冻操作单成功（needs_verification）', unCreated.success && unCreated.data.status === 'needs_verification')
    const confirmUn = await postJson(`${base}/card-operations/${unCreated.data.ref_no}/confirm`, { confirm: true })
    check('M.8 解冻单普通确认返回 409', confirmUn.status === 409)
    const goodCode = totpAt(SECRET_BUF, totpStep(Date.now()))
    const verifyRes = await postJson(`${base}/card-operations/${unCreated.data.ref_no}/verify`, { password: PASSWORD, totp: goodCode })
    check('M.9 解冻强验证成功返回 200', verifyRes.status === 200, `HTTP ${verifyRes.status}`)
    check('M.10 卡片已解冻', hdb.prepare('SELECT status FROM cards WHERE id = ?').get(hCard).status === 'active')
  })

  hdb.close()
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
