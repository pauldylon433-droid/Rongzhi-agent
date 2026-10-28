// 验证 deriveBusinessEvents：从结构化 toolRecords 推导「当前业务 / 历史」，不解析 AI 回复文字。
// 纯 Node、无 Vue 依赖。覆盖：事件顺序、同名状态查询覆盖、查询/错误记录不产生事件、终态判定。
import { deriveBusinessEvents, isTerminalStatus } from '../src/utils/businessEvents.js'

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function msg(toolRecords) {
  return { role: 'assistant', toolRecords }
}
function rec(name, data) {
  return { name, status: 'ok', data }
}

// 场景 1：爱奇艺任务（task）→ QQ音乐取消（subscription_op cancel）：当前业务应为订阅操作，任务转历史
{
  const messages = [
    msg([rec('start_subscription_review', { task_no: 'task-1', kind: 'subscription_review', status: 'waiting_selection', month: '2026-10' })]),
    msg([rec('prepare_subscription_operation', { ref_no: 'op-1', merchant: 'QQ音乐豪华绿钻', amount_cents: 1500, billing_cycle: 'monthly', action: 'cancel', status: 'pending' })]),
  ]
  const events = deriveBusinessEvents(messages)
  check('1.1 两个事件（任务 + 订阅操作）', events.length === 2, JSON.stringify(events.map((e) => e.kind)))
  check('1.2 当前业务为订阅操作', events[events.length - 1].kind === 'subscription_op', events[events.length - 1].kind)
  check('1.3 当前对象为 QQ音乐', events[events.length - 1].object === 'QQ音乐豪华绿钻')
  check('1.4 任务进入历史（顺序在前）', events[0].kind === 'task' && events[0].taskNo === 'task-1')
}

// 场景 2：同名后续状态查询覆盖先前 prepare 快照，且不改变位置
{
  const messages = [
    msg([rec('prepare_transfer', { ref_no: 't-1', recipient_name: '李雷', amount_cents: 1000, status: 'pending' })]),
    msg([rec('prepare_card_operation', { ref_no: 'c-1', masked_card_number: '6222 **** 1234', action: 'freeze', status: 'pending' })]),
    msg([rec('get_transfer_status', { ref_no: 't-1', status: 'completed', recipient_name: '李雷', amount_cents: 1000 })]),
  ]
  const events = deriveBusinessEvents(messages)
  check('2.1 转账状态被后续查询覆盖', events.find((e) => e.key === 't-1').status === 'completed')
  check('2.2 覆盖不改变顺序（当前仍为银行卡操作）', events[events.length - 1].kind === 'card_op')
}

// 场景 3：查询 / 错误记录不产生业务事件
{
  const messages = [
    msg([rec('get_accounts', [{ account_name: 'x' }])]),
    msg([{ name: 'prepare_transfer', status: 'error', error: 'x' }]),
    msg([rec('get_monthly_analytics', { month: '2026-10' })]),
  ]
  const events = deriveBusinessEvents(messages)
  check('3.1 查询 / 错误记录不产生业务事件', events.length === 0)
}

// 场景 4：空 / 无工具消息
check('4.1 空消息 → 空事件', deriveBusinessEvents([]).length === 0)
check('4.2 无 toolRecords 消息 → 空事件', deriveBusinessEvents([{ role: 'user', text: 'hi' }]).length === 0)

// 场景 5：终态判定
check('5.1 completed 为终态', isTerminalStatus('completed'))
check('5.2 cancelled 为终态', isTerminalStatus('cancelled'))
check('5.3 expired 为终态', isTerminalStatus('expired'))
check('5.4 failed 为终态', isTerminalStatus('failed'))
check('5.5 pending 非终态', !isTerminalStatus('pending'))
check('5.6 needs_verification 非终态', !isTerminalStatus('needs_verification'))

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
