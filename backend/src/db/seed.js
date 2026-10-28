// 模拟数据初始化（可重复执行，不重复插入、不清空、不覆盖）。
//
// 时间约定：交易与订阅的「日历日期」按 Asia/Shanghai（UTC+8，无夏令时）解释，
// 存储时统一转换为 UTC ISO 8601 字符串（带 Z）。见 docs/database-design.md。

const SEED = 20261021 // 固定随机种子，保证生成结果可复现
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

// 确定性伪随机数（mulberry32）
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1))
}

// 当前 Asia/Shanghai 的 年/月/日
function shanghaiParts(ms = Date.now()) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// 将 Asia/Shanghai 本地日期时间转换为 UTC ISO 字符串用于存储
function shanghaiToUtcIso(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS).toISOString()
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// 当前月及前两个月（按上海时间），按时间升序返回
function recentMonths(now) {
  const months = []
  for (let i = 2; i >= 0; i--) {
    let y = now.year
    let m = now.month - i
    if (m <= 0) {
      m += 12
      y -= 1
    }
    months.push({ year: y, month: m, days: daysInMonth(y, m) })
  }
  return months
}

// 生成交易数组（不含 user_id/account_id，稍后填充）
function buildTransactions(rand, now, months) {
  const txs = []

  // 收入：每月工资（当月 + 前两月，各一笔）
  for (const mo of months) {
    txs.push({
      direction: 'income',
      amount_cents: 1280000,
      category: '收入',
      merchant: '薪资发放',
      description: '月度工资',
      transaction_at: shanghaiToUtcIso(mo.year, mo.month, 5, 9, 0),
      status: 'posted',
    })
  }

  // 收入：当月奖金
  txs.push({
    direction: 'income',
    amount_cents: 300000,
    category: '收入',
    merchant: '季度奖金',
    description: '季度奖金',
    transaction_at: shanghaiToUtcIso(now.year, now.month, 20, 10, 0),
    status: 'posted',
  })

  // 支出：覆盖六大类别
  const expensePool = [
    { category: '餐饮', merchants: ['美团外卖', '星巴克', '海底捞', '麦当劳', '瑞幸咖啡'], min: 1500, max: 18000 },
    { category: '购物', merchants: ['京东商城', '淘宝', '拼多多', '优衣库'], min: 5000, max: 50000 },
    { category: '交通', merchants: ['滴滴出行', '中国石化', '12306', '地铁'], min: 500, max: 12000 },
    { category: '娱乐', merchants: ['腾讯视频', '网易云音乐', '万达影城', 'Steam'], min: 1500, max: 15000 },
    { category: '住房', merchants: ['物业费', '国家电网', '自来水公司'], min: 8000, max: 60000 },
    { category: '订阅扣费', merchants: ['爱奇艺', 'QQ音乐', 'iCloud', 'Keep'], min: 1500, max: 9000 },
  ]

  for (const cat of expensePool) {
    for (let i = 0; i < 9; i++) {
      const mo = months[Math.floor(rand() * months.length)]
      const day = 1 + Math.floor(rand() * mo.days)
      const merchant = cat.merchants[Math.floor(rand() * cat.merchants.length)]
      txs.push({
        direction: 'expense',
        amount_cents: randInt(rand, cat.min, cat.max),
        category: cat.category,
        merchant,
        description: cat.category === '订阅扣费' ? '订阅自动扣费' : '日常消费',
        transaction_at: shanghaiToUtcIso(
          mo.year,
          mo.month,
          day,
          8 + Math.floor(rand() * 12),
          Math.floor(rand() * 60),
        ),
        status: 'posted',
      })
    }
  }

  // 按交易时间升序排序
  txs.sort((a, b) => (a.transaction_at < b.transaction_at ? -1 : a.transaction_at > b.transaction_at ? 1 : 0))

  // 最近两笔支出标记为 pending（待入账，不计入余额）
  let pendingMarked = 0
  for (let i = txs.length - 1; i >= 0 && pendingMarked < 2; i--) {
    if (txs[i].direction === 'expense') {
      txs[i].status = 'pending'
      pendingMarked += 1
    }
  }

  // 未来时间（相对种子运行时刻）的交易尚未发生，统一标记为 pending，
  // 避免未来交易被标为 posted，导致账户余额与已入账流水口径不一致。
  const nowIso = new Date().toISOString()
  for (const t of txs) {
    if (t.transaction_at > nowIso) {
      t.status = 'pending'
    }
  }

  return txs
}

