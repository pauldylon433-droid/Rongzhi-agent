// 演示问题定向回归（SQLite 模式，独立临时库，不碰开发库 / 云库，不调用真实模型）：
// 1) 追问待入账明细：新增只读 get_transactions，能按 status=pending 返回真实商户 / 金额 / 时间；
// 2) 换卡改单：旧单取消与新单成功必须区分，新单仍为待确认且不自动扣款；
// 3) 无关问题不附加旧转账回执；转账状态表补全收款人 / 付款账户；
// 4) 运行上限只输出一条「未完成」提示，沙箱失败不伪装成交易事实。
// 用法：node scripts/verify-demo-fixes.js
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createAssistant } from '../src/services/assistant.js'
import { createTransfer, confirmTransfer, cancelTransfer, getTransfer } from '../src/services/transfers.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-demo-fixes-test.db')
const MONTH = '2026-10'
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function makeScriptedMock(script) {
  let i = 0
  const calls = []
  const fn = async ({ messages }) => {
    calls.push(JSON.parse(JSON.stringify(messages)))
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { total_tokens: 1 } }
  }
  fn.calls = calls
  return fn
}
function buildDb(path) {
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
  const db = openDatabase(path)
  createSchema(db)
  migrate(db)
  const userId = db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid
  const insertAccount = db.prepare(
    `INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
     VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active')`,
  )
  const acct1 = insertAccount.run(userId, '日常活期账户', 500000, 500000).lastInsertRowid
  const acct2 = insertAccount.run(userId, '储蓄活期账户', 250000, 250000).lastInsertRowid
  return { db, userId, acct1, acct2 }
}
function seedTransactions(db, userId, acct1) {
  const insert = db.prepare(
    `INSERT INTO transactions (user_id, account_id, direction, amount_cents, category, merchant, description,
       transaction_at, posted_at, status, flow_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external')`,
  )
  insert.run(userId, acct1, 'expense', 30000, '转账', '韩梅梅', '待入账转账',
    '2026-10-20T02:00:00.000Z', null, 'pending')
  insert.run(userId, acct1, 'expense', 10000, '餐饮', '星巴克', '咖啡',
    '2026-10-12T02:00:00.000Z', '2026-10-12T02:00:00.000Z', 'posted')
}
function balanceOf(db, accountId) {
  return db.prepare('SELECT balance_cents AS b FROM accounts WHERE id = ?').get(accountId).b
}
function txCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE flow_kind = ?').get('external').c
}
function inSameSessionSystem(mock) {
  return (mock.calls[0] || []).find((m) => m.role === 'system')?.content || ''
}

