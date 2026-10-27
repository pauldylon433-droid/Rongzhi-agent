// B：CloudBase 计划 select 前置节点检查（服务层 + 本机 PGlite RPC 桩）。
// 仅使用本机桩与内存数据库，不连接真实 CloudBase、不执行云端 SQL、不调用真实模型。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCloudRpcClient } from '../../src/cloud/rpc-client.js'
import {
  createWorkflowService, createCloudWorkflowOps, createCloudWorkflowStore,
} from '../../src/services/workflow-plans.js'

let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const stubPath = fileURLToPath(new URL('./rpc-stub.js', import.meta.url))
const child = spawn(process.execPath, [stubPath], { env: { ...process.env, STUB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
let err = ''
child.stderr.on('data', (d) => { err += d })
let serverPort = null
try {
  serverPort = await new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const first = buf.split(/\r?\n/)[0]
      if (/^\d+$/.test(first.trim())) resolve(Number(first))
    })
    child.on('exit', () => reject(new Error(err || 'rpc stub exited')))
    setTimeout(() => reject(new Error('rpc stub timeout')), 15000).unref()
  })
  const client = createCloudRpcClient({ base: `http://127.0.0.1:${serverPort}`, serviceKey: 'test' })
  const snap0 = await client.snapshot(1)
  const sub = (snap0.subscriptions || []).find((s) => s.status === 'active')
  const fromAccount = (snap0.accounts || []).find((a) => a.account_type === 'deposit' && a.status === 'active')

  // 订阅链：只读分析失败 → 计划需等待选择但前置 failed → select 必须拒绝且不建单。
  {
    const ops = createCloudWorkflowOps({ client, userId: 1 })
    ops.analytics = async () => { throw new Error('injected_analytics_unavailable') }
    const service = createWorkflowService({ store: createCloudWorkflowStore({ client, userId: 1 }), ops })
    const plan = await service.create({ flow: 'subscription_review', params: { month: '2026-10' } })
    check('B：订阅计划前置分析失败标记 failed', plan.nodes.find((n) => n.key === 'analyze_month')?.status === 'failed',
      JSON.stringify(plan.nodes.find((n) => n.key === 'analyze_month')))
    let e = null
    try { await service.select(plan.plan_no, { subscription_id: Number(sub.id), action: 'pause' }) } catch (x) { e = x }
    const snap1 = await client.snapshot(1)
    check('B：订阅链前置失败时 select 返回 bad_state 且不建单',
      e?.code === 'bad_state' && (snap1.subscription_operations || []).length === (snap0.subscription_operations || []).length,
      JSON.stringify({ code: e?.code, before: (snap0.subscription_operations || []).length, after: (snap1.subscription_operations || []).length }))
  }

  // 还款链：只读账户查询失败 → choose_repayment 前置失败 → select 必须拒绝且不建单。
  {
    const ops = createCloudWorkflowOps({ client, userId: 1 })
    ops.creditAccounts = async () => { throw new Error('injected_credit_unavailable') }
    const service = createWorkflowService({ store: createCloudWorkflowStore({ client, userId: 1 }), ops })
    const plan = await service.create({ flow: 'repayment_review', params: {} })
    check('B：还款计划前置只读失败标记 failed',
      plan.nodes.find((n) => n.key === 'list_credit_accounts')?.status === 'failed',
      JSON.stringify(plan.nodes.find((n) => n.key === 'list_credit_accounts')))
    let e = null
    try {
      await service.select(plan.plan_no, {
        scope: 'statement', statement_id: 1, from_account_id: Number(fromAccount.id),
      })
    } catch (x) { e = x }
    const snap1 = await client.snapshot(1)
    check('B：还款链前置失败时 select 返回 bad_state 且不建单',
      e?.code === 'bad_state' && (snap1.repayment_operations || []).length === (snap0.repayment_operations || []).length,
      JSON.stringify({ code: e?.code, before: (snap0.repayment_operations || []).length, after: (snap1.repayment_operations || []).length }))
  }

  // 成功路径仍可建单（不因新增前置检查误伤）。
  {
    const service = createWorkflowService({ store: createCloudWorkflowStore({ client, userId: 1 }), ops: createCloudWorkflowOps({ client, userId: 1 }) })
    const plan = await service.create({ flow: 'subscription_review', params: { month: '2026-10' } })
    const selected = await service.select(plan.plan_no, { subscription_id: Number(sub.id), action: 'pause' })
    check('B：前置完成时成功路径仍可建单', selected.status === 'waiting_confirmation' && !!selected.op_ref,
      JSON.stringify({ status: selected.status, op_ref: selected.op_ref }))
  }
} catch (e) {
  failures += 1
  console.error('PLAN DEPS TEST ERROR:', e.stack || e.message)
} finally {
  child.kill()
  console.log(`\n== 云端计划前置节点验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
