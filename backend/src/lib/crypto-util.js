// 交易密码哈希与 TOTP 密钥认证加密。
// 密码：scrypt + 随机盐，不存明文，比较用 timingSafeEqual 防时序侧信道。
// TOTP 密钥：AES-256-GCM 认证加密（须可解密使用，不能用不可逆哈希替代）。
import { scryptSync, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64 // scrypt 派生 64 字节
const SALT_BYTES = 16
const GCM_IV_BYTES = 12

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return { salt: salt.toString('base64'), hash: hash.toString('base64') }
}

export function verifyPassword(password, saltB64, hashB64) {
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = scryptSync(String(password), salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function normalizeKey(key) {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key).trim(), 'base64')
}

// 加密明文（返回 { iv, tag, data }，均 base64）
export function encryptSecret(plaintext, key) {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', normalizeKey(key), iv)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') }
}

// 解密；认证失败（密钥错/密文被篡改）抛错
export function decryptSecret(payload, key) {
  const decipher = createDecipheriv('aes-256-gcm', normalizeKey(key), Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()])
}

export function randomKeyBase64(bytes = 32) {
  return randomBytes(bytes).toString('base64')
}
