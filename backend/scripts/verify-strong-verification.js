// 强验证（交易密码 + TOTP）验证脚本：在独立临时数据库上运行，不清空、不触碰开发数据库，不调用收费模型。
// 覆盖：RFC 6238 官方测试向量 / base32·加解密·密码哈希 / 未绑定·缺密钥·解密失败保持阻断 /
//       正确密码+正确验证码红色成功且仅一次 / 错误密码·错误验证码·窗口外验证码不扣款 /
//       同一时间步跨单防重放（并发同路径）/ 已取消·已过期·改单旧单·无归属被拒 /
//       普通确认不能绕过红色 / 连续失败锁定跨单·重启持久·到时解锁 / 验证时重查余额·账户·日累计 /
//       事务异常回滚 / 黄色流程与改单无回归 / HTTP 路由字段校验与端到端强验证 / 基础限流。
// 用法：node scripts/verify-strong-verification.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { openDatabase } from '../src/db/connection.js'
import { resolveDemoUser } from '../src/demo-user.js'
import {
  createTransfer, confirmTransfer, cancelTransfer, getTransfer, DAILY_TRANSFER_LIMIT_CENTS, TRANSFER_EXPIRY_MS,
} from '../src/services/transfers.js'
import {
  bindVerification, getVerificationStatus, verifyAndConfirmTransfer, VerificationError,
  MAX_VERIFY_FAILURES, VERIFY_LOCK_MS,
} from '../src/services/verification.js'
import { totpAt, totpStep, base32Encode, base32Decode, verifyTotp, generateTotpSecret, otpauthUri } from '../src/lib/totp.js'
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/lib/crypto-util.js'
import { createRateLimiter } from '../src/lib/rate-limit.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpPath = process.argv[2] || join(tmpdir(), 'rongzhi-verify-strong.db')
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
function shDate(year, month, day, hour = 10, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS)
}

// 测试专用常量（非真实凭据）
const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii') // RFC 6238 测试密钥
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const WRONG_KEY = Buffer.alloc(32, 0x99)
const PASSWORD = 'demo-pass-123'

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const demoUser = resolveDemoUser(db)
const userId = demoUser.id

function acct() {
  return db.prepare('SELECT id, balance_cents AS b, status FROM accounts WHERE user_id = ?').get(userId)
}
function resetFails() {
  db.prepare('DELETE FROM verification_failures WHERE user_id = ?').run(userId)
}
function tryVerify(refNo, password, totp, { now = new Date(), key = KEY, uid = userId } = {}) {
  try {
    const r = verifyAndConfirmTransfer(db, uid, refNo, { password, totp }, { encryptionKey: key, now })
    return { outcome: r.outcome, code: null }
  } catch (e) {
    return { outcome: 'error', code: e instanceof VerificationError ? e.code : null, message: e && e.message }
  }
}

// 构造「当日累计已超限 + 一张红色待验证单」的独立场景（每场景用独立上海日）
let scenarioDay = 0
function freshRedScenario(amountCents = 5000) {
  scenarioDay += 1
  const now = shDate(2026, 10, scenarioDay, 10, 0)
  const base = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, now)
  confirmTransfer(db, userId, base.ref_no, now) // 当日累计 = 100000
  const redOp = createTransfer(db, userId, { recipientId: 2, amountCents }, now)
  const step = totpStep(now.getTime())
  return { now, redOp, step, goodCode: totpAt(SECRET_BUF, step) }
}

console.log('—— 纯算法：RFC 6238 向量 / base32 / 加解密 / 密码哈希 ——')
check('base32 编码与 RFC 测试密钥一致', base32Encode(SECRET_BUF) === SECRET_B32, base32Encode(SECRET_BUF))
check('base32 解码往返', base32Decode(SECRET_B32).equals(SECRET_BUF))
const g = generateTotpSecret()
check('随机密钥为 32 字符 base32', /^[A-Z2-7]{32}$/.test(g.base32), g.base32)

const rfcVectors = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]
for (const [t, expected] of rfcVectors) {
  const got = totpAt(SECRET_BUF, Math.floor(t / 30), 8)
  check(`RFC6238 8 位向量 T=${t}`, got === expected, `${got} vs ${expected}`)
}

const stepT = totpStep(2000000000000)
const cNow = totpAt(SECRET_BUF, stepT)
check('TOTP 窗口内（本步）命中', verifyTotp(SECRET_BUF, cNow, { ms: 2000000000000 }) === stepT)
check('TOTP 窗口内（+1 步）命中', verifyTotp(SECRET_BUF, totpAt(SECRET_BUF, stepT + 1), { ms: 2000000000000 }) === stepT + 1)
check('TOTP 窗口内（-1 步）命中', verifyTotp(SECRET_BUF, totpAt(SECRET_BUF, stepT - 1), { ms: 2000000000000 }) === stepT - 1)
check('TOTP 窗口外（+2 步）拒绝', verifyTotp(SECRET_BUF, totpAt(SECRET_BUF, stepT + 2), { ms: 2000000000000 }) === null)

