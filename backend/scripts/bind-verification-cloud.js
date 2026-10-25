// 为 CloudBase 演示用户一次性绑定强验证（交易密码 + TOTP 密钥加密后写入）。
// 依赖环境变量：CLOUDBASE_RPC_BASE / CLOUDBASE_SERVICE_KEY / VERIFICATION_KEY /
//               DEMO_VERIFICATION_PASSWORD / DEMO_TOTP_SECRET / CLOUDBASE_DEMO_USER_ID
// 已绑定则拒绝覆盖。所有敏感值只从环境读取，不打印、不写文件。
import { getCloudBaseConfig, validateCloudConfig } from '../src/config.js'
import { createCloudRpcClient } from '../src/cloud/rpc-client.js'
import { bindCloudVerification } from '../src/cloud/verification.js'
import { loadVerificationKey } from '../src/lib/verification-key.js'
import { base32Decode } from '../src/lib/totp.js'

const missing = validateCloudConfig()
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}（不显示具体值）`)
  process.exit(1)
}
const password = process.env.DEMO_VERIFICATION_PASSWORD || ''
const secret = (process.env.DEMO_TOTP_SECRET || '').trim().toUpperCase()
const key = loadVerificationKey()
if (!password || password.length < 8) {
  console.error('DEMO_VERIFICATION_PASSWORD 未配置或少于 8 位')
  process.exit(1)
}
if (!key) {
  console.error('VERIFICATION_KEY 未配置或不是 base64 32 字节')
  process.exit(1)
}
if (!/^[A-Z2-7]+=*$/.test(secret) || base32Decode(secret).length < 10) {
  console.error('DEMO_TOTP_SECRET 不是合法 Base32 密钥')
  process.exit(1)
}

const cfg = getCloudBaseConfig()
const client = createCloudRpcClient({ base: cfg.base, serviceKey: cfg.serviceKey })
try {
  const r = await bindCloudVerification({
    client, userId: cfg.demoUserId, password, totpSecretBase32: secret, encryptionKey: key,
  })
  console.log(r && r.outcome === 'already_bound' ? '已绑定（未覆盖）' : '绑定完成')
} catch (e) {
  console.error('[绑定失败]', e && e.message ? e.message : e)
  process.exit(1)
}
