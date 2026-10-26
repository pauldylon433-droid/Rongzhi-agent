// 初始化数据库（建表 + 迁移 + 可选种子数据）。
// 路径规则：
//   * 显式设置 DB_PATH 时，只使用该路径；空字符串、仅空白或非法值直接失败，
//     绝不静默回退到开发默认库。
//   * 未设置 DB_PATH 时才使用 DEFAULT_DB_PATH。
// 该脚本可重复执行：已有数据的库只做幂等建表 / 迁移，不重复灌入种子。
import { resolve } from 'node:path'
import { initDatabase, DEFAULT_DB_PATH } from '../src/db/index.js'

const raw = process.env.DB_PATH
const explicit = raw !== undefined && raw !== null && String(raw).trim() !== ''
if (raw !== undefined && !explicit) {
  console.error('[初始化失败] DB_PATH 已设置但为空；为避免误改开发库，拒绝执行（未回退默认库）')
  process.exit(1)
}
const dbPath = explicit ? resolve(String(raw).trim()) : DEFAULT_DB_PATH

let result
try {
  result = initDatabase({ dbPath, seed: true })
} catch (e) {
  console.error(`[初始化失败] ${e && e.message ? e.message : e}`)
  process.exit(1)
}
const { db, path, seeded } = result

console.log(`数据库文件：${path}`)
console.log(seeded ? '已初始化：建表 + 写入模拟数据' : '检测到已有数据：跳过种子数据（未重复插入、未清空）')

const tables = ['users', 'accounts', 'transactions', 'cards', 'subscriptions', 'audit_logs']
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
  console.log(`  ${t.padEnd(14)} ${n} 条`)
}

db.close()
