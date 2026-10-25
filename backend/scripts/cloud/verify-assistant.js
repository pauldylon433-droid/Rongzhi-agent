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
  ]
  check('工具契约：恰好 17 个且名称完全一致',
    Array.isArray(lastTools) && lastTools.length === 17
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

  // 另一实例完成一轮后，旧实例的下一轮也必须先使用数据库里的最新上下文。
  setScript(finalResp('旧实例再续聊'))
  r = await post({ message: '回到原实例继续', sessionId: querySession })
  check('续聊：旧实例刷新其它实例已保存的新轮次', r.status === 200
    && JSON.stringify(calls[0] || []).includes('重载后回答'))

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
