import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 基于当前模块文件位置解析后端根目录，保证数据库路径不随运行命令所在目录变化
const MODULE_DIR = dirname(fileURLToPath(import.meta.url)) // backend/src/db
const BACKEND_DIR = join(MODULE_DIR, '..', '..') // backend

export const DATA_DIR = join(BACKEND_DIR, 'data')
export const DEFAULT_DB_PATH = join(DATA_DIR, 'rongzhi.db')

// 打开数据库连接：启用 WAL 与外键约束
export function openDatabase(dbPath = DEFAULT_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000') // 迁移/并发访问时避免 database is locked
  return db
}
