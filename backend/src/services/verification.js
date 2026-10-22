// 强验证服务：绑定状态、本地一次性绑定、强验证确认转账。
// 交易密码（scrypt 哈希）+ 手机验证器 TOTP（RFC 6238）双重校验；失败计数锁定 + 时间步防重放。
// 仅服务端演示用户可用；客户端不能指定 userId / 风险级别 / 任何「已通过」标记。
// 扣款 / 流水 / 状态 CAS / 唯一索引 / 审计复用 transfers.js 的 finalizeTransfer，不复制第二套扣款实现。
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../lib/crypto-util.js'
import { base32Decode, verifyTotp } from '../lib/totp.js'
import { finalizeTransfer, getTransferRow, viewTransfer } from './transfers.js'

export const MAX_VERIFY_FAILURES = 5
export const VERIFY_LOCK_MS = 15 * 60 * 1000 // 连续失败锁定 15 分钟

export class VerificationError extends Error {
  constructor(message, code = 'error', extra = {}) {
    super(message)
    this.name = 'VerificationError'
    this.code = code
    Object.assign(this, extra)
  }
}

function getBinding(db, userId) {
  return db.prepare('SELECT * FROM verification_bindings WHERE user_id = ?').get(userId)
}

function getFailure(db, userId) {
  return db.prepare('SELECT * FROM verification_failures WHERE user_id = ?').get(userId)
}

function remainingAttempts(fail) {
  return Math.max(0, MAX_VERIFY_FAILURES - (fail ? fail.fail_count : 0))
}

// 绑定与锁定状态（供前端渲染；绝不泄露密码 / 密钥 / 验证码 / TOTP 密钥）
export function getVerificationStatus(db, userId, now = new Date()) {
  const binding = getBinding(db, userId)
  const fail = getFailure(db, userId)
  const nowIso = now.toISOString()
  const locked = !!fail && !!fail.locked_until && nowIso < fail.locked_until
  return {
    bound: !!binding && binding.enabled === 1,
    locked,
    locked_until: locked ? fail.locked_until : null,
    remaining_attempts: remainingAttempts(fail),
  }
}

