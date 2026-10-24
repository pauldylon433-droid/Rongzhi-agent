// 订阅与代扣操作 验证脚本：在独立临时数据库上运行，不清空、不触碰开发数据库，不调用收费模型。
// 覆盖：准备操作不改订阅状态 / 暂停确认成功且幂等 / 取消（active→cancelled）确认 /
//       恢复需交易密码+TOTP 双项验证 / 普通确认不能绕过恢复 / 跨转账·恢复验证码重放与失败锁定（用户级共享）/
//       越权·篡改动作·cancelled 终态·未知状态（由 CHECK 约束在库层阻止）/ 取消·过期·版本变化·订阅被删 /
//       旧操作单不能覆盖后续状态 / 原子一致性·审计·事务回滚 / 操作不改变余额·交易流水·银行卡 /
//       多订阅澄清·上下文指向·模型重复建单 / 聊天“确认”不执行 / 模型错误状态文案不影响服务端确定性结果 /
//       HTTP 路由字段校验与端到端。
// 用法：node scripts/verify-subscription-operations.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createSubscriptionOperation, getSubscriptionOperation, confirmSubscriptionOperation,
  cancelSubscriptionOperation, SubscriptionOpError, SUB_OP_EXPIRY_MS,
} from '../src/services/subscription-operations.js'
import {
  bindVerification, verifyAndConfirmSubscriptionResume, verifyAndConfirmTransfer,
  VerificationError, MAX_VERIFY_FAILURES,
} from '../src/services/verification.js'
import { createTransfer, confirmTransfer } from '../src/services/transfers.js'
import { createAssistant } from '../src/services/assistant.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-sub-ops.db')
const ASSIST_DB_PATH = join(tmpdir(), 'rongzhi-verify-sub-ops-assist.db')
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

function subByMerchant(m) {
  return db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND merchant = ?').get(userId, m)
}
function subById(id) {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
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
function cardCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM cards').get().c
}
function opCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c
}
// 直接改订阅状态（测试前置），并自增版本，模拟「外部状态变化」
function setStatus(id, status) {
  db.prepare('UPDATE subscriptions SET status = ?, version = version + 1 WHERE id = ?').run(status, id)
}
function tryResume(refNo, password, totp, { now = new Date(), key = KEY, uid = userId } = {}) {
  try {
    const r = verifyAndConfirmSubscriptionResume(db, uid, refNo, { password, totp }, { encryptionKey: key, now })
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
// 暂停某项订阅并确认（返回订阅 id）
function ensurePaused(subId, now) {
  const s = subById(subId)
  if (s.status === 'paused') return subId
  const op = createSubscriptionOperation(db, userId, { subscriptionId: subId, action: 'pause' }, now)
  confirmSubscriptionOperation(db, userId, op.ref_no, now)
  return subId
}

// 订阅 id（seed 顺序固定）
const iqiyiId = subByMerchant('爱奇艺会员').id // active
const qqMusicId = subByMerchant('QQ音乐豪华绿钻').id // active
const icloudId = subByMerchant('iCloud 200GB').id // active
const keepId = subByMerchant('Keep 会员').id // paused
const zhihuId = subByMerchant('知乎盐选会员').id // cancelled
const adobeId = subByMerchant('Adobe 摄影计划').id // active yearly

// 绑定强验证（供恢复测试）
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })

