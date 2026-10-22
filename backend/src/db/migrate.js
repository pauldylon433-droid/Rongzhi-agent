// 数据库增量迁移：为已存在的旧库补齐新增字段并回填演示业务日期。
// 幂等：重复执行不会重复加列、不会覆盖已有值，也不会改动交易与余额。

const DEMO_OPENED_ON = '2026-08-01' // 演示数据：账户开户日期
const DEMO_ISSUED_ON = '2026-08-01' // 演示数据：银行卡开卡日期

// 虚构收款人参考数据（模拟转账的收款方，仅演示用）
const TRANSFER_RECIPIENTS = [
  { name: '李雷', masked_account: '6217 **** **** 8801' },
  { name: '韩梅梅', masked_account: '6217 **** **** 8802' },
  { name: '王强', masked_account: '6228 **** **** 3391' },
  { name: '赵敏', masked_account: '6228 **** **** 3392' },
]

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((r) => r.name === column)
}

function hasTable(db, table) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table)
}

export function migrate(db) {
  db.transaction(() => {
    // 账户：开户日期（缺失时回填演示业务日期）
    if (!hasColumn(db, 'accounts', 'opened_on')) {
      db.exec('ALTER TABLE accounts ADD COLUMN opened_on TEXT')
    }
    db.prepare('UPDATE accounts SET opened_on = ? WHERE opened_on IS NULL').run(DEMO_OPENED_ON)

    // 银行卡：开卡日期（缺失时回填演示业务日期）
    if (!hasColumn(db, 'cards', 'issued_on')) {
      db.exec('ALTER TABLE cards ADD COLUMN issued_on TEXT')
    }
    db.prepare('UPDATE cards SET issued_on = ? WHERE issued_on IS NULL').run(DEMO_ISSUED_ON)

    // 银行卡：状态版本（乐观锁，冻结/解冻确认时校验建单后卡片是否被改动；旧库回填为 1）
    if (!hasColumn(db, 'cards', 'version')) {
      db.exec('ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    }

    // 订阅：状态版本（乐观锁，暂停/取消/恢复确认时校验建单后订阅是否被改动；旧库回填为 1）
    if (hasTable(db, 'subscriptions') && !hasColumn(db, 'subscriptions', 'version')) {
      db.exec('ALTER TABLE subscriptions ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    }

    // 订阅操作单：AI 助手会话「当前待确认订阅操作单」引用（旧库补列）
    if (hasTable(db, 'chat_sessions') && !hasColumn(db, 'chat_sessions', 'pending_subscription_op_ref')) {
      db.exec('ALTER TABLE chat_sessions ADD COLUMN pending_subscription_op_ref TEXT')
    }

    // 模拟转账：交易流水与转账单的关联字段（可空；非转账流水为 NULL）
    if (!hasColumn(db, 'transactions', 'transfer_ref')) {
      db.exec('ALTER TABLE transactions ADD COLUMN transfer_ref TEXT')
    }
    // 唯一关联索引：同一转账单最多对应一条流水，从数据库层面防重复入账
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_transfer_ref ON transactions(transfer_ref)')

    // 虚构收款人参考数据（仅当为空时写入，幂等）
    const rcCount = db.prepare('SELECT COUNT(*) AS c FROM transfer_recipients').get().c
    if (rcCount === 0) {
      const ins = db.prepare('INSERT INTO transfer_recipients (name, masked_account) VALUES (?, ?)')
      for (const r of TRANSFER_RECIPIENTS) ins.run(r.name, r.masked_account)
    }
  })()
}
