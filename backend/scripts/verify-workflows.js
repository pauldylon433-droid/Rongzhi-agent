// 受约束 DAG 计划验证：订阅审查 / 还款审查两条链、选择、确认、核验、暂停、继续、取消、修改、重试、转人工。
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openDatabase } from '../src/db/connection.js'
import { createSchema } from '../src/db/schema.js'
import { migrate } from '../src/db/migrate.js'
import { createWorkflowService, createLocalWorkflowOps, createLocalWorkflowStore, WorkflowError } from '../src/services/workflow-plans.js'
import { confirmSubscriptionOperation } from '../src/services/subscription-operations.js'
import { verifyAndConfirmSubscriptionResume, verifyAndConfirmRepayment, bindVerification } from '../src/services/verification.js'
import { base32Decode, totpAt, totpStep } from '../src/lib/totp.js'

const DB_PATH = join(tmpdir(), 'rongzhi-workflow-test.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
const db = openDatabase(DB_PATH)
createSchema(db)
migrate(db)
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const userId = Number(db.prepare("INSERT INTO users (name) VALUES ('张三')").run().lastInsertRowid)

function addAccount(name, balance) {
  return Number(db.prepare(`INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
    VALUES (?, ?, ?, ?, 'CNY', 'deposit', 'active')`).run(userId, name, balance, balance).lastInsertRowid)
}
function addCard(accountId, masked) {
  return Number(db.prepare(`INSERT INTO cards (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on, version)
    VALUES (?, ?, ?, '借记卡', 'active', 100000, '2026-01-01', 1)`).run(userId, accountId, masked).lastInsertRowid)
}
const a1 = addAccount('日常活期', 1000000)
const a2 = addAccount('储蓄活期', 500000)
addCard(a1, '6222 **** **** 0001')
addCard(a2, '6222 **** **** 0002')
const subId = Number(db.prepare(`INSERT INTO subscriptions (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status, version)
  VALUES (?, ?, '测试会员', 1500, 'monthly', '2026-12-01', 'active', 1)`).run(userId, a1).lastInsertRowid)

// 信用账户 + 已出账账单
const creditAccount = Number(db.prepare(`INSERT INTO accounts (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
  VALUES (?, '信用卡账户', 0, 0, 'CNY', 'credit', 'active')`).run(userId).lastInsertRowid)
const caId = Number(db.prepare(`INSERT INTO credit_accounts (user_id, account_id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents)
  VALUES (?, ?, 500000, 120000, 0)`).run(userId, creditAccount).lastInsertRowid)
const statementId = Number(db.prepare(`INSERT INTO statements
  (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents, version)
  VALUES (?, ?, 2026, 10, '2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z',
          '2026-10-31T16:00:00.000Z', '2026-10-31T16:00:00.000Z', '2026-11-24T16:00:00.000Z', 120000, 0, 1)`)
  .run(userId, caId).lastInsertRowid)

const store = createLocalWorkflowStore(db, userId)
const ops = createLocalWorkflowOps(db, userId)
const service = createWorkflowService({ store, ops })

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP'
const KEY = randomBytes(32)
const PASSWORD = 'WorkflowPass123'
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET, encryptionKey: KEY, matchedStep: 0 })
const totp = (off = 0) => totpAt(base32Decode(SECRET), totpStep() + off)

