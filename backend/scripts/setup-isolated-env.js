// 独立验收环境数据准备脚本（对应「部署前验收 · 三」）。
//
// 在隔离演示库（独立路径，与开发库 data/rongzhi.db 无关）生成 demo 数据，并绑定「测试专用」强验证器，
// 供隔离后端 + 隔离前端做验收。测试凭据为固定非敏感常量（RFC 6238 标准测试向量 + 固定测试主密钥），
// 不读取、不打印、不复用真实 .verification-key / .env；不修改开发库。
//
// 用法：node scripts/setup-isolated-env.js [--db <绝对路径>]
import { initDatabase } from '../src/db/index.js'
import { seedDemoData, checkDemoData } from './seed-demo.js'
import { bindVerification, getVerificationStatus } from '../src/services/verification.js'
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_DB = join(tmpdir(), 'rongzhi-acceptance', 'acceptance.db')

// 测试专用常量（非真实凭据 / 密钥，仅隔离验收环境使用）
const TEST_PASSWORD = 'acceptance-demo-pass'
const TEST_TOTP_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // RFC 6238 标准测试向量（"12345678901234567890"）
const TEST_KEY = Buffer.alloc(32, 0x42) // 32 字节固定测试主密钥

function parseArgs(argv) {
  const a = { db: DEFAULT_DB }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') a.db = argv[++i]
  }
  return a
}

const dbPath = parseArgs(process.argv.slice(2)).db
mkdirSync(dirname(dbPath), { recursive: true })
for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

const { db } = initDatabase({ dbPath, seed: false })
const seeded = seedDemoData(db)
if (!seeded.seeded) {
  console.error(`✗ 演示数据生成失败：${seeded.reason}`)
  db.close()
  process.exit(1)
}
const userId = db.prepare("SELECT id FROM users WHERE name = '张三'").get().id
bindVerification(db, userId, { password: TEST_PASSWORD, totpSecretBase32: TEST_TOTP_B32, encryptionKey: TEST_KEY, matchedStep: 0 })
const status = getVerificationStatus(db, userId)
const chk = checkDemoData(db)
db.close()

const keyB64 = TEST_KEY.toString('base64')
console.log('✓ 独立验收库已就绪：' + dbPath)
console.log('  强验证绑定：' + (status.bound ? '已绑定（测试专用）' : '未绑定'))
console.log('  演示数据校验：' + (chk.ok ? '通过（2 借记卡 + 1 信用卡；paid/open·overdue/unissued）' : chk.problems.join('; ')))
console.log('')
console.log('测试专用凭据（非真实，仅验收环境使用）：')
console.log('  交易密码：' + TEST_PASSWORD)
console.log('  TOTP Base32 密钥：' + TEST_TOTP_B32 + '  （可用任意 TOTP 工具生成 6 位动态码）')
console.log('  主密钥 VERIFICATION_KEY：' + keyB64)
console.log('')
console.log('获取当前动态码（推荐，直接与本机服务端时钟一致）：')
console.log('  node scripts/acceptance-totp.js')
console.log('  说明：手机验证器若与服务器时间不同步，动态码会校验失败；本命令只对隔离验收库有效（真实库会拒绝）。')
console.log('')
console.log('启动隔离后端（Windows PowerShell 示例）：')
console.log("  $env:PORT='4100'")
console.log(`  $env:DB_PATH='${dbPath}'`)
console.log(`  $env:VERIFICATION_KEY='${keyB64}'`)
console.log("  $env:DEEPSEEK_MODEL='deepseek-flash'")
console.log('  node src\\index.js')
