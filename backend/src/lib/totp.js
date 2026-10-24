// RFC 6238 TOTP（HMAC-SHA1，6 位数字，30 秒周期）与 RFC 4648 Base32。
// 仅用 Node 内置 crypto 实现，便于用 RFC 6238 官方测试向量独立验证（不依赖第三方算法库）。
// 兼容主流手机验证器（Google Authenticator / 微软 / 鸿蒙离线验证器等）。
import { createHmac, randomBytes } from 'node:crypto'

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_WINDOW = 1 // 允许 ±1 步偏差（合计约 90 秒容忍窗口）

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// 生成密码学安全随机 TOTP 密钥（默认 20 字节 = 160 位，对应 SHA-1）
export function generateTotpSecret(bytes = 20) {
  const buffer = randomBytes(bytes)
  return { base32: base32Encode(buffer), buffer }
}

// 当前（或指定时刻）所属的 30 秒时间步
export function totpStep(ms = Date.now()) {
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS)
}

// 计算某时间步下的动态码（HMAC-SHA1 → 动态截断 → 指定位数）
export function totpAt(secretBuffer, step, digits = TOTP_DIGITS) {
  const counter = Buffer.alloc(8)
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0)
  counter.writeUInt32BE(step >>> 0, 4)
  const hmac = createHmac('sha1', secretBuffer).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3]
  const code = binCode % 10 ** digits
  return String(code).padStart(digits, '0')
}

export function totpNow(secretBuffer, ms = Date.now(), digits = TOTP_DIGITS) {
  return totpAt(secretBuffer, totpStep(ms), digits)
}

// 校验动态码；命中返回命中的时间步（供防重放），未命中返回 null。
export function verifyTotp(secretBuffer, code, { ms = Date.now(), window = TOTP_WINDOW, digits = TOTP_DIGITS } = {}) {
  const clean = String(code || '').trim()
  if (!/^\d+$/.test(clean)) return null
  const step = totpStep(ms)
  for (let s = step - window; s <= step + window; s += 1) {
    if (totpAt(secretBuffer, s, digits) === clean) return s
  }
  return null
}

// otpauth URI（供验证器扫码导入）
export function otpauthUri({
  secretBase32,
  issuer = '融智 Agent',
  account = '',
  digits = TOTP_DIGITS,
  period = TOTP_STEP_SECONDS,
}) {
  const label = issuer + (account ? `:${account}` : '')
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}
