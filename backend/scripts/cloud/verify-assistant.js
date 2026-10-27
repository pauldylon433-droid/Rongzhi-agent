// CloudBase 模式 AI 助手验证：mock 模型 + PGlite RPC 桩 + 真实 Express 路由。
// 不调用真实模型；不连接云端。
process.env.SKIP_ENV_FILE = '1'
process.env.PUBLIC_DEMO = '1'
process.env.DEMO_ACCESS_PASSWORD = 'test-access'
process.env.PUBLIC_AI_RATE_LIMIT_PER_MIN = '100'
process.env.PUBLIC_AI_DAILY_CALL_QUOTA = '1000'
process.env.PUBLIC_AI_MAX_CONCURRENCY = '10'
process.env.DEEPSEEK_API_KEY = 'test-model-key-not-real'

import { spawn } from 'node:child_process'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { createCloudRpcClient } = await import('../../src/cloud/rpc-client.js')
const { createCloudAssistant } = await import('../../src/cloud/assistant.js')
const { createCloudRouter } = await import('../../src/routes/cloud.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND = join(HERE, '..', '..')
const STUB = join(HERE, 'rpc-stub.js')
const USER_ID = 1

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

function appFor(router) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api', router)
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const toolCall = (name, args, id = 'tc_1') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})
const toolResp = (name, args) => ({ content: '', toolCalls: [toolCall(name, args)], usage: { total_tokens: 1 } })
const finalResp = (content) => ({ content, toolCalls: [], usage: { total_tokens: 1 } })