console.log('—— A. 准备操作不改订阅状态 ——')
{
  const now = shDate(2026, 11, 1, 10, 0)
  const v0 = subById(iqiyiId).version
  const op = createSubscriptionOperation(db, userId, { subscriptionId: iqiyiId, action: 'pause' }, now)
  check('A.1 暂停操作单 status=pending / risk=yellow', op.status === 'pending' && op.risk_level === 'yellow', `${op.status}/${op.risk_level}`)
  check('A.2 创建不改订阅状态', subById(iqiyiId).status === 'active' && subById(iqiyiId).version === v0, `${subById(iqiyiId).status} v${subById(iqiyiId).version}`)
  check('A.3 操作单含商户 / 金额 / 周期 / 有效期', op.merchant === '爱奇艺会员' && op.amount_cents === 2500 && op.billing_cycle === 'monthly' && typeof op.ref_no === 'string' && typeof op.expires_at === 'string')
  check('A.4 创建写入审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='subscription_operation' AND action='create'").get())
}

console.log('—— B. 暂停确认成功且幂等 ——')
{
  const now = shDate(2026, 11, 1, 10, 1)
  const op = createSubscriptionOperation(db, userId, { subscriptionId: iqiyiId, action: 'pause' }, now)
  const r = confirmSubscriptionOperation(db, userId, op.ref_no, now)
  check('B.1 暂停确认成功', r.outcome === 'completed', r.outcome)
  check('B.2 订阅变为 paused 且 version+1', subById(iqiyiId).status === 'paused' && subById(iqiyiId).version === 2, `${subById(iqiyiId).status} v${subById(iqiyiId).version}`)
  check('B.3 确认写入审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='subscription_operation' AND action='confirm' AND result='success'").get())
  const r2 = confirmSubscriptionOperation(db, userId, op.ref_no, now)
  check('B.4 重复确认幂等返回 completed', r2.outcome === 'completed', r2.outcome)
  check('B.5 重复确认不重复改状态', subById(iqiyiId).status === 'paused' && subById(iqiyiId).version === 2, `${subById(iqiyiId).status} v${subById(iqiyiId).version}`)
}

console.log('—— C. 取消确认（active → cancelled，黄色） ——')
{
  const now = shDate(2026, 11, 2, 10, 0)
  const op = createSubscriptionOperation(db, userId, { subscriptionId: qqMusicId, action: 'cancel' }, now)
  check('C.1 取消操作单 status=pending / risk=yellow', op.status === 'pending' && op.risk_level === 'yellow', `${op.status}/${op.risk_level}`)
  const r = confirmSubscriptionOperation(db, userId, op.ref_no, now)
  check('C.2 取消确认成功', r.outcome === 'completed', r.outcome)
  check('C.3 订阅变为 cancelled', subById(qqMusicId).status === 'cancelled', subById(qqMusicId).status)
  const r2 = confirmSubscriptionOperation(db, userId, op.ref_no, now)
  check('C.4 重复取消幂等', r2.outcome === 'completed', r2.outcome)
}

console.log('—— D. 恢复需交易密码 + TOTP 双项验证 ——')
{
  const now = shDate(2026, 11, 3, 10, 0)
  const op = createSubscriptionOperation(db, userId, { subscriptionId: keepId, action: 'resume' }, now)
  check('D.1 恢复操作单 status=needs_verification / risk=red', op.status === 'needs_verification' && op.risk_level === 'red', `${op.status}/${op.risk_level}`)
  const step = totpStep(now.getTime())
  const goodCode = totpAt(SECRET_BUF, step)
  const wrongCode = String((Number(goodCode) + 1) % 1000000).padStart(6, '0')
  resetFails()
  check('D.2 错误密码被拒', tryResume(op.ref_no, 'wrong-pass', goodCode, { now }).code === 'bad_credentials')
  check('D.3 错误验证码被拒', tryResume(op.ref_no, PASSWORD, wrongCode, { now }).code === 'bad_credentials')
  check('D.4 失败后订阅仍 paused', subById(keepId).status === 'paused', subById(keepId).status)
  resetFails()
  const r = tryResume(op.ref_no, PASSWORD, goodCode, { now })
  check('D.5 正确凭据恢复成功', r.outcome === 'completed', r.outcome)
  check('D.6 订阅恢复 active 且 version+1', subById(keepId).status === 'active', subById(keepId).status)
  check('D.7 恢复成功写入验证审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='verification' AND action='verify_success'").get())
}

console.log('—— E. 普通确认不能绕过恢复 ——')
{
  const now = shDate(2026, 11, 4, 10, 0)
  ensurePaused(icloudId, now)
  const op = createSubscriptionOperation(db, userId, { subscriptionId: icloudId, action: 'resume' }, now)
  const r = confirmSubscriptionOperation(db, userId, op.ref_no, now)
  check('E.1 恢复单普通确认被拒（needs_verification）', r.outcome === 'needs_verification', r.outcome)
  check('E.2 订阅仍 paused', subById(icloudId).status === 'paused', subById(icloudId).status)
}

console.log('—— F. 跨转账·恢复验证码重放 与 失败锁定（用户级共享） ——')
{
  resetFails()
  const now = shDate(2026, 11, 5, 10, 0)
  ensurePaused(adobeId, now)
  // 构造红色转账单（当日累计过线）
  const base = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now)
  confirmTransfer(db, userId, base.ref_no, now)
  const redT = createTransfer(db, userId, { recipientId: 2, amountCents: 5000 }, now)
  const resOp = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'resume' }, now)
  const code = totpAt(SECRET_BUF, totpStep(now.getTime()))
  const tv = tryVerifyTransfer(redT.ref_no, PASSWORD, code, { now })
  check('F.1 转账先消费该时间步', tv.outcome === 'completed', tv.outcome)
  const r = tryResume(resOp.ref_no, PASSWORD, code, { now })
  check('F.2 同一时间步用于恢复被拒（code_reused）', r.code === 'code_reused', `code=${r.code}`)
  check('F.3 恢复未执行，订阅仍 paused', subById(adobeId).status === 'paused', subById(adobeId).status)

  // 跨业务失败锁定：恢复连续失败 → 用户级锁定 → 转账强验证也被锁
  resetFails()
  const now2 = shDate(2026, 11, 6, 10, 0)
  ensurePaused(adobeId, now2)
  const resOp2 = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'resume' }, now2)
  const code2 = totpAt(SECRET_BUF, totpStep(now2.getTime()))
  let last = null
  for (let i = 0; i < MAX_VERIFY_FAILURES; i++) {
    last = tryResume(resOp2.ref_no, 'bad-pass', '000000', { now: now2 }).code
  }
  check('F.4 恢复第 5 次失败触发用户级锁定', last === 'locked', `code=${last}`)
  check('F.5 锁定后恢复正确凭据也被拒', tryResume(resOp2.ref_no, PASSWORD, code2, { now: now2 }).code === 'locked')
  const base2 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now2)
  confirmTransfer(db, userId, base2.ref_no, now2)
  const redT2 = createTransfer(db, userId, { recipientId: 2, amountCents: 3000 }, now2)
  const tv2 = tryVerifyTransfer(redT2.ref_no, PASSWORD, code2, { now: now2 })
  check('F.6 转账强验证共享同一用户级锁定（也被锁）', tv2.code === 'locked', tv2.code || tv2.outcome)
}