// 记录一次凭据失败；连续达到上限则锁定。独立提交（不随转账事务回滚而丢失）。
function recordFailure(db, userId, now) {
  const fail = getFailure(db, userId)
  const count = (fail ? fail.fail_count : 0) + 1
  if (count >= MAX_VERIFY_FAILURES) {
    const lockedUntil = new Date(now.getTime() + VERIFY_LOCK_MS).toISOString()
    db.prepare(
      `INSERT INTO verification_failures (user_id, fail_count, locked_until) VALUES (?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET fail_count = 0, locked_until = excluded.locked_until`,
    ).run(userId, lockedUntil)
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'verification', NULL, 'locked', 'locked', ?)`,
    ).run(userId, JSON.stringify({ locked_until: lockedUntil }))
    return { locked: true, remaining: 0 }
  }
  db.prepare(
    `INSERT INTO verification_failures (user_id, fail_count, locked_until) VALUES (?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET fail_count = excluded.fail_count, locked_until = NULL`,
  ).run(userId, count)
  db.prepare(
    `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
     VALUES (?, 'verification', NULL, 'verify_failed', 'failed', ?)`,
  ).run(userId, JSON.stringify({ fail_count: count }))
  return { locked: false, remaining: MAX_VERIFY_FAILURES - count }
}

function resetFailures(db, userId) {
  db.prepare('UPDATE verification_failures SET fail_count = 0, locked_until = NULL WHERE user_id = ?').run(userId)
}

// 一次性绑定（仅本地 CLI 绑定流程调用）。已绑定拒绝覆盖。
// matchedStep：绑定环节已验证并命中的 TOTP 时间步（消费后防止立即复用）。
export function bindVerification(db, userId, { password, totpSecretBase32, encryptionKey, matchedStep, now = new Date() }) {
  const run = db.transaction(() => {
    const existing = getBinding(db, userId)
    if (existing && existing.enabled === 1) {
      throw new VerificationError('已绑定验证器，拒绝覆盖', 'already_bound')
    }
    const { salt, hash } = hashPassword(password)
    const secretBuf = base32Decode(totpSecretBase32)
    const enc = encryptSecret(secretBuf, encryptionKey)
    db.prepare(
      `INSERT INTO verification_bindings (user_id, password_salt, password_hash, totp_secret_enc, enabled, bound_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET password_salt = excluded.password_salt, password_hash = excluded.password_hash,
         totp_secret_enc = excluded.totp_secret_enc, enabled = 1, bound_at = excluded.bound_at`,
    ).run(userId, salt, hash, JSON.stringify(enc), now.toISOString())
    db.prepare(
      `INSERT INTO totp_used_steps (user_id, step, purpose, consumed_at) VALUES (?, ?, 'bind', ?)`,
    ).run(userId, matchedStep, now.toISOString())
    db.prepare(
      `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
       VALUES (?, 'verification', NULL, 'bind', 'success', ?)`,
    ).run(userId, JSON.stringify({ step: matchedStep }))
  })
  run()
}

// 强验证确认转账：密码 + TOTP 均正确 → 消费时间步 + 扣款 + 流水 + 状态更新（同一事务）。
// 失败计数 / 锁定 / 审计独立提交（不随转账事务回滚丢失）。
// 返回 outcome：'completed'（含幂等）、'not_found'、'expired'、'cancelled'、'failed'；
// 校验类失败抛 VerificationError（not_bound / no_key / decrypt_failed / locked / bad_credentials / code_reused）。
export function verifyAndConfirmTransfer(db, userId, refNo, { password, totp }, { encryptionKey, now = new Date() } = {}) {
  // —— 阶段一：绑定 / 锁定 / 凭据校验（失败计数独立提交，不随扣款回滚丢失）——
  const binding = getBinding(db, userId)
  if (!binding || binding.enabled !== 1) {
    throw new VerificationError('尚未绑定验证器，无法执行强验证转账', 'not_bound')
  }
  const fail = getFailure(db, userId)
  const nowIso = now.toISOString()
  if (fail && fail.locked_until && nowIso < fail.locked_until) {
    const mins = Math.ceil((new Date(fail.locked_until).getTime() - now.getTime()) / 60000)
    throw new VerificationError(`强验证已锁定，请 ${mins} 分钟后重试`, 'locked', { locked_until: fail.locked_until })
  }
  if (!encryptionKey) {
    throw new VerificationError('验证器配置缺失（缺少加密密钥），红色转账保持阻断', 'no_key')
  }
  let secret
  try {
    secret = decryptSecret(JSON.parse(binding.totp_secret_enc), encryptionKey)
  } catch {
    throw new VerificationError('验证器配置错误（无法解密密钥），红色转账保持阻断', 'decrypt_failed')
  }
  const pwdOk = verifyPassword(password, binding.password_salt, binding.password_hash)
  const matchedStep = pwdOk ? verifyTotp(secret, totp, { ms: now.getTime() }) : null
  if (!pwdOk || matchedStep === null) {
    const rec = recordFailure(db, userId, now)
    if (rec.locked) throw new VerificationError('交易密码或验证码连续错误次数过多，强验证已锁定 15 分钟', 'locked')
    throw new VerificationError(`交易密码或验证码错误（还可尝试 ${rec.remaining} 次）`, 'bad_credentials')
  }

  // —— 阶段二：原子消费验证码 + 扣款 + 流水 + 状态更新（同一事务）——
  const run = db.transaction(() => {
    const row = getTransferRow(db, refNo)
    if (!row || row.user_id !== userId) return { outcome: 'not_found' }

    if (row.status === 'needs_verification' && nowIso > row.expires_at) {
      db.prepare("UPDATE transfer_operations SET status = 'expired' WHERE id = ? AND status = 'needs_verification'").run(row.id)
      return { outcome: 'expired', op: viewTransfer(db, { ...row, status: 'expired' }) }
    }
    if (row.status !== 'needs_verification') {
      // 已完成 / 已取消 / 已过期 / 已失败 / 待确认的单不可通过验证（重新）执行
      return { outcome: row.status, op: viewTransfer(db, row) }
    }

    // 消费该时间步（防重放：跨单、并发、重启后均不可复用同一时间步）
    try {
      db.prepare('INSERT INTO totp_used_steps (user_id, step, purpose, consumed_at) VALUES (?, ?, ?, ?)')
        .run(userId, matchedStep, 'transfer', nowIso)
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return { outcome: 'code_reused' }
      throw e
    }

    const res = finalizeTransfer(db, userId, row, now, 'needs_verification')

    if (res.outcome === 'completed') {
      db.prepare(
        `INSERT INTO audit_logs (user_id, operation_type, operation_ref, action, result, detail)
         VALUES (?, 'verification', ?, 'verify_success', 'success', ?)`,
      ).run(userId, refNo, JSON.stringify({ step: matchedStep, transaction_id: res.transaction_id }))
      resetFailures(db, userId)
    }
    return res
  })
  const r = run()
  if (r.outcome === 'code_reused') {
    throw new VerificationError('该动态验证码已在当前时间窗口内使用过，请等待下一个验证码', 'code_reused')
  }
  return r
}
