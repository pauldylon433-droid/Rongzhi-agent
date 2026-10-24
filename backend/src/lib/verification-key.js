// TOTP 密钥的加密主密钥：独立于数据库，保存在后端环境变量或受限本地文件。
// 优先级：环境变量 VERIFICATION_KEY（base64 32 字节）> 本地文件 backend/data/.verification-key。
// 禁止硬编码、禁止进入 Git（.gitignore 已排除）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR } from '../db/connection.js'

export const VERIFICATION_KEY_PATH = join(DATA_DIR, '.verification-key')

function parseKey(b64) {
  if (!b64 || !String(b64).trim()) return null
  const key = Buffer.from(String(b64).trim(), 'base64')
  return key.length === 32 ? key : null
}

// 读取主密钥；缺失或非法返回 null（此时红色转账保持阻断）。
// 公网演示模式（PUBLIC_DEMO=1）只允许使用环境变量 VERIFICATION_KEY，绝不读取本地开发主密钥文件，
// 避免把开发环境的密钥 / 验证绑定带到公网实例。
export function loadVerificationKey() {
  const envKey = parseKey(process.env.VERIFICATION_KEY)
  if (envKey) return envKey
  if (process.env.PUBLIC_DEMO === '1') return null
  try {
    if (!existsSync(VERIFICATION_KEY_PATH)) return null
    return parseKey(readFileSync(VERIFICATION_KEY_PATH, 'utf8'))
  } catch {
    return null
  }
}

// 读取；不存在则生成并写入本地文件（仅 CLI 绑定流程调用）
export function getOrCreateVerificationKey() {
  const existing = loadVerificationKey()
  if (existing) return existing
  const key = randomBytes(32)
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(VERIFICATION_KEY_PATH, key.toString('base64') + '\n', { mode: 0o600 })
  try {
    chmodSync(VERIFICATION_KEY_PATH, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
  return key
}