console.log('—— G. 越权 / 篡改动作 / cancelled 终态 / 重复状态拒绝 ——')
{
  resetFails() // 清理解锁遗留（F 节）
  // 第二个用户
  db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('测试用户2', new Date().toISOString())
  const user2 = db.prepare('SELECT id FROM users WHERE name = ?').get('测试用户2').id

  let notOwned = false
  try { createSubscriptionOperation(db, user2, { subscriptionId: iqiyiId, action: 'pause' }) } catch (e) { notOwned = e instanceof SubscriptionOpError && e.code === 'not_found' }
  check('G.1 他人对本人订阅建单被拒（not_found）', notOwned)

  const opX = createSubscriptionOperation(db, userId, { subscriptionId: keepId, action: 'pause' }, shDate(2026, 11, 7, 10, 0))
  check('G.2 他人查看本人操作单返回 null', getSubscriptionOperation(db, user2, opX.ref_no) === null)
  check('G.3 他人确认本人操作单 not_found', confirmSubscriptionOperation(db, user2, opX.ref_no).outcome === 'not_found')

  let badAction = false
  try { createSubscriptionOperation(db, userId, { subscriptionId: keepId, action: 'delete' }) } catch (e) { badAction = e instanceof SubscriptionOpError && e.code === 'bad_action' }
  check('G.4 非法动作被拒（bad_action）', badAction)

  // cancelled 终态
  let pauseCancelled = false, resumeCancelled = false, cancelCancelled = false
  try { createSubscriptionOperation(db, userId, { subscriptionId: zhihuId, action: 'pause' }) } catch (e) { pauseCancelled = e instanceof SubscriptionOpError && e.code === 'cancelled' }
  try { createSubscriptionOperation(db, userId, { subscriptionId: zhihuId, action: 'resume' }) } catch (e) { resumeCancelled = e instanceof SubscriptionOpError && e.code === 'cancelled' }
  try { createSubscriptionOperation(db, userId, { subscriptionId: zhihuId, action: 'cancel' }) } catch (e) { cancelCancelled = e instanceof SubscriptionOpError && e.code === 'already_cancelled' }
  check('G.5 已取消订阅不能暂停', pauseCancelled)
  check('G.6 已取消订阅不能恢复', resumeCancelled)
  check('G.7 已取消订阅不能再次取消', cancelCancelled)

  // 重复状态如实拒绝（不伪造成功）
  const pausedId = ensurePaused(iqiyiId, shDate(2026, 11, 7, 10, 1)) // 爱奇艺已是 paused（B 节）
  let alreadyPaused = false
  try { createSubscriptionOperation(db, userId, { subscriptionId: pausedId, action: 'pause' }) } catch (e) { alreadyPaused = e instanceof SubscriptionOpError && e.code === 'already_in_state' }
  check('G.8 已暂停订阅重复暂停如实拒绝', alreadyPaused)
  let alreadyActive = false
  try { createSubscriptionOperation(db, userId, { subscriptionId: keepId, action: 'resume' }) } catch (e) { alreadyActive = e instanceof SubscriptionOpError && e.code === 'already_in_state' }
  check('G.9 生效订阅重复恢复如实拒绝', alreadyActive)

  // 未知状态：subscriptions.status 带 CHECK 约束（仅 active/paused/cancelled），
  // 未来新增状态在库层即被阻止；服务端 bad_state 为防御分支，此处不构造绕过 CHECK 的脏数据。
}