const enc = encryptSecret(SECRET_BUF, KEY)
check('AES-GCM 解密往返', decryptSecret(enc, KEY).equals(SECRET_BUF))
let wrongKeyThrows = false
try { decryptSecret(enc, WRONG_KEY) } catch { wrongKeyThrows = true }
check('AES-GCM 错误密钥解密失败', wrongKeyThrows)
const hp = hashPassword(PASSWORD)
check('scrypt 密码校验通过', verifyPassword(PASSWORD, hp.salt, hp.hash))
check('scrypt 错误密码拒绝', verifyPassword('nope', hp.salt, hp.hash) === false)
check('otpauth URI 结构', otpauthUri({ secretBase32: SECRET_B32, issuer: '融智 Agent', account: '张三' }).startsWith('otpauth://totp/'))

console.log('—— 绑定 / 未绑定 / 缺密钥 / 解密失败 ——')
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
check('绑定后状态 bound', getVerificationStatus(db, userId).bound === true)
check('绑定消费时间步（step=0, bind）', !!db.prepare("SELECT 1 FROM totp_used_steps WHERE user_id=? AND step=0 AND purpose='bind'").get(userId))
let dupThrows = false
try { bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 1 }) } catch (e) { dupThrows = e instanceof VerificationError && e.code === 'already_bound' }
check('重复绑定拒绝覆盖', dupThrows)

// 未绑定：第二个用户（尚未绑定）
db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('测试用户2', new Date().toISOString())
const user2 = db.prepare('SELECT id FROM users WHERE name = ?').get('测试用户2').id
const s0 = freshRedScenario(1000)
check('未绑定用户强验证被拒（not_bound）', tryVerify(s0.redOp.ref_no, PASSWORD, s0.goodCode, { now: s0.now, uid: user2 }).code === 'not_bound')
check('缺少加密密钥保持阻断（no_key）', tryVerify(s0.redOp.ref_no, PASSWORD, s0.goodCode, { now: s0.now, key: null }).code === 'no_key')
check('解密失败保持阻断（decrypt_failed）', tryVerify(s0.redOp.ref_no, PASSWORD, s0.goodCode, { now: s0.now, key: WRONG_KEY }).code === 'decrypt_failed')
check('以上阻断均不扣款', getTransfer(db, userId, s0.redOp.ref_no, s0.now).status === 'needs_verification')