try {
  // 订阅审查：创建 → 选择 → 暂停确认 → 核验
  let plan = await service.create({ flow: 'subscription_review', params: { month } })
  check('订阅计划：创建并完成只读节点', plan.status === 'waiting_selection'
    && plan.nodes.find((n) => n.key === 'analyze_month').status === 'completed'
    && plan.nodes.find((n) => n.key === 'list_subscriptions').status === 'completed', JSON.stringify(plan.nodes))
  plan = await service.select(plan.plan_no, { subscription_id: subId, action: 'pause' })
  const pauseOp = plan.op_ref
  check('订阅计划：选择后生成暂停单，等待确认', plan.status === 'waiting_confirmation' && pauseOp, JSON.stringify(plan))
  const beforePause = db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subId).status
  check('订阅计划：建单不改变订阅状态', beforePause === 'active')
  confirmSubscriptionOperation(db, userId, pauseOp)
  plan = await service.get(plan.plan_no)
  check('订阅计划：确认后核验完成', plan.status === 'completed'
    && plan.nodes.find((n) => n.key === 'summary').status === 'completed', JSON.stringify(plan))
  check('订阅计划：订阅实际暂停', db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subId).status === 'paused')

  // 换来源计划：修改未执行步骤会使原确认单失效
  db.prepare("UPDATE subscriptions SET status='active', version=version+1 WHERE id=?").run(subId)
  plan = await service.create({ flow: 'subscription_review', params: { month } })
  plan = await service.select(plan.plan_no, { subscription_id: subId, action: 'pause' })
  const oldOp = plan.op_ref
  plan = await service.modify(plan.plan_no, { action: 'change_source', to_account_id: a2 })
  const oldOpRow = db.prepare('SELECT status FROM subscription_operations WHERE ref_no=?').get(oldOp)
  check('订阅计划：修改参数取消旧操作单并回到等待选择', plan.status === 'waiting_selection'
    && oldOpRow.status === 'cancelled' && plan.op_ref === null, JSON.stringify({ status: plan.status, old: oldOpRow }))
  plan = await service.select(plan.plan_no, { subscription_id: subId, action: 'change_source', to_account_id: a2 })
  check('订阅计划：更换来源生成红色强验证单', plan.status === 'waiting_confirmation'
    && plan.op && plan.op.status === 'needs_verification', JSON.stringify(plan.op))
  const changeRes = verifyAndConfirmSubscriptionResume(db, userId, plan.op_ref, { password: PASSWORD, totp: totp(0) }, { encryptionKey: KEY })
  check('订阅计划：强验证执行更换来源', changeRes.outcome === 'completed', JSON.stringify(changeRes))
  plan = await service.get(plan.plan_no)
  check('订阅计划：换来源后核验完成', plan.status === 'completed'
    && db.prepare('SELECT account_id FROM subscriptions WHERE id=?').get(subId).account_id === a2)

  // 暂停 / 继续 / 取消 / 转人工 / 重试
  plan = await service.create({ flow: 'subscription_review', params: { month } })
  plan = await service.select(plan.plan_no, { subscription_id: subId, action: 'pause' })
  plan = await service.pause(plan.plan_no)
  check('计划：暂停后状态 paused 且取消待确认单', plan.status === 'paused'
    && db.prepare('SELECT status FROM subscription_operations WHERE ref_no=?').get(plan.op_ref || '' )?.status !== 'pending')
  plan = await service.resume(plan.plan_no)
  check('计划：继续后回到等待选择', plan.status === 'waiting_selection')
  plan = await service.cancel(plan.plan_no)
  check('计划：取消后终态 cancelled', plan.status === 'cancelled')
  plan = await service.create({ flow: 'subscription_review', params: { month } })
  plan = await service.manual(plan.plan_no)
  check('计划：转人工后 manual', plan.status === 'manual')

  // 失败重试：只重置未执行节点，不反向已完成业务
  let failedPlan = await service.create({ flow: 'subscription_review', params: { month } })
  let raw = await store.get(failedPlan.plan_no)
  raw.status = 'failed'
  raw.nodes.find((n) => n.key === 'choose_subscription').status = 'failed'
  raw.nodes.find((n) => n.key === 'choose_subscription').error = '注入失败'
  await store.save(raw)
  const retried = await service.retry(failedPlan.plan_no)
  check('计划：失败重试回到等待选择并重新执行只读节点', retried.status === 'waiting_selection'
    && retried.nodes.find((n) => n.key === 'analyze_month').status === 'completed', JSON.stringify(retried.status))

  // 还款审查：选择范围 / 付款账户 → 建单 → 强验证 → 核验
  plan = await service.create({ flow: 'repayment_review', params: {} })
  check('还款计划：只读信用账户 / 账单节点完成', plan.status === 'waiting_selection'
    && plan.nodes.find((n) => n.key === 'list_credit_accounts').status === 'completed'
    && plan.nodes.find((n) => n.key === 'list_statements').status === 'completed', JSON.stringify(plan.nodes))
  plan = await service.select(plan.plan_no, { scope: 'all_posted', from_account_id: a1, credit_account_id: caId })
  check('还款计划：生成强验证还款单', plan.status === 'waiting_verification'
    && plan.op && plan.op.status === 'needs_verification' && plan.op.amount_cents === 120000, JSON.stringify(plan.op))
  const repayRes = verifyAndConfirmRepayment(db, userId, plan.op_ref, { password: PASSWORD, totp: totp(1) }, { encryptionKey: KEY })
  check('还款计划：强验证执行还款', repayRes.outcome === 'completed', JSON.stringify(repayRes))
  plan = await service.get(plan.plan_no)
  check('还款计划：核验完成且账单结清', plan.status === 'completed'
    && db.prepare('SELECT paid_cents FROM statements WHERE id=?').get(statementId).paid_cents === 120000, JSON.stringify(plan))
  let completedModifyErr = null
  try { await service.modify(plan.plan_no, { from_account_id: a2 }) } catch (e) { completedModifyErr = e }
  check('计划：已完成计划拒绝修改（不伪装撤销已完成扣款）', completedModifyErr instanceof WorkflowError
    && completedModifyErr.code === 'bad_state', completedModifyErr?.code)
  check('计划：完成时所有必需节点均已完成（R14）',
    plan.nodes.every((n) => n.status === 'completed'), JSON.stringify(plan.nodes.map((n) => [n.key, n.status])))

  // —— P1-04：严格参数 schema，非法枚举 / 额外字段 / 非法类型直接拒绝且无副作用 ——
  {
    const before = db.prepare('SELECT count(*) n FROM subscription_operations').get().n
    let e1 = null
    try { await service.create({ flow: 'subscription_review', params: { month, bogus: 1 } }) } catch (e) { e1 = e }
    check('参数校验：create 额外字段被拒绝', e1 instanceof WorkflowError && e1.code === 'bad_params', e1?.message)
    let e2 = null
    try { await service.create({ flow: 'subscription_review', params: { month: '2026-13' } }) } catch (e) { e2 = e }
    check('参数校验：非法月份被拒绝', e2 instanceof WorkflowError && e2.code === 'bad_params', e2?.message)
    const p = await service.create({ flow: 'subscription_review', params: { month } })
    let e3 = null
    try { await service.select(p.plan_no, { subscription_id: subId, action: 'DELETE_EVERYTHING' }) } catch (e) { e3 = e }
    check('参数校验：非法 action 被拒绝，不静默改为暂停（R13）', e3 instanceof WorkflowError && e3.code === 'bad_params', e3?.message)
    let e4 = null
    try { await service.select(p.plan_no, { subscription_id: String(subId), action: 'pause' }) } catch (e) { e4 = e }
    check('参数校验：字符串账户 id 被拒绝', e4 instanceof WorkflowError && e4.code === 'bad_params', e4?.message)
    let e5 = null
    try { await service.select(p.plan_no, { subscription_id: subId, action: 'pause', extra: true }) } catch (e) { e5 = e }
    check('参数校验：select 额外字段被拒绝', e5 instanceof WorkflowError && e5.code === 'bad_params', e5?.message)
    let e6 = null
    try { await service.select(p.plan_no, { subscription_id: -1, action: 'pause' }) } catch (e) { e6 = e }
    check('参数校验：非正整数账户被拒绝', e6 instanceof WorkflowError && e6.code === 'bad_params', e6?.message)
    check('参数校验：非法输入未产生操作单副作用',
      db.prepare('SELECT count(*) n FROM subscription_operations').get().n === before)
    let e7 = null
    try { await service.modify(p.plan_no, { evil: 'x' }) } catch (e) { e7 = e }
    check('参数校验：modify 复用同一 schema', e7 instanceof WorkflowError && e7.code === 'bad_params', e7?.message)
    let e8 = null
    try { await service.select(p.plan_no, { scope: 'all_posted', from_account_id: a1, credit_account_id: caId }) } catch (e) { e8 = e }
    check('参数校验：订阅流程不接受还款参数', e8 instanceof WorkflowError && e8.code === 'bad_params', e8?.message)
  }

  // —— P1-03：依赖不能删除 / 反向 / 重复 / 额外，只读失败不得继续 ——
  {
    let d1 = null
    try {
      await service.create({ flow: 'subscription_review', params: { month }, steps: [
        { key: 'analyze_month', depends_on: [] }, { key: 'list_subscriptions', depends_on: [] },
        { key: 'choose_subscription', depends_on: [] },
        { key: 'prepare_subscription', depends_on: ['choose_subscription'] },
        { key: 'await_confirmation', depends_on: ['prepare_subscription'] },
        { key: 'verify_result', depends_on: ['await_confirmation'] },
        { key: 'summary', depends_on: ['verify_result'] },
      ] })
    } catch (e) { d1 = e }
    check('DAG：删除必需依赖被拒绝（R4）', d1 instanceof WorkflowError && d1.code === 'bad_plan', d1?.message)
    let d2 = null
    try {
      await service.create({ flow: 'subscription_review', params: { month }, steps: [
        { key: 'analyze_month', depends_on: ['summary'] }, { key: 'list_subscriptions', depends_on: [] },
        { key: 'choose_subscription', depends_on: ['analyze_month', 'list_subscriptions'] },
        { key: 'prepare_subscription', depends_on: ['choose_subscription'] },
        { key: 'await_confirmation', depends_on: ['prepare_subscription'] },
        { key: 'verify_result', depends_on: ['await_confirmation'] },
        { key: 'summary', depends_on: ['verify_result'] },
      ] })
    } catch (e) { d2 = e }
    check('DAG：反向依赖被拒绝', d2 instanceof WorkflowError && d2.code === 'bad_plan', d2?.message)
    let d3 = null
    try {
      await service.create({ flow: 'subscription_review', params: { month }, steps: [
        { key: 'analyze_month', depends_on: [] }, { key: 'list_subscriptions', depends_on: [] },
        { key: 'choose_subscription', depends_on: ['analyze_month', 'list_subscriptions', 'analyze_month'] },
        { key: 'prepare_subscription', depends_on: ['choose_subscription'] },
        { key: 'await_confirmation', depends_on: ['prepare_subscription'] },
        { key: 'verify_result', depends_on: ['await_confirmation'] },
        { key: 'summary', depends_on: ['verify_result'] },
      ] })
    } catch (e) { d3 = e }
    check('DAG：重复依赖被拒绝', d3 instanceof WorkflowError && d3.code === 'bad_plan', d3?.message)
    let d4 = null
    try {
      await service.create({ flow: 'subscription_review', params: { month }, steps: [
        { key: 'analyze_month', depends_on: [], label: 'x' }, { key: 'list_subscriptions', depends_on: [] },
        { key: 'choose_subscription', depends_on: ['analyze_month', 'list_subscriptions'] },
        { key: 'prepare_subscription', depends_on: ['choose_subscription'] },
        { key: 'await_confirmation', depends_on: ['prepare_subscription'] },
        { key: 'verify_result', depends_on: ['await_confirmation'] },
        { key: 'summary', depends_on: ['verify_result'] },
      ] })
    } catch (e) { d4 = e }
    check('DAG：节点额外字段被拒绝', d4 instanceof WorkflowError && d4.code === 'bad_plan', d4?.message)

    // 只读失败：分析抛错 → 节点 failed，选择入口拒绝且不建单
    const failingOps = {
      ...ops,
      async analytics() { throw new Error('injected_analytics_failure') },
      async subscriptions() { throw new Error('injected_subscriptions_failure') },
    }
    const failingService = createWorkflowService({ store, ops: failingOps })
    const beforeOps = db.prepare('SELECT count(*) n FROM subscription_operations').get().n
    const failed = await failingService.create({ flow: 'subscription_review', params: { month } })
    const analyzeNode = failed.nodes.find((n) => n.key === 'analyze_month')
    check('DAG：只读节点失败标记 failed 且不冒充空列表',
      analyzeNode.status === 'failed' && /injected_analytics_failure/.test(analyzeNode.error), JSON.stringify(analyzeNode))
    let d5 = null
    try { await failingService.select(failed.plan_no, { subscription_id: subId, action: 'pause' }) } catch (e) { d5 = e }
    check('DAG：前置只读失败时禁止选择 / 建单', d5 instanceof WorkflowError && d5.code === 'bad_state'
      && db.prepare('SELECT count(*) n FROM subscription_operations').get().n === beforeOps, d5?.message)
    const viewFailed = await failingService.get(failed.plan_no)
    check('DAG：查询失败在视图中显式返回（不静默吞错）', viewFailed.errors && viewFailed.errors.subscriptions,
      JSON.stringify(viewFailed.errors))
  }

  // —— P1-02：并发选择最多一个可确认关联单；审计失败不留孤单 ——
  {
    const cp = await service.create({ flow: 'subscription_review', params: { month } })
    const beforeOps = db.prepare("SELECT count(*) n FROM subscription_operations WHERE ref_no LIKE ?").get(`wf-${cp.plan_no}-%`).n
    const results = await Promise.allSettled([
      service.select(cp.plan_no, { subscription_id: subId, action: 'pause' }),
      service.select(cp.plan_no, { subscription_id: subId, action: 'pause' }),
    ])
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const after = db.prepare("SELECT ref_no, status FROM subscription_operations WHERE ref_no LIKE ?").all(`wf-${cp.plan_no}-%`)
    const current = await service.get(cp.plan_no)
    check('并发：同一计划两次选择仅一个成功', okCount === 1 && after.length === beforeOps + 1,
      JSON.stringify({ okCount, after }))
    check('并发：计划只关联唯一操作单', current.op_ref === after[0]?.ref_no,
      JSON.stringify({ op_ref: current.op_ref, after }))

    const throwingAudit = { async record() { throw new Error('injected_audit_failure') } }
    const auditedService = createWorkflowService({ store, ops, audit: throwingAudit })
    const beforePlans = db.prepare('SELECT count(*) n FROM workflow_plans').get().n
    const ap = await auditedService.create({ flow: 'subscription_review', params: { month } }).catch((e) => e)
    const latest = db.prepare('SELECT plan_no FROM workflow_plans ORDER BY id DESC LIMIT 1').get()
    const persisted = latest ? await store.get(latest.plan_no) : null
    const linkedOps = persisted
      ? db.prepare("SELECT count(*) n FROM subscription_operations WHERE ref_no LIKE ?").get(`wf-${persisted.plan_no}-%`).n
      : 0
    check('审计失败：不静默成功、计划可核查且无孤单操作单',
      ap instanceof Error && db.prepare('SELECT count(*) n FROM workflow_plans').get().n === beforePlans + 1
      && persisted && linkedOps === 0,
      JSON.stringify({ err: ap?.message, persisted: !!persisted, linkedOps }))
  }

  // —— P1-04/P1-10：修改参数先按目标动作 / 范围归一化；旧模式字段清理，显式不兼容字段仍拒绝 ——
  {
    const currentSource = db.prepare('SELECT account_id FROM subscriptions WHERE id = ?').get(subId).account_id
    const changeTarget = [a1, a2].find((id) => id !== currentSource)
    const mp = await service.create({ flow: 'subscription_review', params: { month } })
    await service.select(mp.plan_no, { subscription_id: subId, action: 'change_source', to_account_id: changeTarget })
    let modPause = null; let modErr = null
    try { modPause = await service.modify(mp.plan_no, { action: 'pause' }) } catch (e) { modErr = e }
    check('修改：change_source → pause 允许并清理旧 to_account_id',
      !!modPause && modPause.params.action === 'pause' && modPause.params.to_account_id === undefined && !modErr,
      JSON.stringify({ err: modErr?.message, params: modPause?.params }))
    let missingTo = null
    try { await service.modify(mp.plan_no, { action: 'change_source' }) } catch (e) { missingTo = e }
    check('修改：切回 change_source 仍要求 to_account_id', missingTo?.code === 'bad_params', missingTo?.message)
    let extraField = null
    try { await service.modify(mp.plan_no, { action: 'pause', to_account_id: changeTarget }) } catch (e) { extraField = e }
    check('修改：显式提交与目标动作不兼容的字段被拒绝', extraField?.code === 'bad_params', extraField?.message)
  }
  {
    // 前面的还款用例可能已结清原账单；这里新建一张仍有剩余的已出账账单，专门验证参数归一化。
    const repaymentStatementId = Number(db.prepare(`INSERT INTO statements
      (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents, version)
      VALUES (?, ?, 2027, 1, '2026-12-31T16:00:00.000Z', '2027-01-31T16:00:00.000Z',
              '2027-01-31T16:00:00.000Z', '2027-01-31T16:00:00.000Z', '2027-02-24T16:00:00.000Z', 50000, 0, 1)`)
      .run(userId, caId).lastInsertRowid)
    const rp = await service.create({ flow: 'repayment_review', params: {} })
    await service.select(rp.plan_no, { scope: 'statement', statement_id: repaymentStatementId, from_account_id: a1 })
    let modAll = null; let modAllErr = null
    try { modAll = await service.modify(rp.plan_no, { scope: 'all_posted' }) } catch (e) { modAllErr = e }
    check('修改：statement → all_posted 允许并清理旧 statement_id',
      !!modAll && modAll.params.scope === 'all_posted' && modAll.params.statement_id === undefined && !modAllErr,
      JSON.stringify({ err: modAllErr?.message, params: modAll?.params }))
    let missingStatement = null
    try { await service.modify(rp.plan_no, { scope: 'statement' }) } catch (e) { missingStatement = e }
    check('修改：切回 statement 仍要求 statement_id', missingStatement?.code === 'bad_params', missingStatement?.message)
    let extraStatement = null
    try { await service.modify(rp.plan_no, { scope: 'all_posted', statement_id: repaymentStatementId }) } catch (e) { extraStatement = e }
    check('修改：all_posted 显式提交 statement_id 被拒绝', extraStatement?.code === 'bad_params', extraStatement?.message)
  }
} catch (e) {
  failures += 1
  console.error('WORKFLOW TEST ERROR:', e.stack || e.message)
} finally {
  db.close()
  console.log(`\n== DAG 计划验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
