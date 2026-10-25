// CloudBase 模式强验证：绑定密文由固定 RPC 读取，在 Node 后端用环境主密钥校验；
// 失败计数独立提交；成功后的时间步消费与业务写入由同一个业务 RPC 原子完成。
import { verifyPassword, decryptSecret, encryptSecret, hashPassword } from '../lib/crypto-util.js'
import { verifyTotp, base32Decode } from '../lib/totp.js'
import { VerificationError } from '../services/verification.js'

const MAX_VERIFY_FAILURES = 5

export async function verifyCredentialsCloud({ client, userId, password, totp, encryptionKey, now = new Date() }) {
  const secret = await client.verificationSecret(userId)
  if (!secret || Number(secret.enabled) !== 1) {
    throw new VerificationError('尚未绑定验证器，无法执行强验证', 'not_bound')
  }
  const lockedUntil = secret.locked_until ? new Date(secret.locked_until) : null
  if (lockedUntil && now.toISOString() < lockedUntil.toISOString()) {
    const mins = Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000)
    throw new VerificationError(`强验证已锁定，请 ${mins} 分钟后重试`, 'locked', { locked_until: lockedUntil.toISOString() })
  }
  if (!encryptionKey) {
    throw new VerificationError('验证器配置缺失（缺少加密密钥），操作保持阻断', 'no_key')
  }
  let secretBuf
  try {
    secretBuf = decryptSecret(secret.totp_secret_enc, encryptionKey)
  } catch {
    throw new VerificationError('验证器配置错误（无法解密密钥），操作保持阻断', 'decrypt_failed')
  }
  const pwdOk = verifyPassword(password, secret.password_salt, secret.password_hash)
  const matchedStep = pwdOk ? verifyTotp(secretBuf, totp, { ms: now.getTime() }) : null
  if (!pwdOk || matchedStep === null) {
    const rec = await client.write('verification', 'record_failure', {}, userId)
    if (rec && rec.locked) {
      throw new VerificationError('交易密码或验证码连续错误次数过多，强验证已锁定 15 分钟', 'locked')
    }
    const remaining = Math.max(0, Number(rec && rec.remaining) || 0)
    throw new VerificationError(
      `交易密码或动态验证码不正确，请核对后重试（还可尝试 ${remaining} 次）`,
      'bad_credentials',
    )
  }
  return { matchedStep }
}

export async function bindCloudVerification({
  client, userId, password, totpSecretBase32, encryptionKey, matchedStep = 0, now = new Date(),
}) {
  if (!encryptionKey) throw new VerificationError('缺少加密主密钥', 'no_key')
  const { salt, hash } = hashPassword(password)
  const enc = encryptSecret(base32Decode(totpSecretBase32), encryptionKey)
  const r = await client.write('verification', 'bind', {
    password_salt: salt,
    password_hash: hash,
    totp_secret_enc: enc,
    matched_step: matchedStep,
    bound_at: now.toISOString(),
  }, userId)
  return r
}

export { MAX_VERIFY_FAILURES }