const stub = await startStub()
const stubBase = `http://127.0.0.1:${stub.port}`
try {
  const client = createCloudRpcClient({ base: stubBase, serviceKey: 'test-service-key' })
  let script = []
  let calls = []
  let lastTools = null
  async function mockChat({ messages, tools }) {
    calls.push(JSON.parse(JSON.stringify(messages)))
    lastTools = tools
    const next = script.shift()
    if (!next) return finalResp('（mock 无脚本）')
    return typeof next === 'function' ? await next(messages) : next
  }
  const setScript = (...items) => { script = items; calls = [] }
  const assistant = createCloudAssistant({ client, userId: USER_ID, chatFn: mockChat })
  const snapshot = () => client.snapshot(USER_ID)
  const initial = await snapshot()
  const account1 = initial.accounts.find((a) => a.account_name.includes('日常'))
  const credit = initial.credit_accounts[0]

  // —— PUBLIC_AI_ENABLED=0 必须在进入模型前阻断 ——
  process.env.PUBLIC_AI_ENABLED = '0'
  const disabled = await appFor(createCloudRouter({ client, demoUserId: USER_ID, assistant }))
  setScript(toolResp('get_accounts', {}), finalResp('不应执行'))
  let r = await fetch(`${disabled.base}/api/assistant/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '查询账户' }),
  })
  check('PUBLIC_AI_ENABLED=0：返回 503', r.status === 503, `status=${r.status}`)
  check('PUBLIC_AI_ENABLED=0：未调用模型 / 工具', calls.length === 0)
  await new Promise((res) => disabled.server.close(res))

  // —— 开启且配置齐全：进入完整工具循环 ——
  process.env.PUBLIC_AI_ENABLED = '1'
  const enabled = await appFor(createCloudRouter({ client, demoUserId: USER_ID, assistant }))
  const post = async (body) => {
    const res = await fetch(`${enabled.base}/api/assistant/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }
  const get = async (path) => {
    const res = await fetch(`${enabled.base}${path}`)
    return { status: res.status, json: await res.json() }
  }

  // 17 个工具契约
  setScript(finalResp('你好'))
  r = await post({ message: '你好' })
  const expectedTools = [
    'get_accounts', 'get_monthly_analytics', 'search_transfer_recipients', 'list_transfer_recipients',
    'prepare_transfer', 'get_transfer_status', 'get_cards', 'prepare_card_operation',
    'get_card_operation_status', 'get_subscriptions', 'prepare_subscription_operation',
    'get_subscription_operation_status', 'start_subscription_review', 'get_credit_accounts',
    'get_statement', 'prepare_repayment', 'get_repayment_status',
    'analyze_transactions_sandboxed', 'plan_workflow',
  ]
  check('工具契约：恰好 19 个且名称完全一致',
    Array.isArray(lastTools) && lastTools.length === 19
    && expectedTools.every((n) => lastTools.some((t) => t.function && t.function.name === n))
    && lastTools.every((t) => expectedTools.includes(t.function.name)))

  // 查询 + 会话持久化 + 续聊
  setScript(toolResp('get_accounts', {}), finalResp('账户共 3 个'))
  r = await post({ message: '查询我的账户' })
  const querySession = r.json?.data?.sessionId
  check('开启 AI：查询工具执行并返回结果', r.status === 200
    && r.json.data.toolRecords[0].name === 'get_accounts'
    && r.json.data.toolRecords[0].status === 'ok'
    && r.json.data.toolRecords[0].data.length === 3, JSON.stringify(r.json?.data?.toolRecords))
  check('查询：回复与工具记录返回', /3 个/.test(r.json.data.reply))
  let cur = await get('/api/assistant/current')
  check('会话：当前对话已持久化', cur.status === 200 && cur.json.data.sessionId === querySession
    && cur.json.data.messages.length === 2)
  let conv = await get('/api/assistant/conversations')
  check('会话：历史列表可见', conv.status === 200 && conv.json.data.some((c) => c.id === querySession))
  setScript(finalResp('继续回答'))
  r = await post({ message: '继续', sessionId: querySession })
  const seen = JSON.stringify(calls[0] || [])
  check('续聊：模型输入包含上一轮用户与助手消息', r.status === 200
    && seen.includes('查询我的账户') && seen.includes('账户共 3 个'))

  // 模拟进程重启：新助手实例从 CloudBase 会话快照加载历史
  const assistant2 = createCloudAssistant({ client, userId: USER_ID, chatFn: mockChat })
  const reloaded = await appFor(createCloudRouter({ client, demoUserId: USER_ID, assistant: assistant2 }))
  setScript(finalResp('重载后回答'))
  r = await fetch(`${reloaded.base}/api/assistant/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '重载后续聊', sessionId: querySession }),
  }).then(async (res) => ({ status: res.status, json: await res.json() }))
  const reloadedSeen = JSON.stringify(calls[0] || [])
  check('续聊：新助手实例从数据库恢复历史', r.status === 200
    && reloadedSeen.includes('查询我的账户') && reloadedSeen.includes('账户共 3 个'))
  await new Promise((res) => reloaded.server.close(res))

  // 多轮补充信息后建单 + 歧义追问
  setScript(finalResp('请选择付款账户：1 日常活期，2 储蓄活期'))
  r = await post({ message: '给李雷转 100 元' })
  const createSession = r.json?.data?.sessionId
  check('歧义：多付款账户时先追问，不建单', r.status === 200
    && r.json.data.toolRecords.length === 0 && /付款账户/.test(r.json.data.reply))
  const beforeTransfer = (await snapshot()).accounts.find((a) => Number(a.id) === Number(account1.id)).balance_cents
  setScript(
    toolResp('prepare_transfer', { recipient_id: 1, amount_yuan: '100.00', account_id: account1.id }),
    finalResp('已生成待确认转账单'),
  )
  r = await post({ message: '用账户 1', sessionId: createSession })
  const transferRef = r.json?.data?.toolRecords?.[0]?.data?.ref_no
  const afterCreate = await snapshot()
  check('多轮补充：模型输入包含上一轮追问', r.status === 200
    && JSON.stringify(calls[0] || []).includes('请选择付款账户'))
  check('多轮补充：生成待确认转账单', r.status === 200 && transferRef
    && r.json.data.toolRecords[0].data.status === 'pending'
    && afterCreate.accounts.find((a) => Number(a.id) === Number(account1.id)).balance_cents === beforeTransfer)
  check('建单：会话待确认引用已持久化',
    afterCreate.chat_sessions.find((s) => s.id === createSession)?.pending_transfer_ref === transferRef)

  // 状态交错：模型生成期间外部确认，回复与持久化消息改为权威状态
  setScript(async () => {
    await client.write('transfer', 'confirm', { ref_no: transferRef }, USER_ID)
    return finalResp('截至查询时点该转账仍为待确认')
  })
  r = await post({ message: '这笔转账完成了吗？', sessionId: createSession })
  check('状态交错：服务端状态变化后替换模型草稿', r.status === 200
    && /已完成/.test(r.json.data.reply) && !/待确认/.test(r.json.data.reply), r.json?.data?.reply)
  const afterInterleave = await snapshot()
  check('状态交错：数据库中该转账已完成', afterInterleave.transfer_operations.find((o) => o.ref_no === transferRef)?.status === 'completed')
  const persisted = afterInterleave.chat_messages.filter((m) => m.session_id === createSession && m.role === 'assistant').at(-1)
  check('状态交错：持久化助手消息与返回内容一致', persisted && persisted.text === r.json.data.reply,
    `persisted=${persisted?.text} reply=${r.json?.data?.reply}`)
  check('状态交错：已完成单的会话待确认引用被清理',
    !afterInterleave.chat_sessions.find((s) => s.id === createSession)?.pending_transfer_ref)

  // 最新权威状态回读
  setScript(toolResp('get_transfer_status', { ref_no: transferRef }), finalResp('该笔转账已完成'))
  r = await post({ message: '再查一下这笔转账', sessionId: createSession })
  check('权威状态回读：get_transfer_status 返回 completed', r.status === 200
    && r.json.data.toolRecords[0].data.status === 'completed')

  // 银行卡 / 订阅 / 还款操作单准备（不执行）
  const debitCard = (await snapshot()).cards.find((c) => c.account_type === undefined || c.card_type === '借记卡') || (await snapshot()).cards[0]
  setScript(
    toolResp('prepare_card_operation', { card_id: debitCard.id, action: 'freeze' }),
    finalResp('已生成冻结操作单'),
  )
  r = await post({ message: '冻结我的借记卡' })
  const cardOpData = r.json?.data?.toolRecords?.[0]?.data
  const cardStateAfter = (await snapshot()).cards.find((c) => Number(c.id) === Number(debitCard.id))
  check('操作单准备：银行卡冻结单 pending 且卡片状态未变',
    r.status === 200 && cardOpData && cardOpData.status === 'pending'
    && cardStateAfter.status === 'active', JSON.stringify(cardOpData))

  const activeSub = (await snapshot()).subscriptions.find((s) => s.status === 'active')
  setScript(
    toolResp('prepare_subscription_operation', { subscription_id: activeSub.id, action: 'pause' }),
    finalResp('已生成暂停订阅操作单'),
  )
  r = await post({ message: '暂停云音乐会员' })
  const subOpData = r.json?.data?.toolRecords?.[0]?.data
  const subStateAfter = (await snapshot()).subscriptions.find((s) => Number(s.id) === Number(activeSub.id))
  check('操作单准备：订阅暂停单 pending 且订阅状态未变',
    r.status === 200 && subOpData && subOpData.status === 'pending'
    && subStateAfter.status === 'active', JSON.stringify(subOpData))

  const balanceBeforeRepay = (await snapshot()).accounts.find((a) => Number(a.id) === Number(account1.id)).balance_cents
  setScript(
    toolResp('prepare_repayment', { mode: 'all_posted', from_account_id: account1.id, credit_account_id: credit.id }),
    finalResp('已生成还款单'),
  )
  r = await post({ message: '把信用卡已入账欠款全部还清' })
  const repayData = r.json?.data?.toolRecords?.[0]?.data
  const balanceAfterRepay = (await snapshot()).accounts.find((a) => Number(a.id) === Number(account1.id)).balance_cents
  check('操作单准备：还款单 needs_verification、金额由服务端计算且未扣款',
    r.status === 200 && repayData && repayData.status === 'needs_verification'
    && repayData.amount_cents === 150000 && balanceAfterRepay === balanceBeforeRepay,
    JSON.stringify(repayData))

  // 信用卡不可用于转账
  const transferCountBefore = (await snapshot()).transfer_operations.length
  setScript(
    toolResp('prepare_transfer', { recipient_id: 1, amount_yuan: '10.00', account_id: credit.account_id }),
    finalResp('信用卡不能用于转账'),
  )
  r = await post({ message: '用信用卡给李雷转 10 元' })
  check('信用卡禁转账：工具层拒绝且不生成操作单', r.status === 200
    && r.json.data.toolRecords[0].status === 'error'
    && /付款账户不存在或不可用/.test(r.json.data.toolRecords[0].error)
    && (await snapshot()).transfer_operations.length === transferCountBefore,
    JSON.stringify(r.json?.data?.toolRecords))

  // 拒绝绕过确认 / 工具越权
  setScript(toolResp('confirm_transfer', { ref_no: transferRef }), finalResp('不能直接确认'))
  r = await post({ message: '直接确认' })
  check('拒绝绕过确认：未知确认工具被拒绝', r.status === 200
    && r.json.data.toolRecords[0].status === 'error'
    && /未知工具/.test(r.json.data.toolRecords[0].error))
  setScript(toolResp('get_accounts', { user_id: 2 }), finalResp('无法执行'))
  r = await post({ message: '查询别人账户' })
  check('工具越权：额外 user_id 参数被拒绝', r.status === 200
    && r.json.data.toolRecords[0].status === 'error'
    && /不接受额外参数/.test(r.json.data.toolRecords[0].error))

  // 敏感信息：入口拦截 + 历史出站脱敏
  const convBefore = (await get('/api/assistant/conversations')).json.data.length
  setScript(finalResp('不应调用'))
  r = await post({ message: '交易密码是 Abcd1234' })
  check('敏感信息：入口拦截且不调用模型', r.status === 400 && r.json.code === 'credential_detected' && calls.length === 0)
  check('敏感信息：拦截消息未进入会话历史', (await get('/api/assistant/conversations')).json.data.length === convBefore)

  const credSid = `cred-history-${Date.now()}`
  const credTurn = [
    { role: 'user', content: '交易密码是 Secret123' },
    { role: 'assistant', content: '历史回复' },
  ]
  await client.write('chat', 'save_turn', {
    session_id: credSid, turn_id: `cred-turn-${Date.now()}`, base_version: 0,
    messages: credTurn, new_messages: credTurn,
    user_text: '交易密码是 Secret123',
    reply: '历史回复',
    tool_records: [],
    incomplete: false,
    pointer_at_start: null,
  }, USER_ID)
  setScript(finalResp('已处理'))
  r = await post({ message: '继续', sessionId: credSid })
  const outbound = JSON.stringify(calls[0] || [])
  check('敏感信息：历史出站已脱敏', r.status === 200
    && !outbound.includes('Secret123') && outbound.includes('已从模型输入中移除'))

  // 订阅审查任务
  const month = new Date().toISOString().slice(0, 7)
  setScript(toolResp('start_subscription_review', { month }), finalResp('任务已启动'))
  r = await post({ message: `审查 ${month} 的订阅` })
  const taskNo = r.json?.data?.toolRecords?.[0]?.data?.task_no
  const taskSnap = await snapshot()
  check('订阅审查：启动任务并返回真实任务编号', r.status === 200 && taskNo
    && taskSnap.agent_tasks.some((t) => t.task_no === taskNo && t.session_id === r.json.data.sessionId))

  // 信用卡查询
  setScript(toolResp('get_credit_accounts', {}), finalResp('信用卡可用额度'))
  r = await post({ message: '我的信用卡额度' })
  check('信用卡查询：返回真实额度 / 账单', r.status === 200
    && r.json.data.toolRecords[0].data[0].credit_limit_cents === 500000
    && Array.isArray(r.json.data.toolRecords[0].data[0].statements))

  // 沙箱工具：正常执行 + 宿主访问阻断
  const sandboxCode = 'function analyze(rows){ let total=0; for(const r of rows){ if(r.status==="posted" && r.direction==="expense") total+=r.amount_cents; } return {total_cents:total}; }'
  setScript(toolResp('analyze_transactions_sandboxed', { month, code: sandboxCode }), finalResp('沙箱分析完成'))
  r = await post({ message: '用沙箱分析本月支出' })
  check('沙箱工具：正常执行且标记非权威', r.status === 200
    && r.json.data.toolRecords[0].status === 'ok'
    && r.json.data.toolRecords[0].data.execution.sandbox === 'quickjs-wasm'
    && r.json.data.toolRecords[0].data.authoritative === false, JSON.stringify(r.json?.data?.toolRecords?.[0]))
  setScript(toolResp('analyze_transactions_sandboxed', { month, code: "function analyze(){ return require('fs').readFileSync('C:/Windows/win.ini'); }" }), finalResp('无法访问宿主'))
  r = await post({ message: '尝试读取宿主文件' })
  check('沙箱工具：宿主访问被阻断', r.status === 200
    && r.json.data.toolRecords[0].status === 'error' && /沙箱分析失败/.test(r.json.data.toolRecords[0].error), JSON.stringify(r.json?.data?.toolRecords?.[0]))

  // 受约束 DAG 工具 + 云端计划持久化
  setScript(toolResp('plan_workflow', { flow: 'subscription_review', params: { month } }), finalResp('计划已创建'))
  r = await post({ message: '创建订阅审查计划' })
  const planNo = r.json?.data?.toolRecords?.[0]?.data?.plan_no
  check('DAG 工具：创建云端订阅审查计划', r.status === 200 && planNo
    && r.json.data.toolRecords[0].data.status === 'waiting_selection', JSON.stringify(r.json?.data?.toolRecords?.[0]))
  r = await get(`/api/workflows/${planNo}`)
  check('DAG 计划：云端 GET 可恢复计划', r.status === 200 && r.json.data.plan_no === planNo
    && r.json.data.nodes.some((n) => n.key === 'analyze_month' && n.status === 'completed'))

  // DAG 云端完整订阅链：选择 → 暂停确认 → 核验
  {
    const pv = r.json.data
    const sub = (pv.selectable_subscriptions || [])[0]
    let wx = await fetch(`${enabled.base}/api/workflows/${planNo}/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription_id: sub.id, action: 'pause' }),
    })
    let wj = await wx.json()
    check('DAG 计划：云端选择订阅生成暂停单', wx.status === 200 && wj.data.status === 'waiting_confirmation' && wj.data.op_ref,
      JSON.stringify(wj.data?.status))
    const opRef = wj.data.op_ref
    wx = await fetch(`${enabled.base}/api/subscription-operations/${opRef}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    })
    check('DAG 计划：云端确认暂停单', wx.status === 200)
    wx = await fetch(`${enabled.base}/api/workflows/${planNo}`)
    wj = await wx.json()
    check('DAG 计划：云端核验完成', wx.status === 200 && wj.data.status === 'completed',
      JSON.stringify(wj.data?.status))
    const planAudit = await client.queryAudit({ plan_id: planNo }, 1)
    check('云审计：计划事件带 request_id，可串起创建 / 选择 / 完成（R11）',
      planAudit.rows.length >= 3 && planAudit.rows.every((e) => e.request_id)
      && planAudit.rows.some((e) => e.action === 'create') && planAudit.rows.some((e) => e.action === 'select'),
      JSON.stringify(planAudit.rows.map((e) => [e.action, e.request_id, e.operation_ref])))
  }

  // DAG 云端还款链：选择范围 / 付款账户 → 建单 → 取消（强验证另由本地链验证）
  {
    let wx = await fetch(`${enabled.base}/api/workflows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: 'repayment_review', params: {} }),
    })
    let wj = await wx.json()
    const rpNo = wj.data?.plan_no
    const dep = (wj.data?.selectable_deposit_accounts || [])[0]
    const ca = (wj.data?.selectable_credit_accounts || [])[0]
    check('DAG 还款计划：云端创建并完成只读节点', wx.status === 200 && rpNo
      && wj.data.nodes.some((n) => n.key === 'list_statements' && n.status === 'completed'))
    wx = await fetch(`${enabled.base}/api/workflows/${rpNo}/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all_posted', from_account_id: dep.id, credit_account_id: ca.id }),
    })
    wj = await wx.json()
    check('DAG 还款计划：云端生成强验证还款单', wx.status === 200 && wj.data.status === 'waiting_verification'
      && wj.data.op && wj.data.op.status === 'needs_verification', JSON.stringify(wj.data?.status))
    wx = await fetch(`${enabled.base}/api/workflows/${rpNo}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    wj = await wx.json()
    check('DAG 还款计划：云端取消未执行还款单', wx.status === 200 && wj.data.status === 'cancelled')
  }

  // 云卡片 / 订阅权威回执：模型生成期间外部确认
  {
    const card = (await snapshot()).cards.find((c) => c.card_type === '借记卡')
    let cx = await fetch(`${enabled.base}/api/card-operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: card.id, action: 'freeze' }),
    })
    let cj = await cx.json()
    const cardOp = cj.data.ref_no
    await client.write('chat', 'save_turn', {
      session_id: 'cloud-card-receipt', turn_id: 'cloud-card-1', base_version: 0,
      messages: [], new_messages: [], pending_card_op_ref: cardOp,
      user_text: '', reply: '', tool_records: [], incomplete: false, pointer_at_start: null,
    }, USER_ID)
    setScript(async () => {
      await client.write('card', 'confirm', { ref_no: cardOp }, USER_ID)
      return finalResp('该卡仍待确认')
    })
    r = await post({ message: '这张卡冻结了吗', sessionId: 'cloud-card-receipt' })
    check('云回执：卡操作草稿被服务端完成状态替换', r.status === 200
      && /冻结操作已完成/.test(r.json.data.reply) && !/待确认/.test(r.json.data.reply), JSON.stringify({status:r.status, body:r.json}))

    const sub = (await snapshot()).subscriptions.find((x) => x.status === 'active')
    let sx = await fetch(`${enabled.base}/api/subscription-operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription_id: sub.id, action: 'pause' }),
    })
    let sj = await sx.json()
    const subOp = sj.data.ref_no
    await client.write('chat', 'save_turn', {
      session_id: 'cloud-sub-receipt', turn_id: 'cloud-sub-1', base_version: 0,
      messages: [], new_messages: [], pending_subscription_op_ref: subOp,
      user_text: '', reply: '', tool_records: [], incomplete: false, pointer_at_start: null,
    }, USER_ID)
    setScript(async () => {
      await client.write('subscription', 'confirm', { ref_no: subOp }, USER_ID)
      return finalResp('该订阅仍待确认')
    })
    r = await post({ message: '订阅暂停了吗', sessionId: 'cloud-sub-receipt' })
    check('云回执：订阅草稿被服务端完成状态替换', r.status === 200
      && /订阅暂停操作已完成/.test(r.json.data.reply) && !/待确认/.test(r.json.data.reply), JSON.stringify({status:r.status, body:r.json}))
  }

  // 云端可疑行为范围锁定
  {
    process.env.SECURITY_ANOMALY_ENABLED = '1'
    process.env.SECURITY_ANOMALY_THRESHOLD = '3'
    process.env.SECURITY_ANOMALY_WINDOW_SECONDS = '60'
    process.env.SECURITY_ANOMALY_LOCK_SECONDS = '60'
    const badBody = { recipient_id: 1, amount_cents: 10000, from_account_id: 1, extra: true }
    let last
    for (let i = 0; i < 3; i++) {
      last = await fetch(`${enabled.base}/api/transfers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' },
        body: JSON.stringify(badBody),
      })
    }
    check('云安全：前 3 次同 IP 非法请求返回 400', last.status === 400)
    await new Promise((r) => setTimeout(r, 250))
    const blocked = await fetch(`${enabled.base}/api/transfers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' },
      body: JSON.stringify(badBody),
    })
    const bj = await blocked.json()
    check('云安全：第 4 次同 IP 请求返回 423', blocked.status === 423 && bj.code === 'suspicious_locked', `status=${blocked.status}`)
    const other = await fetch(`${enabled.base}/api/transfers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.10' },
      body: JSON.stringify(badBody),
    })
    check('云安全：其他 IP 不受影响', other.status === 400)

    // P1-06：/workflows 与其它敏感写入口挂载在同一审计 / 锁定中间件之后
    const wfLocked = await fetch(`${enabled.base}/api/workflows/wf-nonexistent/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' },
      body: JSON.stringify({}),
    })
    check('云安全：锁定的 IP 访问 /workflows 同样返回 423 且带请求号（R9/R10）',
      wfLocked.status === 423 && Boolean(wfLocked.headers.get('x-request-id')),
      JSON.stringify({ status: wfLocked.status, requestId: wfLocked.headers.get('x-request-id') }))
    const wfOther = await fetch(`${enabled.base}/api/workflows/wf-nonexistent/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.10' },
      body: JSON.stringify({}),
    })
    check('云安全：未锁定 IP 的 /workflows 进入业务路由（404 而非绕过中间件）',
      wfOther.status === 404 && Boolean(wfOther.headers.get('x-request-id')), `status=${wfOther.status}`)
  }

  // 审计时间线：受保护查询 + 关联编号
  process.env.AUDIT_ACCESS_TOKEN = 'cloud-audit-token'
  let ax = await fetch(`${enabled.base}/api/audit/timeline`)
  check('云审计：未带令牌返回 401', ax.status === 401)
  ax = await fetch(`${enabled.base}/api/audit/timeline`, { headers: { Authorization: 'Bearer cloud-audit-token' } })
  let aj = await ax.json()
  check('云审计：令牌正确可查询且含助手 / 工具事件', ax.status === 200
    && aj.data.some((e) => e.category === 'assistant' && e.action === 'request')
    && aj.data.some((e) => e.category === 'tool'), JSON.stringify(aj.data?.slice(0, 2)))
  ax = await fetch(`${enabled.base}/api/audit/export`, { headers: { 'X-Audit-Token': 'cloud-audit-token' } })
  check('云审计：可导出 JSON', ax.status === 200 && /attachment/.test(ax.headers.get('content-disposition') || ''))
  delete process.env.AUDIT_ACCESS_TOKEN
  ax = await fetch(`${enabled.base}/api/audit/timeline`)
  check('云审计：未配置令牌时不暴露（404）', ax.status === 404)

  // 事实块：云端助手同样不能用模型草稿展示未核验业务事实。
  setScript(toolResp('get_accounts', {}), finalResp('您的账户余额为987654.32元。'))
  const cf1 = await assistant.chat({ message: '查余额' })
  check('云端事实块：错误余额被服务端账户块替换',
    cf1.reply.includes('账户信息（服务端核验）') && !cf1.reply.includes('987654.32')
      && (cf1.reply_blocks || []).some((b) => b.kind === 'accounts' && b.source?.call_id), cf1.reply)
  setScript(finalResp('汇款已经办妥，600元资金已经到账。'))
  const cf2 = await assistant.chat({ message: '给李雷转600元' })
  check('云端事实块：无依据成功声明被拒绝原样展示',
    /无法依据当前服务端数据确认/.test(cf2.reply) && !cf2.reply.includes('已经到账'), cf2.reply)
  setScript(
    toolResp('prepare_transfer', { recipient_id: 1, amount_yuan: '1', account_id: account1.id }),
    finalResp('| 项目 | 内容 |\n|---|---|\n| 金额 | 888.00 元 |\n| 状态 | 待确认 |'),
  )
  const cf3 = await assistant.chat({ message: '给李雷转1元' })
  check('云端事实块：错误表格金额被服务端操作单块替换',
    cf3.reply.includes('转账操作单（服务端核验）') && cf3.reply.includes('1.00 元') && !cf3.reply.includes('888.00'), cf3.reply)

  await new Promise((res) => enabled.server.close(res))
} catch (e) {
  fail++
  console.error('ASSISTANT HARNESS ERROR:', e.stack || e.message)
} finally {
  stub.proc.kill()
  await sleep(300)
  console.log(`\n== CloudBase AI 助手本地验证（mock 模型）：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
