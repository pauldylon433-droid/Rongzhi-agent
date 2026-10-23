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
    // 转账单：发起该单的助手会话（可空；独立转账页建单为 NULL）。用于确认后把权威回执关联回原始会话。
    if (hasTable(db, 'transfer_operations') && !hasColumn(db, 'transfer_operations', 'session_id')) {
      db.exec('ALTER TABLE transfer_operations ADD COLUMN session_id TEXT')
    }
    // 转账单会话索引：在补列后建立（旧库补列 / 新库建表均已有该列，幂等；表不存在则跳过）
    if (hasTable(db, 'transfer_operations')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_transfer_operations_session_id ON transfer_operations(session_id)')
    }
    // 唯一关联索引：同一转账单最多对应一条流水，从数据库层面防重复入账
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_transfer_ref ON transactions(transfer_ref)')

    // —— 多银行卡·信用卡：账户类型、交易资金性质与还款关联字段（旧库补列，幂等）——
    // 旧库账户均为活期，回填 'deposit'；信用账户由后续业务创建（建表在 schema.js，随 createSchema 建立）。
    if (!hasColumn(db, 'accounts', 'account_type')) {
      db.exec("ALTER TABLE accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'deposit'")
    }
    // 旧库流水均为普通收支（external）；信用卡还款流水（repayment）由还款业务写入。
    if (!hasColumn(db, 'transactions', 'flow_kind')) {
      db.exec("ALTER TABLE transactions ADD COLUMN flow_kind TEXT NOT NULL DEFAULT 'external'")
    }
    // 信用卡还款流水与还款操作单的关联字段（可空；非还款流水为 NULL）
    if (!hasColumn(db, 'transactions', 'repayment_ref')) {
      db.exec('ALTER TABLE transactions ADD COLUMN repayment_ref TEXT')
    }
    // 唯一关联索引：同一还款操作单最多对应一条还款流水，从数据库层面防重复入账
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_repayment_ref ON transactions(repayment_ref)')

    // —— 多银行卡·信用卡：入账时间（消费 pending→posted 时写入；旧流水回填为 NULL）——
    if (!hasColumn(db, 'transactions', 'posted_at')) {
      db.exec('ALTER TABLE transactions ADD COLUMN posted_at TEXT')
    }

    // —— 信用卡账单出账时间（NULL=未出账；旧库无账单表，由 createSchema 建表，幂等）——
    if (hasTable(db, 'statements') && !hasColumn(db, 'statements', 'issued_at')) {
      db.exec('ALTER TABLE statements ADD COLUMN issued_at TEXT')
    }

    // —— 还款操作单发起会话（可空，仅溯源；确认后据此把权威回执关联回原始会话）——
    if (hasTable(db, 'repayment_operations') && !hasColumn(db, 'repayment_operations', 'session_id')) {
      db.exec('ALTER TABLE repayment_operations ADD COLUMN session_id TEXT')
    }
    if (hasTable(db, 'repayment_operations')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_repayment_operations_session_id ON repayment_operations(session_id)')
    }

    // —— AI 助手会话「当前待确认还款单」引用（旧库补列）——
    if (hasTable(db, 'chat_sessions') && !hasColumn(db, 'chat_sessions', 'pending_repayment_ref')) {
      db.exec('ALTER TABLE chat_sessions ADD COLUMN pending_repayment_ref TEXT')
    }

    // 虚构收款人参考数据（仅当为空时写入，幂等）
    const rcCount = db.prepare('SELECT COUNT(*) AS c FROM transfer_recipients').get().c
    if (rcCount === 0) {
      const ins = db.prepare('INSERT INTO transfer_recipients (name, masked_account) VALUES (?, ?)')
      for (const r of TRANSFER_RECIPIENTS) ins.run(r.name, r.masked_account)
    }
  })()
}