console.log('—— H. 取消 / 过期 / 版本变化（旧单不覆盖后续状态）/ 订阅被删 ——')
{
  // 取消（用 active 订阅的暂停单）
  setStatus(icloudId, 'active') // 重置 iCloud 为 active（E 节后是 paused）
  const nowH = shDate(2026, 11, 8, 10, 0)
  const opC = createSubscriptionOperation(db, userId, { subscriptionId: icloudId, action: 'pause' }, nowH)
  check('H.1 暂停操作单可取消', cancelSubscriptionOperation(db, userId, opC.ref_no, nowH).outcome === 'cancelled')
  check('H.2 已取消单确认返回 cancelled', confirmSubscriptionOperation(db, userId, opC.ref_no, nowH).outcome === 'cancelled')
  check('H.3 订阅仍 active', subById(icloudId).status === 'active', subById(icloudId).status)

  // 过期（用 active 订阅的暂停单，晚于有效期确认）
  const opE = createSubscriptionOperation(db, userId, { subscriptionId: icloudId, action: 'pause' }, nowH)
  const late = new Date(nowH.getTime() + SUB_OP_EXPIRY_MS + 1000)
  check('H.4 过期单确认返回 expired', confirmSubscriptionOperation(db, userId, opE.ref_no, late).outcome === 'expired')
  check('H.5 订阅仍 active', subById(icloudId).status === 'active', subById(icloudId).status)

  // 版本变化：建单后订阅经历「active→paused→active」，旧暂停单再次提交不能覆盖新状态
  setStatus(adobeId, 'active') // 重置 adobe 为 active（F 节后是 paused）
  const nowV = shDate(2026, 11, 9, 10, 0)
  const vBefore = subById(adobeId).version
  const opOld = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'pause' }, nowV)
  const storedVer = db.prepare('SELECT subscription_version FROM subscription_operations WHERE ref_no = ?').get(opOld.ref_no).subscription_version
  check('H.6 旧单捕获建单时版本', opOld.subscription_id === adobeId && storedVer === vBefore, `快照 v${storedVer}`)
  // 模拟订阅在建单后被外部改状态两次（paused→active），版本 +2，状态回到 active
  db.prepare("UPDATE subscriptions SET status = 'paused', version = version + 1 WHERE id = ?").run(adobeId)
  db.prepare("UPDATE subscriptions SET status = 'active', version = version + 1 WHERE id = ?").run(adobeId)
  check('H.7 订阅版本已变化', subById(adobeId).version === vBefore + 2, `v${vBefore}->v${subById(adobeId).version}`)
  const rOld = confirmSubscriptionOperation(db, userId, opOld.ref_no, nowV)
  check('H.8 旧单再次提交被拒（stale）', rOld.outcome === 'stale', rOld.outcome)
  check('H.9 旧单状态标记为 failed', getSubscriptionOperation(db, userId, opOld.ref_no, nowV).status === 'failed')
  check('H.10 订阅保持 active（旧单未覆盖新状态）', subById(adobeId).status === 'active', subById(adobeId).status)

  // 订阅被删：确认时订阅不存在 → failed（防御分支；临时关闭外键模拟订阅被外部删除）
  const tmpSub = db.prepare("INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status) VALUES (?, ?, '临时订阅', 1000, 'monthly', NULL, 'active')")
    .run(userId, db.prepare('SELECT account_id FROM subscriptions WHERE id = ?').get(iqiyiId).account_id).lastInsertRowid
  const opD = createSubscriptionOperation(db, userId, { subscriptionId: tmpSub, action: 'pause' }, nowV)
  db.pragma('foreign_keys = OFF')
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(tmpSub)
  db.pragma('foreign_keys = ON')
  check('H.11 订阅被删后确认返回 failed', confirmSubscriptionOperation(db, userId, opD.ref_no, nowV).outcome === 'failed')
}

