import { openDatabase, DEFAULT_DB_PATH, DATA_DIR } from './connection.js'
import { createSchema } from './schema.js'
import { migrate } from './migrate.js'
import { seedIfEmpty } from './seed.js'

// 初始化数据库：打开连接、确保表结构存在、执行增量迁移，可选写入种子数据。
// seed = true  仅用于 npm run db:init（首次创建时灌入演示数据，重复执行不重复插入）。
// seed = false 用于后端普通启动（只确保结构存在并迁移，不灌入、不清空数据）。
export function initDatabase({ dbPath = DEFAULT_DB_PATH, seed = false } = {}) {
  const db = openDatabase(dbPath)
  createSchema(db)
  migrate(db) // 增量迁移：旧库补列 + 回填，幂等
  let seeded = false
  if (seed) {
    seeded = seedIfEmpty(db).seeded
  }
  return { db, path: dbPath, seeded }
}

export { openDatabase, DEFAULT_DB_PATH, DATA_DIR }
export { createSchema } from './schema.js'
export { migrate } from './migrate.js'
export { seedIfEmpty } from './seed.js'
