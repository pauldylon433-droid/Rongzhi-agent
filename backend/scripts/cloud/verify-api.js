// CloudBase 模式 API 集成测试：真实 HTTP → Node 云路由 → 固定 RPC → PGlite SQL 函数。
// 仅本地测试；不是真实 CloudBase 证据。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { totpAt, totpStep, base32Decode } from '../../src/lib/totp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND = join(HERE, '..', '..')
const STUB = join(HERE, 'rpc-stub.js')
const SVC = 'test-service-key'
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP'
const PASSWORD = 'TestPass123'
const VERIFY_KEY = randomBytes(32).toString('base64')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  [' + detail + ']' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startStub() {
  const p = spawn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STUB_PORT: '0' } })
  let buf = '', err = ''
  p.stderr.on('data', (d) => { err += d })
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => {
      buf += d
      const line = buf.split(/\r?\n/)[0]
      if (/^\d+$/.test(line.trim())) resolve({ proc: p, port: Number(line.trim()) })
    })
    p.on('exit', (c) => reject(new Error(`stub exited ${c}: ${err}`)))
    setTimeout(() => reject(new Error('stub start timeout')), 15000)
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function startBackend(stubPort) {
  const port = await freePort()
  const p = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SKIP_ENV_FILE: '1',
      DB_MODE: 'cloudbase', CLOUDBASE_RPC_BASE: `http://127.0.0.1:${stubPort}`,
      CLOUDBASE_SERVICE_KEY: SVC, CLOUDBASE_DEMO_USER_ID: '1', PORT: String(port),
      VERIFICATION_KEY: VERIFY_KEY, DEMO_VERIFICATION_PASSWORD: PASSWORD, DEMO_TOTP_SECRET: TOTP_SECRET,
    },
  })
  let err = ''
  p.stderr.on('data', (d) => { err += d })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return { proc: p, base }
    } catch { /* wait */ }
  }
  throw new Error(`backend start timeout: ${err}`)
}