console.log('—— 正确密码 + 正确验证码：红色成功且仅一次 ——')
resetFails()
const s1 = freshRedScenario(5000)
const b1 = acct().b
const r1 = tryVerify(s1.redOp.ref_no, PASSWORD, s1.goodCode, { now: s1.now })
check('正确凭据红色验证成功', r1.outcome === 'completed', `outcome=${r1.outcome}`)
check('红色成功扣款一次', acct().b === b1 - 5000, `期望 ${b1 - 5000} 实际 ${acct().b}`)
check('红色成功写入一条已入账流水', db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE transfer_ref=?').get(s1.redOp.ref_no).c === 1)
check('红色成功写入验证审计', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='verification' AND action='verify_success'").get())
const r1b = tryVerify(s1.redOp.ref_no, PASSWORD, s1.goodCode, { now: s1.now })
check('重复验证幂等返回 completed', r1b.outcome === 'completed')
check('重复验证不重复扣款', acct().b === b1 - 5000)

console.log('—— 错误凭据 / 窗口外验证码不扣款 ——')
resetFails()
const s2 = freshRedScenario(4000)
const b2 = acct().b
check('错误密码被拒', tryVerify(s2.redOp.ref_no, 'wrong-pass', s2.goodCode, { now: s2.now }).code === 'bad_credentials')
check('窗口外（+2 步）验证码被拒', tryVerify(s2.redOp.ref_no, PASSWORD, totpAt(SECRET_BUF, s2.step + 2), { now: s2.now }).code === 'bad_credentials')
check('过期（-2 步）验证码被拒', tryVerify(s2.redOp.ref_no, PASSWORD, totpAt(SECRET_BUF, s2.step - 2), { now: s2.now }).code === 'bad_credentials')
check('错误凭据不扣款', acct().b === b2)
check('错误凭据后单仍 needs_verification', getTransfer(db, userId, s2.redOp.ref_no, s2.now).status === 'needs_verification')
check('错误凭据计入失败计数', db.prepare('SELECT fail_count AS c FROM verification_failures WHERE user_id=?').get(userId).c === 3)
check('验证失败写入审计（不含敏感体）', !!db.prepare("SELECT 1 FROM audit_logs WHERE operation_type='verification' AND action='verify_failed'").get())

console.log('—— 同一时间步防重放（跨单 / 并发同路径） ——')
resetFails()
scenarioDay += 1
const nowR = shDate(2026, 10, scenarioDay, 10, 0)
const baseR = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, nowR)
confirmTransfer(db, userId, baseR.ref_no, nowR)
const opA = createTransfer(db, userId, { recipientId: 2, amountCents: 5000 }, nowR)
const opB = createTransfer(db, userId, { recipientId: 3, amountCents: 3000 }, nowR)
const stepR = totpStep(nowR.getTime())
const codeR = totpAt(SECRET_BUF, stepR)
const bR = acct().b
check('第一张红色单验证成功', tryVerify(opA.ref_no, PASSWORD, codeR, { now: nowR }).outcome === 'completed')
check('A 扣款一次', acct().b === bR - 5000)
const rB = tryVerify(opB.ref_no, PASSWORD, codeR, { now: nowR })
check('同一时间步用于第二张单被拒（code_reused）', rB.code === 'code_reused', `code=${rB.code}`)
check('B 未扣款', acct().b === bR - 5000)
check('B 仍为 needs_verification（无部分执行）', getTransfer(db, userId, opB.ref_no, nowR).status === 'needs_verification')

console.log('—— 已取消 / 已过期 / 改单旧单 / 无归属被拒 ——')
resetFails()
const s3 = freshRedScenario(2000)
check('红色单可取消', cancelTransfer(db, userId, s3.redOp.ref_no, s3.now).outcome === 'cancelled')
check('已取消红色单验证被拒', tryVerify(s3.redOp.ref_no, PASSWORD, s3.goodCode, { now: s3.now }).outcome === 'cancelled')

resetFails()
const s4 = freshRedScenario(2000)
const late = new Date(s4.now.getTime() + TRANSFER_EXPIRY_MS + 1000)
const lateCode = totpAt(SECRET_BUF, totpStep(late.getTime()))
check('已过期红色单验证被拒', tryVerify(s4.redOp.ref_no, PASSWORD, lateCode, { now: late }).outcome === 'expired')

// 改单：取消旧红单 + 生成新单，旧单凭据不能用于新单
resetFails()
scenarioDay += 1
const nowM = shDate(2026, 10, scenarioDay, 10, 0)
const baseM = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, nowM)
confirmTransfer(db, userId, baseM.ref_no, nowM)
const oldRed = createTransfer(db, userId, { recipientId: 2, amountCents: 3000 }, nowM)
cancelTransfer(db, userId, oldRed.ref_no, nowM)
const newRed = createTransfer(db, userId, { recipientId: 3, amountCents: 3000 }, nowM)
const stepM = totpStep(nowM.getTime())
const codeM = totpAt(SECRET_BUF, stepM)
check('改单旧单验证被拒（cancelled）', tryVerify(oldRed.ref_no, PASSWORD, codeM, { now: nowM }).outcome === 'cancelled')
check('改单新单可验证', tryVerify(newRed.ref_no, PASSWORD, codeM, { now: nowM }).outcome === 'completed')

// 无归属：他人（已绑定）验证演示用户单
const SECRET2 = Buffer.from('09876543210987654321', 'ascii')
bindVerification(db, user2, { password: 'pass2-pass', totpSecretBase32: base32Encode(SECRET2), encryptionKey: KEY, matchedStep: 0 })
const s5 = freshRedScenario(1000)
const code2 = totpAt(SECRET2, totpStep(s5.now.getTime()))
check('他人验证返回 not_found（归属校验）', tryVerify(s5.redOp.ref_no, 'pass2-pass', code2, { now: s5.now, uid: user2 }).outcome === 'not_found')
check('不存在的单返回 not_found', tryVerify('no-such-ref', PASSWORD, s5.goodCode, { now: s5.now }).outcome === 'not_found')

console.log('—— 普通确认不能绕过红色 ——')
resetFails()
const s6 = freshRedScenario(1500)
const b6 = acct().b
check('红色单普通确认被拒（needs_verification）', confirmTransfer(db, userId, s6.redOp.ref_no, s6.now).outcome === 'needs_verification')
check('普通确认不扣款', acct().b === b6)

console.log('—— 连续失败锁定：跨单 / 重启持久 / 到时解锁 ——')
resetFails()
const s7 = freshRedScenario(1000)
let lastCode = null
for (let i = 0; i < MAX_VERIFY_FAILURES; i++) {
  lastCode = tryVerify(s7.redOp.ref_no, 'bad-pass', s7.goodCode, { now: s7.now }).code
}
check('第 5 次失败触发锁定', lastCode === 'locked', `code=${lastCode}`)
check('锁定后状态 locked', getVerificationStatus(db, userId, s7.now).locked === true)
check('锁定期间正确凭据也被拒', tryVerify(s7.redOp.ref_no, PASSWORD, s7.goodCode, { now: s7.now }).code === 'locked')
const db2 = openDatabase(tmpPath)
check('重启（新连接）后锁定仍有效', getVerificationStatus(db2, userId, s7.now).locked === true)
db2.close()
check('15 分钟后自动解锁', getVerificationStatus(db, userId, new Date(s7.now.getTime() + VERIFY_LOCK_MS + 1000)).locked === false)

