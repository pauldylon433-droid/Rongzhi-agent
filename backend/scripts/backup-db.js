// 开发库一致性备份脚本（结构/数据变更前使用）。
// 使用 SQLite backup API（正确处理 WAL）生成一致性快照，不改动原库。
// 用法：node scripts/backup-db.js [数据库路径]
// 环境变量：BACKUP_DIR 备份目录（默认 backend/data/backups）
import { openDatabase, DEFAULT_DB_PATH, DATA_DIR } from '../src/db/connection.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DB_PATH = process.argv[2] || process.env.DB_PATH || DEFAULT_DB_PATH
const BACKUP_DIR = process.env.BACKUP_DIR || join(DATA_DIR, 'backups')

function fileStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) // YYYYMMDDHHMMSSmmm
}

const db = openDatabase(DB_PATH)
mkdirSync(BACKUP_DIR, { recursive: true })
const dest = join(BACKUP_DIR, `rongzhi.pre-transfer-${fileStamp()}.db`)
await db.backup(dest)
db.close()
console.log(`一致性备份已创建：${dest}`)