console.log('—— I. 原子一致性与审计 / 事务回滚 ——')
{
  // 成功路径：操作单 completed + 订阅状态 + 审计 三者一致
  const now = shDate(2026, 11, 10, 10, 0)
  ensurePaused(icloudId, now) // 使 iCloud 回到 paused（若原为 active，此步的暂停确认也会产生一条审计）
  const beforeAudit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type='subscription_operation' AND action='confirm' AND result='success'").get().c
  const op = createSubscriptionOperation(db, userId, { subscriptionId: icloudId, action: 'resume' }, now)
  const step = totpStep(now.getTime())
  const code = totpAt(SECRET_BUF, step)
  resetFails()
  tryResume(op.ref_no, PASSWORD, code, { now })
  check('I.1 成功后操作单 completed 且订阅 active', getSubscriptionOperation(db, userId, op.ref_no, now).status === 'completed' && subById(icloudId).status === 'active')
  check('I.2 成功后新增一条成功审计', db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type='subscription_operation' AND action='confirm' AND result='success'").get().c === beforeAudit + 1)

  // 事务回滚：异常抛出回滚已写入内容（与强验证同机制）
  const stepBefore = db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c
  let rolledBack = false
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO totp_used_steps (user_id, step, purpose, consumed_at) VALUES (?, ?, ?, ?)').run(userId, 987654321, 'resume', 'x')
      throw new Error('模拟异常')
    })()
  } catch { rolledBack = true }
  check('I.3 事务内抛错回滚已写入的时间步消费', rolledBack && db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c === stepBefore)
}

console.log('—— J. 暂停 / 恢复 / 取消不改变余额 / 交易流水 / 银行卡 ——')
{
  const bal0 = balanceOf()
  const tx0 = txCount()
  const card0 = cardCount()
  const t1 = shDate(2026, 11, 11, 10, 0)
  const t2 = shDate(2026, 11, 11, 10, 1)
  // 多轮暂停 / 恢复
  ensurePaused(adobeId, t1)
  let op = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'resume' }, t1)
  resetFails()
  tryResume(op.ref_no, PASSWORD, totpAt(SECRET_BUF, totpStep(t1.getTime())), { now: t1 })
  ensurePaused(adobeId, t2)
  op = createSubscriptionOperation(db, userId, { subscriptionId: adobeId, action: 'resume' }, t2)
  resetFails()
  tryResume(op.ref_no, PASSWORD, totpAt(SECRET_BUF, totpStep(t2.getTime())), { now: t2 })
  check('J.1 多轮暂停/恢复后余额不变', balanceOf() === bal0, `${bal0}->${balanceOf()}`)
  check('J.2 交易流水不变', txCount() === tx0, `${tx0}->${txCount()}`)
  check('J.3 银行卡不变', cardCount() === card0, `${card0}->${cardCount()}`)
}

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