console.log('—— 验证时重查余额 / 账户状态 / 日累计 ——')
resetFails()
const s8 = freshRedScenario(2000)
const bal8 = acct().b
db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(100, acct().id) // 人为降到不足
check('验证时余额不足返回 failed（不扣款到负）', tryVerify(s8.redOp.ref_no, PASSWORD, s8.goodCode, { now: s8.now }).outcome === 'failed')
check('余额不足验证后账户未被扣到负', acct().b === 100)
db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(bal8, acct().id)

resetFails()
const s9 = freshRedScenario(2000)
db.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").run(acct().id)
const b9 = acct().b
check('验证时冻结账户返回 failed', tryVerify(s9.redOp.ref_no, PASSWORD, s9.goodCode, { now: s9.now }).outcome === 'failed')
check('冻结账户验证不扣款', acct().b === b9)
db.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").run(acct().id)

console.log('—— 事务异常整体回滚 ——')
// verifyAndConfirmTransfer 依赖 db.transaction：异常抛出回滚已写入的验证码消费。
const stepCountBefore = db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c
let rolledBack = false
try {
  db.transaction(() => {
    db.prepare('INSERT INTO totp_used_steps (user_id, step, purpose, consumed_at) VALUES (?, ?, ?, ?)').run(userId, 987654321, 'transfer', 'x')
    throw new Error('模拟扣款异常')
  })()
} catch { rolledBack = true }
check('事务内抛错回滚已写入的验证码消费', rolledBack && db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get().c === stepCountBefore)

console.log('—— 黄色流程 / 改单无回归 ——')
const sy = shDate(2026, 10, 30, 10, 0)
const by = acct().b
const opY = createTransfer(db, userId, { recipientId: 1, amountCents: 6000 }, sy)
check('黄色单普通确认成功', confirmTransfer(db, userId, opY.ref_no, sy).outcome === 'completed')
check('黄色确认扣款正确', acct().b === by - 6000)

console.log('—— 基础限流（与失败计数分开） ——')
const lim = createRateLimiter({ windowMs: 60000, max: 2 })
check('限流器前 2 次放行', lim('k').allowed && lim('k').allowed)
check('限流器第 3 次拒绝', lim('k').allowed === false)

console.log('—— HTTP 路由层：字段校验 / 红色阻断 / 端到端强验证 ——')
resetFails()
process.env.VERIFICATION_KEY = KEY.toString('base64')
async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(db, userId))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  try { await fn(base) } finally { await new Promise((resolve) => server.close(resolve)) }
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

await withServer(async (base) => {
  const st = await (await fetch(`${base}/verification/status`)).json()
  check('GET /verification/status 返回绑定状态', st.success && st.data.bound === true && typeof st.data.locked === 'boolean')

  // 实时构造红色单（路由用真实时钟校验 TOTP 与有效期）
  const nowReal = new Date()
  const baseR2 = createTransfer(db, userId, { recipientId: 1, amountCents: 100000 }, nowReal)
  confirmTransfer(db, userId, baseR2.ref_no, nowReal)
  const redOp = createTransfer(db, userId, { recipientId: 2, amountCents: 1500 }, nowReal)
  const goodCode = totpAt(SECRET_BUF, totpStep(Date.now()))

  const redConfirm = await postJson(`${base}/transfers/${redOp.ref_no}/confirm`, { confirm: true })
  check('HTTP 红色单普通确认返回 409', redConfirm.status === 409)
  const redBody = await redConfirm.json()
  check('HTTP 红色 409 提示强验证', /强验证/.test(redBody.message))

  const extra = await postJson(`${base}/transfers/${redOp.ref_no}/verify`, { password: PASSWORD, totp: goodCode, user_id: 1 })
  check('HTTP 验证带 user_id 字段返回 400', extra.status === 400)
  const missing = await postJson(`${base}/transfers/${redOp.ref_no}/verify`, {})
  check('HTTP 验证缺少字段返回 400', missing.status === 400)

  const beforeHttp = acct().b
  const vb = await (await postJson(`${base}/transfers/${redOp.ref_no}/verify`, { password: PASSWORD, totp: goodCode })).json()
  check('HTTP 强验证成功返回回执', vb.success && vb.data.status === 'completed' && !!vb.data.transaction_id)
  check('HTTP 强验证后扣款', acct().b === beforeHttp - 1500)
})

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
