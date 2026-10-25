// 生成本地随机的「公网演示强验证」环境变量值（只在终端打印，不写文件、不读取任何现有密钥）。
//
// 输出三项，由用户自行粘贴到云托管服务端环境变量：
//   VERIFICATION_KEY          base64 32 字节（AES-256-GCM 主密钥）
//   DEMO_TOTP_SECRET          Base32 20 字节（用验证器 App 添加账户，或手工输入）
//   DEMO_VERIFICATION_PASSWORD 由用户自定（≥8 位）；本脚本不生成、不打印密码占位以外的内容
//
// 用法：node scripts/generate-verification-env.js
import { randomBytes } from 'node:crypto'
import { base32Encode } from '../src/lib/totp.js'

const key = randomBytes(32).toString('base64')
const secret = base32Encode(randomBytes(20))

console.log('请将以下值填入云托管服务端环境变量（仅公网演示实例使用，勿提交到仓库）：')
console.log('')
console.log(`VERIFICATION_KEY=${key}`)
console.log(`DEMO_TOTP_SECRET=${secret}`)
console.log('DEMO_VERIFICATION_PASSWORD=<自行设置，≥8 位；不要使用本机开发环境的交易密码>')
console.log('')
console.log('说明：')
console.log('- 公网模式只从环境变量读取 VERIFICATION_KEY，不会读取本地开发主密钥文件。')
console.log('- 实例每次冷启动时，若数据库中尚无验证绑定，会用上述值自动绑定一次（已绑定则不覆盖）。')
console.log('- 用验证器 App 添加账户时选择“手动输入密钥”，粘贴 DEMO_TOTP_SECRET（SHA1 / 6 位 / 30 秒）。')
