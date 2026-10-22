import { initDatabase } from '../src/db/index.js'

const { db, path, seeded } = initDatabase({ seed: true })

console.log(`数据库文件：${path}`)
console.log(seeded ? '已初始化：建表 + 写入模拟数据' : '检测到已有数据：跳过种子数据（未重复插入、未清空）')

const tables = ['users', 'accounts', 'transactions', 'cards', 'subscriptions', 'audit_logs']
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
  console.log(`  ${t.padEnd(14)} ${n} 条`)
}

db.close()
