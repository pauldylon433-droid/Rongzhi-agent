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
} catch (e) {
  failures += 1
  console.error('WORKFLOW TEST ERROR:', e.stack || e.message)
} finally {
  db.close()
  console.log(`\n== DAG 计划验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