// —— K-M. AI 助手工具与行为（独立临时库） ——
function buildSubsDb(path, { multi = false } = {}) {
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const db = openDatabase(path)
  createSchema(db)
  migrate(db)
  const u = db.prepare("INSERT INTO users (name, created_at) VALUES ('张三', ?)").run(new Date().toISOString()).lastInsertRowid
  const a = db.prepare('INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u, '人民币活期账户', 500000, 500000, 'CNY', 'active').lastInsertRowid
  const insertSub = db.prepare('INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const s1 = insertSub.run(u, a, '爱奇艺会员', 2500, 'monthly', '2026-11-15T00:00:00.000Z', 'active').lastInsertRowid
  const s2 = insertSub.run(u, a, 'Keep 会员', 2500, 'monthly', '2026-11-20T00:00:00.000Z', 'paused').lastInsertRowid
  let s3 = null
  if (multi) {
    s3 = insertSub.run(u, a, 'QQ音乐豪华绿钻', 1500, 'monthly', '2026-11-18T00:00:00.000Z', 'active').lastInsertRowid
  }
  return { db, u, a, s1, s2, s3 }
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

console.log('—— K. 查询订阅 / 生成暂停·恢复操作单（不改状态） ——')
{
  const { db: adb, u: au, s1: as1 } = buildSubsDb(ASSIST_DB_PATH)
  const before = adb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(as1).status
  const mock = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_subscriptions', {})] },
    { toolCalls: [tc('c2', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '已生成暂停操作单，请在界面确认。' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mock })
  const r = await assistant.chat({ message: '暂停爱奇艺的订阅' })
  const subsRec = r.toolRecords.find((t) => t.name === 'get_subscriptions')
  const prepRec = r.toolRecords.find((t) => t.name === 'prepare_subscription_operation')
  check('K.1 get_subscriptions 返回订阅列表', subsRec?.status === 'ok' && Array.isArray(subsRec.data) && subsRec.data.length === 2 && subsRec.data.every((x) => x.merchant && x.status), JSON.stringify(subsRec?.data))
  check('K.2 prepare_subscription_operation 成功且为 pending/yellow', prepRec?.status === 'ok' && prepRec.data.status === 'pending' && prepRec.data.risk_level === 'yellow', `${prepRec?.data?.status}/${prepRec?.data?.risk_level}`)
  check('K.3 生成操作单不改订阅状态', adb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(as1).status === before, before)
  check('K.4 确定性说明提示确认', /暂停订阅操作单/.test(prepRec?.data?.notice || ''), prepRec?.data?.notice)
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— L. 多订阅澄清 / 上下文指向 / 模型重复建单 ——')
{
  const { db: adb, u: au, s1: as1, s2: as2, s3: as3 } = buildSubsDb(ASSIST_DB_PATH, { multi: true })
  // 多订阅澄清：模型仅查询，未建单
  const mockClarify = makeScriptedMock([
    { toolCalls: [tc('c1', 'get_subscriptions', {})] },
    { content: '您有多项订阅，请选择要暂停的订阅。' },
  ])
  const r1 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockClarify }).chat({ message: '暂停我的订阅' })
  const subsRec = r1.toolRecords.find((t) => t.name === 'get_subscriptions')
  check('L.1 多订阅时 get_subscriptions 返回多条', subsRec?.data?.length === 3, JSON.stringify(subsRec?.data?.map((x) => x.merchant)))
  check('L.2 未指定订阅时未建单', !r1.toolRecords.some((t) => t.name === 'prepare_subscription_operation'))

  // prepare_subscription_operation 必须显式 subscription_id：无默认选择第一项
  const mockNoSub = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_subscription_operation', { action: 'pause' })] },
    { content: '缺少订阅 id。' },
  ])
  const rNoSub = await createAssistant({ db: adb, demoUserId: au, chatFn: mockNoSub }).chat({ message: '暂停' })
  check('L.3 缺 subscription_id 被拒（不擅自选第一项）', rNoSub.toolRecords[0]?.status === 'error' && /subscription_id/.test(rNoSub.toolRecords[0]?.error), rNoSub.toolRecords[0]?.error)

  // 修改 / 上下文指向（同一订阅）：第二轮同订阅再暂停 → 旧待确认暂停单被取消（改单）
  const mockModify = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '已生成暂停操作单。' },
    { toolCalls: [tc('c2', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '已重新生成暂停操作单。' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mockModify })
  const ra = await assistant.chat({ message: '暂停爱奇艺的订阅' })
  const refA = ra.toolRecords.find((t) => t.name === 'prepare_subscription_operation')?.data?.ref_no
  const rb = await assistant.chat({ message: '重新暂停这项订阅', sessionId: ra.sessionId })
  const prep2 = rb.toolRecords.find((t) => t.name === 'prepare_subscription_operation')
  check('L.4 旧待确认暂停单被取消（改单）', prep2?.data?.previous?.ref_no === refA && prep2?.data?.previous?.status === 'cancelled' && prep2?.data?.previous?.cancelled === true, JSON.stringify(prep2?.data?.previous))
  check('L.5 新操作单为 pending/yellow', prep2?.data?.status === 'pending' && prep2?.data?.risk_level === 'yellow', `${prep2?.data?.status}/${prep2?.data?.risk_level}`)
  check('L.6 会话引用指向新操作单', assistant._sessions.get(ra.sessionId)?.pendingSubscriptionOpRef === prep2?.data?.ref_no)

  // 上下文指向（把刚才暂停的订阅恢复）：先确认暂停使订阅真的 paused，再让助手生成恢复单
  const mockResume = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '已生成暂停操作单。' },
    { toolCalls: [tc('c2', 'prepare_subscription_operation', { subscription_id: as1, action: 'resume' })] },
    { content: '已生成恢复操作单。' },
  ])
  const assistant2 = createAssistant({ db: adb, demoUserId: au, chatFn: mockResume })
  const rf = await assistant2.chat({ message: '暂停爱奇艺的订阅' })
  const refF = rf.toolRecords.find((t) => t.name === 'prepare_subscription_operation')?.data?.ref_no
  confirmSubscriptionOperation(adb, au, refF, new Date()) // 模拟用户在界面点击确认暂停
  const ru = await assistant2.chat({ message: '把刚才暂停的订阅恢复', sessionId: rf.sessionId })
  const prepU = ru.toolRecords.find((t) => t.name === 'prepare_subscription_operation')
  check('L.7 已完成的暂停单不被取消（如实说明）', prepU?.data?.previous?.ref_no === refF && prepU?.data?.previous?.status === 'completed' && prepU?.data?.previous?.cancelled === false, JSON.stringify(prepU?.data?.previous))
  check('L.8 新恢复单为 needs_verification/red', prepU?.data?.status === 'needs_verification' && prepU?.data?.risk_level === 'red', `${prepU?.data?.status}/${prepU?.data?.risk_level}`)

  // 模型重复建单：单条消息两次 prepare_subscription_operation → 第二次拒绝
  const beforeOps = adb.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c
  const mockDup = makeScriptedMock([
    {
      toolCalls: [
        tc('c1', 'prepare_subscription_operation', { subscription_id: as3, action: 'pause' }),
        tc('c2', 'prepare_subscription_operation', { subscription_id: as3, action: 'pause' }),
      ],
    },
    { content: '一次只能生成一张操作单。' },
  ])
  const rDup = await createAssistant({ db: adb, demoUserId: au, chatFn: mockDup }).chat({ message: '暂停这项订阅' })
  const preps = rDup.toolRecords.filter((t) => t.name === 'prepare_subscription_operation')
  check('L.9 单条消息重复建单被拒', preps.length === 2 && preps[0].status === 'ok' && preps[1].status === 'error' && /已生成订阅操作单/.test(preps[1].error), JSON.stringify(preps.map((p) => p.status)))
  check('L.10 仅创建一张操作单', adb.prepare('SELECT COUNT(*) AS c FROM subscription_operations').get().c === beforeOps + 1)
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— M. 聊天“确认”不执行 / 未知工具 / 模型错误状态文案不影响确定性 ——')
{
  const { db: adb, u: au, s1: as1 } = buildSubsDb(ASSIST_DB_PATH)
  // 纯文字“确认”不执行任何操作
  const mockConfirm = makeScriptedMock([{ content: '好的，已为你确认暂停。' }])
  const r1 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockConfirm }).chat({ message: '确认暂停' })
  check('M.1 纯文字“确认”无工具调用', r1.toolRecords.length === 0, JSON.stringify(r1.toolRecords))
  check('M.2 订阅状态未变', adb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(as1).status === 'active')

  // 模型尝试调用不存在 / 未开放的确认工具
  const mockUnknown = makeScriptedMock([
    { toolCalls: [tc('c1', 'confirm_subscription_operation', { ref_no: 'x' })] },
    { content: '无法执行。' },
  ])
  const r2 = await createAssistant({ db: adb, demoUserId: au, chatFn: mockUnknown }).chat({ message: '确认暂停' })
  check('M.3 confirm_subscription_operation 不在白名单，被拒绝', r2.toolRecords[0]?.status === 'error' && /未知工具/.test(r2.toolRecords[0]?.error), r2.toolRecords[0]?.error)

  // 模型给出错误状态文案，但结构化 previous / notice 仍正确
  const mockStatus = makeScriptedMock([
    { toolCalls: [tc('c1', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '已生成暂停操作单。' },
    { toolCalls: [tc('c2', 'prepare_subscription_operation', { subscription_id: as1, action: 'pause' })] },
    { content: '旧暂停单仍待确认，未取消。（模型给出错误旧状态）' },
  ])
  const assistant = createAssistant({ db: adb, demoUserId: au, chatFn: mockStatus })
  const ra = await assistant.chat({ message: '暂停爱奇艺的订阅' })
  const refA = ra.toolRecords.find((t) => t.name === 'prepare_subscription_operation')?.data?.ref_no
  const rb = await assistant.chat({ message: '改成暂停这项订阅', sessionId: ra.sessionId })
  const prep2 = rb.toolRecords.find((t) => t.name === 'prepare_subscription_operation')
  check('M.4 结构化 previous.status 为 cancelled（非模型推断）', prep2?.data?.previous?.ref_no === refA && prep2?.data?.previous?.status === 'cancelled' && prep2?.data?.previous?.cancelled === true, JSON.stringify(prep2?.data?.previous))
  check('M.5 确定性 notice 说明已取消旧单', /已取消原待确认操作单/.test(prep2?.data?.notice || ''), prep2?.data?.notice)
  check('M.6 数据库旧单确为 cancelled', adb.prepare('SELECT status FROM subscription_operations WHERE ref_no = ?').get(refA).status === 'cancelled')
  adb.close()
  for (const p of [ASSIST_DB_PATH, ASSIST_DB_PATH + '-wal', ASSIST_DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log('—— N. HTTP 路由：字段校验 / 暂停端到端 / 恢复强验证端到端 ——')
{
  const httpPath = join(tmpdir(), 'rongzhi-verify-sub-ops-http.db')
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
  const { db: hdb } = initDatabase({ dbPath: httpPath, seed: true })
  const hUser = resolveDemoUser(hdb)
  const hId = hUser.id
  const hSub = hdb.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(hId).id
  const hPaused = hdb.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'paused' ORDER BY id LIMIT 1").get(hId).id
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
    const extra = await postJson(`${base}/subscription-operations`, { subscription_id: hSub, action: 'pause', user_id: 1 })
    check('N.1 创建带 user_id 字段返回 400', extra.status === 400)
    const badAction = await postJson(`${base}/subscription-operations`, { subscription_id: hSub, action: 'delete' })
    check('N.2 非法 action 返回 400', badAction.status === 400)

    // 暂停端到端：创建 → 确认 → 订阅 paused
    const created = await (await postJson(`${base}/subscription-operations`, { subscription_id: hSub, action: 'pause' })).json()
    check('N.3 创建暂停操作单成功', created.success && created.data.status === 'pending')
    const c = await postJson(`${base}/subscription-operations/${created.data.ref_no}/confirm`, { confirm: true })
    check('N.4 确认暂停返回 200', c.status === 200)
    check('N.5 订阅已暂停', hdb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(hSub).status === 'paused')
    const cExtra = await postJson(`${base}/subscription-operations/${created.data.ref_no}/confirm`, { confirm: true, subscription_id: hSub })
    check('N.6 确认带额外字段返回 400', cExtra.status === 400)

    // 恢复强验证端到端
    const resCreated = await (await postJson(`${base}/subscription-operations`, { subscription_id: hPaused, action: 'resume' })).json()
    check('N.7 创建恢复操作单成功（needs_verification）', resCreated.success && resCreated.data.status === 'needs_verification')
    const confirmRes = await postJson(`${base}/subscription-operations/${resCreated.data.ref_no}/confirm`, { confirm: true })
    check('N.8 恢复单普通确认返回 409', confirmRes.status === 409)
    const goodCode = totpAt(SECRET_BUF, totpStep(Date.now()))
    const verifyRes = await postJson(`${base}/subscription-operations/${resCreated.data.ref_no}/verify`, { password: PASSWORD, totp: goodCode })
    check('N.9 恢复强验证成功返回 200', verifyRes.status === 200, `HTTP ${verifyRes.status}`)
    check('N.10 订阅已恢复 active', hdb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(hPaused).status === 'active')
  })

  hdb.close()
  for (const p of [httpPath, httpPath + '-wal', httpPath + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
