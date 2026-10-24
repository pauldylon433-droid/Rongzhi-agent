// 公网演示库初始化（PUBLIC_DEMO=1 时使用）。
//
// 只在数据库文件不存在时调用：
//   1) initDatabase(seed:true) 写入基础模拟数据（1 账户 / 1 借记卡 / 6 订阅 / 58 条流水）；
//   2) 复用已验证的增量加卡逻辑，追加第二张借记卡（含样例流水）与一张信用卡（含消费 / 账单样例）。
// 不读取、复制或修改开发库；不携带任何会话、操作单、验证绑定或密钥。
import {
  applyBaseCards, applyDebitSamples, applyConsumption,
} from '../../scripts/add-existing-user-cards.js'
import { bindVerification, getVerificationStatus } from '../services/verification.js'
import { loadVerificationKey } from '../lib/verification-key.js'
import { base32Decode } from '../lib/totp.js'

export const PUBLIC_DEMO_USER_NAME = '张三'

// 追加第 2 张借记卡 + 1 张信用卡及代表性样例（幂等：apply* 内部先查后插）
export function seedPublicDemoExtras(db) {
  const user = db.prepare('SELECT id, name FROM users WHERE name = ?').get(PUBLIC_DEMO_USER_NAME)
  if (!user) throw new Error('公网演示库缺少基础演示用户，无法追加多卡数据')
  const base = applyBaseCards(db, user.id)
  const debitSamples = applyDebitSamples(db, user.id, base.debitAccountId)
  const creditSamples = applyConsumption(db, user.id, base.creditCaId)
  return { userId: user.id, base, debitSamples, creditSamples }
}

// 公网强验证：仅在环境变量同时提供 VERIFICATION_KEY / DEMO_VERIFICATION_PASSWORD / DEMO_TOTP_SECRET
// 且当前未绑定时执行一次绑定。返回值只包含状态原因，不包含任何口令 / 密钥内容。
export function maybeBindPublicVerification(db) {
  const password = process.env.DEMO_VERIFICATION_PASSWORD || ''
  const secret = process.env.DEMO_TOTP_SECRET || ''
  const key = loadVerificationKey() // 公网模式下只读环境变量，绝不读取本地开发主密钥文件
  if (!key || !password || !secret) return { bound: false, reason: 'not_configured' }
  if (password.length < 8) return { bound: false, reason: 'password_too_short' }
  if (!/^[A-Z2-7]+=*$/i.test(secret.trim())) return { bound: false, reason: 'secret_invalid' }
  const secretBuf = base32Decode(secret)
  if (!secretBuf || secretBuf.length < 10) return { bound: false, reason: 'secret_invalid' }

  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(PUBLIC_DEMO_USER_NAME)
  if (!user) return { bound: false, reason: 'no_user' }
  const status = getVerificationStatus(db, user.id)
  if (status.bound) return { bound: true, reason: 'already_bound' }
  bindVerification(db, user.id, {
    password,
    totpSecretBase32: secret.trim().toUpperCase(),
    encryptionKey: key,
    matchedStep: 0,
  })
  return { bound: true, reason: 'bound' }
}