const stub = await startStub()
const stubBase = `http://127.0.0.1:${stub.port}`
let backend
try {
  backend = await startBackend(stub.port)
  const BASE = backend.base
  const req = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await r.json() } catch { /* ignore */ }
    return { status: r.status, json }
  }
  const admin = async (path, body) => {
    const r = await fetch(`${stubBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return r.json()
  }
  const snap = () => admin('/__snapshot')
  const callRpc = (fn, op, payload = {}) => admin('/__call', { fn, params: { op, payload } })
  const code = (off = 0) => totpAt(base32Decode(TOTP_SECRET), totpStep() + off)
  const verify = (path, off = 0) => req(path, { method: 'POST', body: { password: PASSWORD, totp: code(off) } })

  let s = await snap()
  const acct1 = s.accounts.find((a) => a.account_name.includes('日常'))
  const acct2 = s.accounts.find((a) => a.account_name.includes('储蓄'))
  const card1 = s.cards.find((c) => c.account_id === acct1.id)
  const card2 = s.cards.find((c) => c.account_id === acct2.id)
  const activeSubs = s.subscriptions.filter((x) => x.status === 'active')
  const credit = s.credit_accounts[0]

  // 只读接口
  let r = await req('/api/accounts')
  check('账户：3 个且含 2 活期 + 1 信用', r.status === 200 && r.json.data.length === 3
    && r.json.data.filter((a) => a.account_type === 'deposit').length === 2
    && r.json.data.filter((a) => a.account_type === 'credit').length === 1)
  r = await req('/api/cards')
  check('银行卡：3 张且借记卡返回余额、信用卡返回额度',
    r.status === 200 && r.json.data.length === 3
    && r.json.data.filter((c) => c.account_type === 'credit' && c.credit_limit_cents > 0).length === 1)
  r = await req('/api/subscriptions')
  check('订阅：6 条且含生效 / 暂停 / 取消', r.status === 200 && r.json.data.length === 6
    && new Set(r.json.data.map((x) => x.status)).size >= 3)

  const month = new Date().toISOString().slice(0, 7)
  r = await req(`/api/transactions?month=${month}&limit=100`)
  check('流水：当前月返回且逐笔结余可追溯', r.status === 200 && r.json.data.length >= 8
    && r.json.data.filter((x) => x.balance_state === 'value').length >= 7, `n=${r.json.data.length}`)
  r = await req(`/api/transactions?account_id=${acct1.id}&limit=100`)
  check('账户筛选：仅返回本人指定账户流水', r.status === 200 && r.json.data.every((x) => x.account_id === acct1.id))
  r = await req(`/api/analytics/monthly?month=${month}`)
  const analyticsBefore = r.json.data
  check('统计：全账户收入 / 支出 / 待入账口径正确',
    r.status === 200 && analyticsBefore.income_cents === 1580000 && analyticsBefore.expense_cents === 960000
    && analyticsBefore.pending.count === 1 && analyticsBefore.repayment_cents === 0,
    JSON.stringify(analyticsBefore))
  r = await req(`/api/analytics/monthly?month=${month}&account_id=${acct1.id}`)
  check('统计：账户筛选后仅统计该账户', r.status === 200 && r.json.data.income_cents === 1280000
    && r.json.data.expense_cents === 780000, JSON.stringify(r.json.data))

  // 转账：黄色确认 + 幂等
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 1, amount_cents: 50000, from_account_id: acct1.id, remark: 'api' } })
  check('转账建单：黄色 pending', r.status === 200 && r.json.data.status === 'pending' && r.json.data.risk_level === 'yellow', JSON.stringify(r.json))
  const yellowRef = r.json.data.ref_no
  r = await req(`/api/transfers/${yellowRef}/confirm`, { method: 'POST', body: { confirm: true } })
  check('转账确认：completed 且返回流水号', r.status === 200 && r.json.data.status === 'completed' && r.json.data.transaction_id > 0)
  const firstTxId = r.json.data.transaction_id
  r = await req(`/api/transfers/${yellowRef}/confirm`, { method: 'POST', body: { confirm: true } })
  s = await snap()
  check('转账确认幂等：同一流水号、只扣一次', r.status === 200 && r.json.data.transaction_id === firstTxId
    && s.accounts.find((a) => a.id === acct1.id).balance_cents === 950000
    && s.transactions.filter((t) => t.transfer_ref === yellowRef).length === 1)

  // 回滚：在审计写入后注入异常
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 2, amount_cents: 30000, from_account_id: acct1.id, remark: 'rollback' } })
  const rbRef = r.json.data.ref_no
  const beforeRb = (await snap()).accounts.find((a) => a.id === acct1.id).balance_cents
  await admin('/__inject_fail', { ref_no: rbRef })
  r = await req(`/api/transfers/${rbRef}/confirm`, { method: 'POST', body: { confirm: true } })
  s = await snap()
  check('事务回滚：审计阶段异常导致整单失败', r.status >= 500, `status=${r.status}`)
  check('事务回滚：操作单仍 pending、余额 / 流水不变',
    s.transfer_operations.find((o) => o.ref_no === rbRef).status === 'pending'
    && s.accounts.find((a) => a.id === acct1.id).balance_cents === beforeRb
    && !s.transactions.some((t) => t.transfer_ref === rbRef))
  await admin('/__clear_fail')
  r = await req(`/api/transfers/${rbRef}/confirm`, { method: 'POST', body: { confirm: true } })
  check('回滚后重试：正常完成', r.status === 200 && r.json.data.status === 'completed')

  // 并发确认（本地桩为单后端，实际串行；只验证幂等，不声称数据库并发）
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 1, amount_cents: 20000, from_account_id: acct1.id, remark: 'conc' } })
  const concRef = r.json.data.ref_no
  check('并发确认前建单为黄色 pending', r.status === 200 && r.json.data.status === 'pending', JSON.stringify(r.json))
  const beforeConc = (await snap()).accounts.find((a) => a.id === acct1.id).balance_cents
  const conc = await Promise.all(Array.from({ length: 5 }, () => req(`/api/transfers/${concRef}/confirm`, { method: 'POST', body: { confirm: true } })))
  s = await snap()
  check('并发重复确认（本地桩串行）：全部成功且同一流水号',
    conc.every((x) => x.status === 200 && x.json.data.status === 'completed')
    && new Set(conc.map((x) => x.json.data.transaction_id)).size === 1,
    conc.map((x) => `${x.status}:${x.json && x.json.data && x.json.data.status}`).join(','))
  check('并发重复确认（本地桩串行）：只扣一次 / 一条流水',
    s.accounts.find((a) => a.id === acct1.id).balance_cents === beforeConc - 20000
    && s.transactions.filter((t) => t.transfer_ref === concRef).length === 1)

  // 红色强验证 + 重放
  await admin('/__clear_totp')
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 2, amount_cents: 120000, from_account_id: acct1.id, remark: 'red' } })
  const red1 = r.json.data.ref_no
  check('红色转账：needs_verification', r.json.data.status === 'needs_verification' && r.json.data.risk_level === 'red')
  const codeRed = code(0)
  r = await req(`/api/transfers/${red1}/verify`, { method: 'POST', body: { password: PASSWORD, totp: codeRed } })
  check('红色转账：TOTP 验证后 completed', r.status === 200 && r.json.data.status === 'completed')
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 3, amount_cents: 120000, from_account_id: acct1.id, remark: 'red2' } })
  const red2 = r.json.data.ref_no
  const beforeReplay = (await snap()).accounts.find((a) => a.id === acct1.id).balance_cents
  r = await req(`/api/transfers/${red2}/verify`, { method: 'POST', body: { password: PASSWORD, totp: codeRed } })
  s = await snap()
  check('防重放：同一时间步跨单被拒（code_reused）', r.status === 409 && r.json.code === 'code_reused', JSON.stringify(r.json))
  check('防重放：第二单保持待验证且未扣款', s.transfer_operations.find((o) => o.ref_no === red2).status === 'needs_verification'
    && s.accounts.find((a) => a.id === acct1.id).balance_cents === beforeReplay)

  // 参数错误使用 DATABASE_22023 → HTTP 400
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 1, amount_cents: 999999999, from_account_id: acct1.id } })
  check('平台 DATABASE_22023：业务错误映射为 400 且文案保留', r.status === 400 && /余额不足/.test(r.json.message), JSON.stringify(r.json))

  // 银行卡：冻结 / 解冻
  await admin('/__clear_totp')
  r = await req('/api/card-operations', { method: 'POST', body: { card_id: card1.id, action: 'freeze' } })
  const freezeRef = r.json.data.ref_no
  r = await req(`/api/card-operations/${freezeRef}/confirm`, { method: 'POST', body: { confirm: true } })
  s = await snap()
  check('银行卡冻结：黄色确认后 status=frozen / version+1', r.status === 200
    && s.cards.find((c) => c.id === card1.id).status === 'frozen'
    && s.cards.find((c) => c.id === card1.id).version === 2)
  r = await req('/api/card-operations', { method: 'POST', body: { card_id: card1.id, action: 'unfreeze' } })
  const unfreezeRef = r.json.data.ref_no
  r = await req(`/api/card-operations/${unfreezeRef}/confirm`, { method: 'POST', body: { confirm: true } })
  check('银行卡解冻：普通确认不能绕过强验证', r.status === 409)
  r = await verify(`/api/card-operations/${unfreezeRef}/verify`, 1)
  s = await snap()
  check('银行卡解冻：TOTP 验证后 active / version+1', r.status === 200
    && s.cards.find((c) => c.id === card1.id).status === 'active'
    && s.cards.find((c) => c.id === card1.id).version === 3)

  // 订阅：暂停 / 恢复 / 更换来源
  await admin('/__clear_totp')
  const sub1 = activeSubs[0]
  r = await req('/api/subscription-operations', { method: 'POST', body: { subscription_id: sub1.id, action: 'pause' } })
  const pauseRef = r.json.data.ref_no
  r = await req(`/api/subscription-operations/${pauseRef}/confirm`, { method: 'POST', body: { confirm: true } })
  s = await snap()
  check('订阅暂停：确认后 paused / version+1', r.status === 200
    && s.subscriptions.find((x) => x.id === sub1.id).status === 'paused'
    && s.subscriptions.find((x) => x.id === sub1.id).version === 2)
  r = await req('/api/subscription-operations', { method: 'POST', body: { subscription_id: sub1.id, action: 'resume' } })
  const resumeRef = r.json.data.ref_no
  r = await verify(`/api/subscription-operations/${resumeRef}/verify`, 1)
  s = await snap()
  check('订阅恢复：TOTP 验证后 active / version+1', r.status === 200
    && s.subscriptions.find((x) => x.id === sub1.id).status === 'active'
    && s.subscriptions.find((x) => x.id === sub1.id).version === 3, JSON.stringify(r.json))
  r = await req('/api/subscription-operations', { method: 'POST', body: { subscription_id: sub1.id, action: 'change_source', to_account_id: acct2.id } })
  const changeRef = r.json.data.ref_no
  check('更换扣款来源：红色待强验证', r.status === 200 && r.json.data.status === 'needs_verification')
  r = await verify(`/api/subscription-operations/${changeRef}/verify`, -1)
  s = await snap()
  check('更换扣款来源：验证后 account_id 更新 / 状态不变', r.status === 200
    && s.subscriptions.find((x) => x.id === sub1.id).account_id === acct2.id
    && s.subscriptions.find((x) => x.id === sub1.id).status === 'active', JSON.stringify(r.json))

  // 还款
  await admin('/__clear_totp')
  r = await req('/api/credit/accounts')
  check('信用卡账户：额度 / 已入账 / 待入账口径', r.status === 200
    && r.json.data[0].posted_outstanding_cents === 150000 && r.json.data[0].pending_occupied_cents === 30000
    && r.json.data[0].available_credit_cents === 320000)
  const acct1BeforeRepay = (await snap()).accounts.find((a) => a.id === acct1.id).balance_cents
  const analyticsPreRepay = (await req(`/api/analytics/monthly?month=${month}`)).json.data
  r = await req('/api/repayments', { method: 'POST', body: { scope: 'all_posted', from_account_id: acct1.id, credit_account_id: credit.id } })
  check('还款建单：金额由服务端计算且需强验证', r.status === 200 && r.json.data.amount_cents === 150000
    && r.json.data.status === 'needs_verification', JSON.stringify(r.json))
  const repayRef = r.json.data.ref_no

  // 还款执行中注入审计异常：扣款 / 冲抵 / 还款流水 / 时间步 / 审计必须整体回滚。
  await admin('/__inject_fail', { ref_no: repayRef })
  const repayCode = code(0)
  r = await req(`/api/repayments/${repayRef}/verify`, { method: 'POST', body: { password: PASSWORD, totp: repayCode } })
  s = await snap()
  const repayOp = s.repayment_operations.find((o) => o.ref_no === repayRef)
  const stmtAfterFail = s.statements.find((x) => Number(x.id) === Number(repayOp.statement_id))
  check('还款失败回滚：整单失败', r.status >= 500, `status=${r.status}`)
  check('还款失败回滚：操作单待验证 / 余额 / 冲抵 / 欠款 / 流水均未变',
    s.repayment_operations.find((o) => o.ref_no === repayRef).status === 'needs_verification'
    && s.accounts.find((a) => a.id === acct1.id).balance_cents === acct1BeforeRepay
    && stmtAfterFail.paid_cents === 0 && s.credit_accounts[0].posted_outstanding_cents === 150000
    && !s.statement_payments.some((p) => p.repayment_ref === repayRef)
    && !s.transactions.some((t) => t.repayment_ref === repayRef))
  await admin('/__clear_fail')

  // 时间步在失败事务中一并回滚，同一验证码可重试。
  r = await req(`/api/repayments/${repayRef}/verify`, { method: 'POST', body: { password: PASSWORD, totp: repayCode } })
  s = await snap()
  const stmt = s.statements.find((x) => Number(x.id) === Number(repayOp.statement_id))
  check('还款：扣款 / 冲抵 / 已入账欠款归零 / 还款流水', r.status === 200
    && s.accounts.find((a) => a.id === acct1.id).balance_cents === acct1BeforeRepay - 150000
    && stmt.paid_cents === 120000 && s.credit_accounts[0].posted_outstanding_cents === 0
    && s.transactions.some((t) => t.repayment_ref === repayRef && t.flow_kind === 'repayment'), JSON.stringify(r.json))
  r = await req(`/api/analytics/monthly?month=${month}`)
  check('还款：统计单列 repayment_cents，不计入支出', r.status === 200
    && r.json.data.repayment_cents === 150000 && r.json.data.expense_cents === analyticsPreRepay.expense_cents
    && r.json.data.net_cents === analyticsPreRepay.net_cents)

  // 跨场景任务
  const nowMonth = new Date().toISOString().slice(0, 7)
  const task = await callRpc('rongzhi_bank_task_write_v1', 'create', { month: nowMonth })
  check('任务：创建订阅审查任务', task.outcome === 'created' && /^task-/.test(task.task_no), JSON.stringify(task))
  r = await req('/api/agent-tasks/recent')
  const taskView = r.json.data.find((t) => t.task_no === task.task_no)
  check('任务：最近任务含只读节点结果', r.status === 200 && taskView
    && taskView.nodes.find((n) => n.node_key === 'monthly_analysis').status === 'completed'
    && taskView.nodes.find((n) => n.node_key === 'subscription_query').status === 'completed')
  const activeNow = (await snap()).subscriptions.filter((x) => x.status === 'active')
  r = await req(`/api/agent-tasks/${task.task_no}/select`, { method: 'POST', body: { subscription_id: activeNow[0].id } })
  check('任务：选择订阅后等待确认并生成暂停单', r.status === 200 && r.json.data.status === 'waiting_confirmation'
    && r.json.data.op_ref, JSON.stringify(r.json))
  const taskOpRef = r.json.data.op_ref
  r = await req(`/api/subscription-operations/${taskOpRef}/confirm`, { method: 'POST', body: { confirm: true } })
  check('任务：关联暂停单确认成功', r.status === 200 && r.json.data.status === 'completed')
  r = await req(`/api/agent-tasks/${task.task_no}`)
  check('任务：对账后 completed 且汇总回执来自真实数据', r.status === 200 && r.json.data.status === 'completed'
    && r.json.data.result_summary && r.json.data.result_summary.expense_cents > 0, JSON.stringify(r.json && r.json.data && r.json.data.status))
  const task2 = await callRpc('rongzhi_bank_task_write_v1', 'create', { month: nowMonth })
  r = await req(`/api/agent-tasks/${task2.task_no}/select`, { method: 'POST', body: { subscription_id: (await snap()).subscriptions.filter((x) => x.status === 'active')[0].id } })
  r = await req(`/api/agent-tasks/${task2.task_no}/pause`, { method: 'POST', body: {} })
  check('任务：暂停后在数据库阻断关联操作单', r.status === 200 && r.json.data.status === 'paused')
  r = await req(`/api/agent-tasks/${task2.task_no}/resume`, { method: 'POST', body: {} })
  check('任务：继续后重新生成待确认单', r.status === 200 && r.json.data.status === 'waiting_confirmation')
  r = await req(`/api/agent-tasks/${task2.task_no}/cancel`, { method: 'POST', body: {} })
  check('任务：取消后终态 cancelled', r.status === 200 && r.json.data.status === 'cancelled')

  // 会话持久化
  const sid = `sess-${Date.now()}`
  const chatTurn = [{ role: 'user', content: '测试消息' }, { role: 'assistant', content: '测试回复' }]
  const saved = await callRpc('rongzhi_bank_chat_write_v1', 'save_turn', {
    session_id: sid, turn_id: `turn-${Date.now()}`, base_version: 0,
    messages: chatTurn, new_messages: chatTurn,
    user_text: '测试消息', reply: '测试回复', tool_records: [], incomplete: false, pointer_at_start: null,
  })
  check('会话：保存一轮对话', saved.outcome === 'saved')
  r = await req('/api/assistant/current')
  check('会话：当前对话可恢复', r.status === 200 && r.json.data.sessionId === sid
    && r.json.data.messages.length === 2 && r.json.data.messages[0].text === '测试消息')
  r = await req('/api/assistant/conversations')
  check('会话：历史列表返回标题 / 条数', r.status === 200 && r.json.data.some((x) => x.id === sid && x.title === '测试消息' && x.messageCount === 2))
  r = await req('/api/assistant/new', { method: 'POST', body: {} })
  check('会话：新建后当前指针清空', r.status === 200 && r.json.data.sessionId === null)
  r = await req(`/api/assistant/conversations/${sid}/select`, { method: 'POST', body: {} })
  check('会话：打开历史会话恢复消息', r.status === 200 && r.json.data.sessionId === sid && r.json.data.messages.length === 2)
  r = await req('/api/assistant/conversations/not-exist/select', { method: 'POST', body: {} })
  check('会话：不存在会话被拒', r.status === 400)

  // 过期视图：只读显示 expired，不为了显示而写库；写路径使用最新时间。
  {
    const expire = (kind, ref) => admin('/__expire', { kind, ref_no: ref })
    const rawStatus = async (kind, ref) => {
      const x = await snap()
      const arr = {
        transfer: x.transfer_operations, card: x.card_operations,
        subscription: x.subscription_operations, repayment: x.repayment_operations,
      }[kind]
      return arr.find((o) => o.ref_no === ref)?.status
    }

    r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 1, amount_cents: 10000, from_account_id: acct1.id } })
    const expTransfer = r.json.data.ref_no
    await expire('transfer', expTransfer)
    const rawTransfer = await rawStatus('transfer', expTransfer)
    r = await req(`/api/transfers/${expTransfer}`)
    const rawTransferAfter = await rawStatus('transfer', expTransfer)
    check('过期视图：转账 GET 返回 expired 且不写库', r.status === 200 && r.json.data.status === 'expired'
      && (rawTransfer === 'pending' || rawTransfer === 'needs_verification'), `raw=${rawTransfer}`)
    check('过期视图：转账只读查询后数据库状态未变', rawTransferAfter === rawTransfer)
    r = await req(`/api/transfers/${expTransfer}/confirm`, { method: 'POST', body: { confirm: true } })
    check('过期写路径：确认在锁内复核后返回 expired 并落库', r.status === 409
      && (await rawStatus('transfer', expTransfer)) === 'expired', JSON.stringify(r.json))

    r = await req('/api/card-operations', { method: 'POST', body: { card_id: card1.id, action: 'freeze' } })
    const expCard = r.json.data.ref_no
    await expire('card', expCard)
    const rawCard = await rawStatus('card', expCard)
    r = await req(`/api/card-operations/${expCard}`)
    check('过期视图：银行卡操作 GET 返回 expired 且不写库', r.status === 200 && r.json.data.status === 'expired'
      && (await rawStatus('card', expCard)) === rawCard, JSON.stringify(r.json))
    r = await req(`/api/card-operations/${expCard}/confirm`, { method: 'POST', body: { confirm: true } })
    check('过期写路径：银行卡确认后落库 expired', r.status === 409 && (await rawStatus('card', expCard)) === 'expired')

    const activeForExpire = (await snap()).subscriptions.find((x) => x.status === 'active')
    r = await req('/api/subscription-operations', { method: 'POST', body: { subscription_id: activeForExpire.id, action: 'pause' } })
    const expSub = r.json.data.ref_no
    await expire('subscription', expSub)
    const rawSub = await rawStatus('subscription', expSub)
    r = await req(`/api/subscription-operations/${expSub}`)
    check('过期视图：订阅操作 GET 返回 expired 且不写库', r.status === 200 && r.json.data.status === 'expired'
      && (await rawStatus('subscription', expSub)) === rawSub, JSON.stringify(r.json))
    r = await req(`/api/subscription-operations/${expSub}/confirm`, { method: 'POST', body: { confirm: true } })
    check('过期写路径：订阅确认后落库 expired', r.status === 409 && (await rawStatus('subscription', expSub)) === 'expired')

    await admin('/__clear_totp')
    await admin('/__add_debt')
    r = await req('/api/repayments', { method: 'POST', body: { scope: 'all_posted', from_account_id: acct1.id, credit_account_id: credit.id } })
    const expRepay = r.json.data.ref_no
    await expire('repayment', expRepay)
    const rawRepay = await rawStatus('repayment', expRepay)
    r = await req(`/api/repayments/${expRepay}`)
    check('过期视图：还款单 GET 返回 expired 且不写库', r.status === 200 && r.json.data.status === 'expired'
      && (await rawStatus('repayment', expRepay)) === rawRepay, JSON.stringify(r.json))
    r = await req(`/api/repayments/${expRepay}/verify`, { method: 'POST', body: { password: PASSWORD, totp: code(0) } })
    check('过期写路径：还款验证在锁内复核后返回 expired 并落库', r.status === 409
      && (await rawStatus('repayment', expRepay)) === 'expired', JSON.stringify(r.json))

    // 任务关联操作单过期：最近任务按服务端时间对账，但只读查询不写操作单。
    const task = await callRpc('rongzhi_bank_task_write_v1', 'create', { month })
    const activeSub = (await snap()).subscriptions.find((x) => x.status === 'active')
    r = await req(`/api/agent-tasks/${task.task_no}/select`, { method: 'POST', body: { subscription_id: activeSub.id } })
    const taskOpRef = r.json.data.op_ref
    await expire('subscription', taskOpRef)
    const rawTaskOp = await rawStatus('subscription', taskOpRef)
    r = await req(`/api/agent-tasks/${task.task_no}`)
    check('过期视图：最近任务对账后回到等待选择', r.status === 200 && r.json.data.status === 'waiting_selection',
      JSON.stringify(r.json && r.json.data && r.json.data.status))
    check('过期视图：任务对账不写关联操作单状态', (await rawStatus('subscription', taskOpRef)) === rawTaskOp)
  }

  // 强验证状态 / 失败锁定（最后执行）
  await admin('/__clear_totp')
  r = await req('/api/verification/status')
  check('强验证：已绑定且未锁定', r.status === 200 && r.json.data.bound === true && r.json.data.locked === false)
  r = await req('/api/transfers', { method: 'POST', body: { recipient_id: 1, amount_cents: 120000, from_account_id: acct1.id } })
  const lockRef = r.json.data.ref_no
  for (let i = 0; i < 5; i++) {
    r = await req(`/api/transfers/${lockRef}/verify`, { method: 'POST', body: { password: 'WrongPass', totp: code(0) } })
  }
  check('强验证：连续失败 5 次后锁定', r.status === 423, `status=${r.status} ${r.json && r.json.code}`)
  r = await req('/api/verification/status')
  check('强验证：状态显示锁定', r.status === 200 && r.json.data.locked === true)
  r = await req(`/api/transfers/${lockRef}/verify`, { method: 'POST', body: { password: PASSWORD, totp: code(0) } })
  check('强验证：锁定期间即使凭据正确也拒绝', r.status === 423)
} catch (e) {
  fail++
  console.error('TEST HARNESS ERROR:', e.stack || e.message)
} finally {
  if (backend) backend.proc.kill()
  stub.proc.kill()
  await sleep(300)
  console.log(`\n== CloudBase 模式本地集成测试：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