export function seedIfEmpty(db) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  if (existing > 0) {
    return { seeded: false }
  }

  const rand = mulberry32(SEED)
  const now = shanghaiParts()
  const months = recentMonths(now)
  const txs = buildTransactions(rand, now, months)

  // 账户余额 = 期初余额 + 已入账收入 - 已入账支出
  const OPENING_BALANCE_CENTS = 800000 // ¥8000
  // 演示数据的业务日期（开户/开卡日期），与记录创建时间 created_at 区分
  const OPENED_ON = '2026-08-01'
  const ISSUED_ON = '2026-08-01'
  let postedIncome = 0
  let postedExpense = 0
  for (const t of txs) {
    if (t.status !== 'posted') continue
    if (t.direction === 'income') postedIncome += t.amount_cents
    else postedExpense += t.amount_cents
  }
  const balanceCents = OPENING_BALANCE_CENTS + postedIncome - postedExpense

  const subscriptions = [
    { merchant: '爱奇艺会员', amount_cents: 2500, billing_cycle: 'monthly', status: 'active', day: 15 },
    { merchant: 'QQ音乐豪华绿钻', amount_cents: 1500, billing_cycle: 'monthly', status: 'active', day: 18 },
    { merchant: 'iCloud 200GB', amount_cents: 2100, billing_cycle: 'monthly', status: 'active', day: 10 },
    { merchant: 'Keep 会员', amount_cents: 2500, billing_cycle: 'monthly', status: 'paused', day: 20 },
    { merchant: '知乎盐选会员', amount_cents: 1900, billing_cycle: 'monthly', status: 'cancelled', day: null },
    { merchant: 'Adobe 摄影计划', amount_cents: 8800, billing_cycle: 'yearly', status: 'active', day: 5 },
  ]

  // 计算下次扣费日期（未来），不会提前生成为已发生交易
  function nextBillingDate(cycle, day) {
    if (day == null) return null
    if (cycle === 'yearly') {
      return shanghaiToUtcIso(now.year + 1, now.month, day, 9, 0)
    }
    let y = now.year
    let m = now.month + 1
    if (m > 12) {
      m = 1
      y += 1
    }
    return shanghaiToUtcIso(y, m, day, 9, 0)
  }

  const createdAt = new Date().toISOString()

  const insertUser = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)')
  const insertAccount = db.prepare(
    `INSERT INTO accounts
      (user_id, account_name, opening_balance_cents, balance_cents, currency, status, opened_on, created_at)
     VALUES
      (@user_id, @account_name, @opening_balance_cents, @balance_cents, @currency, @status, @opened_on, @created_at)`,
  )
  const insertTx = db.prepare(
    `INSERT INTO transactions
      (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status)
     VALUES
      (@user_id, @account_id, @direction, @amount_cents, @category, @merchant, @description, @transaction_at, @status)`,
  )
  const insertCard = db.prepare(
    `INSERT INTO cards
      (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, created_at)
     VALUES
      (@user_id, @account_id, @masked_card_number, @card_type, @status, @daily_limit_cents, @issued_on, @created_at)`,
  )
  const insertSub = db.prepare(
    `INSERT INTO subscriptions
      (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, created_at)
     VALUES
      (@user_id, @account_id, @merchant, @amount_cents, @billing_cycle, @next_billing_date, @status, @created_at)`,
  )

  db.transaction(() => {
    const userId = insertUser.run('张三', createdAt).lastInsertRowid

    const accountId = insertAccount.run({
      user_id: userId,
      account_name: '人民币活期账户',
      opening_balance_cents: OPENING_BALANCE_CENTS,
      balance_cents: balanceCents,
      currency: 'CNY',
      status: 'active',
      opened_on: OPENED_ON,
      created_at: createdAt,
    }).lastInsertRowid

    insertCard.run({
      user_id: userId,
      account_id: accountId,
      masked_card_number: '6222 **** **** 1234',
      card_type: '借记卡',
      status: 'active',
      daily_limit_cents: 5000000, // ¥50000
      issued_on: ISSUED_ON,
      created_at: createdAt,
    })

    for (const t of txs) {
      insertTx.run({ user_id: userId, account_id: accountId, ...t })
    }

    for (const s of subscriptions) {
      insertSub.run({
        user_id: userId,
        account_id: accountId,
        merchant: s.merchant,
        amount_cents: s.amount_cents,
        billing_cycle: s.billing_cycle,
        next_billing_date: nextBillingDate(s.billing_cycle, s.day),
        status: s.status,
        created_at: createdAt,
      })
    }
  })()

  return { seeded: true }
}