try {
  const { db, userId, acct1, acct2 } = buildDb(DB_PATH)
  seedTransactions(db, userId, acct1)

  // —— 1. 先分析支出，再追问待入账明细 ——
  {
    const mock = makeScriptedMock([
      { toolCalls: [tc('a1', 'get_monthly_analytics', { month: MONTH })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r1 = await assistant.chat({ message: '分析这一个月的支出' })
    check('1.1 首轮账单统计成功且不含旧转账回执',
      r1.toolRecords.some((t) => t.name === 'get_monthly_analytics' && t.status === 'ok')
        && r1.reply.includes('账单统计') && !r1.reply.includes('转账操作单'), r1.reply)

    const mock2 = makeScriptedMock([
      { toolCalls: [tc('t1', 'get_transactions', { month: MONTH, status: 'pending' })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant2 = createAssistant({ db, demoUserId: userId, chatFn: mock2 })
    // 复用同一会话：先让 assistant2 载入会话，再追问
    const r2 = await assistant2.chat({ message: '待入账的这一笔是什么', sessionId: r1.sessionId })
    const rec = r2.toolRecords.find((t) => t.name === 'get_transactions')
    check('1.2 追问调用真实明细工具且成功', rec?.status === 'ok' && rec?.data?.rows?.length === 1, JSON.stringify(rec?.data || rec?.error))
    check('1.3 明细含真实商户 / 金额 / 待入账状态',
      r2.reply.includes('韩梅梅') && r2.reply.includes('300.00 元') && r2.reply.includes('待入账'), r2.reply)
    check('1.4 不再出现沙箱失败 / 调用上限 / 重复未完成提示',
      !/沙箱分析失败|未返回可用数据|模型调用上限|本轮回答未完成/.test(r2.reply)
        && r2.incomplete === false, r2.reply)
    check('1.5 明细块为服务端核验块',
      (r2.reply_blocks || []).some((b) => b.kind === 'transactions' && b.authoritative === true),
      JSON.stringify((r2.reply_blocks || []).map((b) => b.kind)))
  }

  // —— 2. 待入账无数据时如实说明，不编造 ——
  {
    const mock = makeScriptedMock([
      { toolCalls: [tc('t2', 'get_transactions', { month: '2025-01', status: 'pending' })] },
      { content: '{"kind":"clarification","code":"no_data"}' },
    ])
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r = await assistant.chat({ message: '2025年1月待入账的是哪一笔' })
    check('2.1 无记录时返回空结果并如实说明',
      r.toolRecords[0]?.status === 'ok' && r.toolRecords[0]?.data?.rows?.length === 0
        && /没有返回可展示的数据/.test(r.reply) && !r.reply.includes('韩梅梅'), r.reply)
  }

  // —— 3. 换卡改单：旧单取消 / 新单待确认，不得自动扣款 ——
  {
    const bal1Before = balanceOf(db, acct1)
    const bal2Before = balanceOf(db, acct2)
    const mock = makeScriptedMock([
      { toolCalls: [tc('p1', 'prepare_transfer', { recipient_id: 2, amount_yuan: '901', account_id: acct1 })] },
      { content: '已生成待确认转账单。' },
      { toolCalls: [tc('p2', 'prepare_transfer', { recipient_id: 2, amount_yuan: '901', account_id: acct2 })] },
      { content: '旧单仍待确认。（模型旧文案，应被服务端替换）' },
      { content: '' }, // 保险：若仍请求模型，返回空
    ])
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r1 = await assistant.chat({ message: '向韩梅梅转901元，用日常活期账户' })
    const oldRef = r1.toolRecords.find((t) => t.name === 'prepare_transfer')?.data?.ref_no
    const r2 = await assistant.chat({ message: '取消旧单，改用储蓄活期账户转901元', sessionId: r1.sessionId })
    const prep = r2.toolRecords.find((t) => t.name === 'prepare_transfer')
    const newRef = prep?.data?.ref_no

    check('3.1 新单已生成且为待确认 / 黄色确认',
      prep?.status === 'ok' && prep?.data?.status === 'pending' && prep?.data?.risk_level === 'yellow', JSON.stringify(prep?.data && { s: prep.data.status, r: prep.data.risk_level }))
    check('3.2 旧单真实取消，新单使用第二张卡',
      getTransfer(db, userId, oldRef)?.status === 'cancelled'
        && prep?.data?.from_account_id === acct2 && prep?.data?.from_account_name === '储蓄活期账户',
      JSON.stringify({ old: getTransfer(db, userId, oldRef)?.status, acct: prep?.data?.from_account_id }))
    check('3.3 回复只展示新单服务端操作块，不把旧单取消当成本轮结果',
      r2.reply.includes('转账操作单（服务端核验）') && r2.reply.includes(newRef)
        && r2.reply.includes('901.00 元') && r2.reply.includes('待确认')
        && !r2.reply.includes('该笔转账已取消') && !r2.reply.includes('转账成功'), r2.reply)
    check('3.3b 建单返回旧单真实状态供界面区分新旧单',
      prep?.data?.notice?.includes('已取消原待确认转账单')
        && prep?.data?.previous?.ref_no === oldRef && prep?.data?.previous?.status === 'cancelled',
      JSON.stringify(prep?.data?.previous))
    check('3.4 改单不扣款',
      balanceOf(db, acct1) === bal1Before && balanceOf(db, acct2) === bal2Before,
      `${bal1Before}->${balanceOf(db, acct1)} / ${bal2Before}->${balanceOf(db, acct2)}`)

    const beforeTx = txCount(db)
    const confirmed = confirmTransfer(db, userId, newRef)
    check('3.5 新单确认成功且只扣一次', confirmed.outcome === 'completed'
      && balanceOf(db, acct1) === bal1Before && balanceOf(db, acct2) === bal2Before - 90100
      && txCount(db) === beforeTx + 1,
    JSON.stringify({ outcome: confirmed.outcome, bal2: balanceOf(db, acct2), tx: txCount(db) }))
    const receipt = getTransfer(db, userId, newRef)
    check('3.6 回执保留付款账户 / 收款人',
      receipt.from_account_name === '储蓄活期账户' && receipt.recipient_name === '韩梅梅',
      JSON.stringify({ from: receipt.from_account_name, to: receipt.recipient_name }))
    const again = confirmTransfer(db, userId, newRef)
    check('3.7 重复确认幂等，不重复扣款', again.outcome === 'completed'
      && balanceOf(db, acct2) === bal2Before - 90100, `${again.outcome}/${balanceOf(db, acct2)}`)
    check('3.8 旧单确认仍被拒绝，余额不变',
      confirmTransfer(db, userId, oldRef).outcome === 'cancelled'
        && balanceOf(db, acct1) === bal1Before && balanceOf(db, acct2) === bal2Before - 90100)

    // 换卡后再建一笔，累计金额超过 1000 元：必须转红色强验证，普通确认不得扣款
    const mock3 = makeScriptedMock([
      { toolCalls: [tc('p3', 'prepare_transfer', { recipient_id: 2, amount_yuan: '200', account_id: acct1 })] },
      { content: '已生成待确认转账单。' },
    ])
    const assistant3 = createAssistant({ db, demoUserId: userId, chatFn: mock3 })
    const r3 = await assistant3.chat({ message: '再向韩梅梅转200元，用日常活期账户' })
    const prep3 = r3.toolRecords.find((t) => t.name === 'prepare_transfer')
    check('3.9 换卡后的新单按累计金额判定为红色强验证',
      prep3?.status === 'ok' && prep3?.data?.status === 'needs_verification'
        && prep3?.data?.risk_level === 'red', JSON.stringify(prep3?.data && { s: prep3.data.status, r: prep3.data.risk_level }))
    const bal1 = balanceOf(db, acct1)
    const direct = confirmTransfer(db, userId, prep3.data.ref_no)
    check('3.10 红色单不能被普通确认绕过，不扣款',
      direct.outcome === 'needs_verification' && balanceOf(db, acct1) === bal1,
      `${direct.outcome}/${balanceOf(db, acct1)}`)
    check('3.11 红色单可取消且不扣款',
      cancelTransfer(db, userId, prep3.data.ref_no).outcome === 'cancelled'
        && balanceOf(db, acct1) === bal1)
  }

  // —— 4. 无关问题不附加旧转账回执；明确问到时补全字段 ——
  {
    const op = createTransfer(db, userId, {
      recipientId: 2, amountCents: 5000, fromAccountId: acct1, sessionId: 'sess-relevance',
    })
    confirmTransfer(db, userId, op.ref_no)
    db.prepare(
      `INSERT INTO chat_sessions (id, user_id, messages_json, created_at, last_active_at)
       VALUES (?, ?, '[]', ?, ?)`,
    ).run('sess-relevance', userId, Date.now(), Date.now())

    const mock = makeScriptedMock([
      { toolCalls: [tc('a2', 'get_monthly_analytics', { month: MONTH })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r = await assistant.chat({ message: '分析这一个月的支出', sessionId: 'sess-relevance' })
    const system = inSameSessionSystem(mock)
    check('4.1 无关支出问题不注入旧转账回执', !system.includes('[权威回执·最近转账]'), system.slice(0, 80))
    check('4.2 回答只含账单统计，不附加旧转账状态表',
      r.reply.includes('账单统计') && !r.reply.includes('转账操作单') && !r.reply.includes('已完成（已扣款）'), r.reply)

    const mock2 = makeScriptedMock([{ content: '{"kind":"answer"}' }])
    const assistant2 = createAssistant({ db, demoUserId: userId, chatFn: mock2 })
    const r2 = await assistant2.chat({ message: '刚才那笔转账怎么样了', sessionId: 'sess-relevance' })
    check('4.3 明确询问时显示收款人与付款账户，而不是 —',
      r2.reply.includes('韩梅梅') && r2.reply.includes('日常活期账户')
        && !/\| 收款人 \| — \|/.test(r2.reply) && !/\| 付款账户 \| — \|/.test(r2.reply), r2.reply)
  }

  // —— 5. 明细查询边界：账户筛选 / 越权账户 / 非法 limit ——
  {
    const mock = makeScriptedMock([
      { toolCalls: [tc('f1', 'get_transactions', { month: MONTH, account_id: acct2, status: 'pending' })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r = await assistant.chat({ message: '储蓄账户本月待入账明细' })
    const rec = r.toolRecords[0]
    check('5.1 账户筛选只返回该账户记录', rec?.status === 'ok'
      && rec.data.account_id === acct2 && rec.data.rows.length === 0
      && /没有返回(?:可展示的)?数据/.test(r.reply), JSON.stringify({ data: rec?.data, reply: r.reply }))

    const mock2 = makeScriptedMock([
      { toolCalls: [tc('f2', 'get_transactions', { month: MONTH, account_id: 999999 })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant2 = createAssistant({ db, demoUserId: userId, chatFn: mock2 })
    const r2 = await assistant2.chat({ message: '查一下那个账户的明细' })
    check('5.2 非本人账户被拒绝且不返回数据',
      r2.toolRecords[0]?.status === 'error' && /不属于当前用户|未找到该账户/.test(r2.toolRecords[0]?.error || '')
        && !JSON.stringify(r2.reply_blocks || []).includes('韩梅梅'), JSON.stringify(r2.toolRecords[0]))

    const mock3 = makeScriptedMock([
      { toolCalls: [tc('f3', 'get_transactions', { month: MONTH, limit: 51 })] },
      { content: '{"kind":"answer"}' },
    ])
    const assistant3 = createAssistant({ db, demoUserId: userId, chatFn: mock3 })
    const r3 = await assistant3.chat({ message: '多列一些明细' })
    check('5.3 超过 50 条的 limit 被拒绝',
      r3.toolRecords[0]?.status === 'error' && /limit/.test(r3.toolRecords[0]?.error || ''),
      JSON.stringify(r3.toolRecords[0]))
  }

  // —— 6. 模型调用上限：只输出一条未完成提示 ——
  {
    const code = 'function analyze(){ throw new Error("boom") }'
    const script = []
    for (let i = 0; i < 4; i++) {
      script.push({ toolCalls: [tc(`s${i}`, 'analyze_transactions_sandboxed', { month: MONTH, code })] })
    }
    const mock = makeScriptedMock(script)
    const assistant = createAssistant({ db, demoUserId: userId, chatFn: mock })
    const r = await assistant.chat({ message: '用沙箱反复分析支出' })
    check('6.1 达到上限后 incomplete=true 且仅一条未完成提示',
      r.incomplete === true && (r.reply.match(/回答未完成/g) || []).length === 1
        && (r.reply.match(/已达到本轮模型调用上限/g) || []).length === 1
        && !r.reply.includes('999.00'), r.reply)
    check('6.2 沙箱失败不生成交易事实块',
      !(r.reply_blocks || []).some((b) => b.kind === 'transactions' || b.kind === 'sandbox_analysis'))
  }

  db.close()
} catch (e) {
  failures += 1
  console.error('FAIL  未捕获异常:', e && e.stack ? e.stack : e)
} finally {
  for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { rmSync(p, { force: true }) } catch {}
  }
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
