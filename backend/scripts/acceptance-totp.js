// 隔离验收环境 · 本地动态验证码生成器。
//
// 用途：验收人员在无法使用手机验证器（或验证器密钥 / 时间不同步）时，用本机生成隔离测试账户
// 当前 6 位 TOTP 动态码。仅对「隔离验收库 + 测试主密钥」有效：
//   - 默认只打开 %TEMP%\rongzhi-acceptance\acceptance.db（setup-isolated-env.js 生成的隔离库）；
//   - 用固定测试主密钥（32 字节 0x42）解密绑定；解密失败即判定「非隔离测试绑定」并拒绝输出，
//     因此对真实开发库的绑定（由 backend/data/.verification-key 加密）会直接拒绝，不会泄露真实验证码。
//   - 只输出动态码与剩余有效秒数，不输出密钥、密文或密码哈希。
//
// 用法：node scripts/acceptance-totp.js [--db <隔离库绝对路径>] [--user-id <id>]
import Database from 'better-sqlite3'
import { decryptSecret } from '../src/lib/crypto-util.js'
import { totpAt, totpStep, TOTP_STEP_SECONDS } from '../src/lib/totp.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_DB = join(tmpdir(), 'rongzhi-acceptance', 'acceptance.db')
const TEST_KEY = Buffer.alloc(32, 0x42) // 与 setup-isolated-env.js 一致的测试主密钥

function parseArgs(argv) {
  const a = { db: DEFAULT_DB, userId: 1 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') a.db = argv[++i]
    else if (argv[i] === '--user-id') a.userId = Number(argv[++i])
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.db)) {
  console.error(`✗ 隔离验收库不存在：${args.db}\n  请先运行 node scripts/setup-isolated-env.js`)
  process.exit(1)
}

const db = new Database(args.db, { readonly: true, fileMustExist: true })
const binding = db.prepare('SELECT totp_secret_enc, enabled FROM verification_bindings WHERE user_id = ?').get(args.userId)
db.close()

if (!binding || binding.enabled !== 1) {
  console.error(`✗ 用户 id=${args.userId} 未绑定验证器（或已停用）`)
  process.exit(1)
}

let secret
try {
  secret = decryptSecret(JSON.parse(binding.totp_secret_enc), TEST_KEY)
} catch {
  console.error('✗ 无法用隔离测试主密钥解密该绑定，判定为非隔离验收库，拒绝输出动态码。')
  console.error('  （真实开发库请使用已绑定的手机验证器；本脚本不接触真实密钥。）')
  process.exit(1)
}

const now = Date.now()
const step = totpStep(now)
const code = totpAt(secret, step)
const remain = TOTP_STEP_SECONDS - Math.floor((now / 1000) % TOTP_STEP_SECONDS)

console.log(`隔离动态验证码：${code}（${remain} 秒后失效）`)
console.log('提示：请在 30 秒内提交；若提示「动态验证码错误或已过期」，重新运行本命令获取新码。')
