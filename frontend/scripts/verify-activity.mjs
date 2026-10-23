// 「业务活动」前端展示辅助验证：摘要 / 金额周期 / 状态文案与配色映射。纯函数，不依赖后端与浏览器。
// 用法：node scripts/verify-activity.mjs
import {
  ACTIVITY_KIND_LABEL,
  activityStatusText,
  activityStatusTone,
  activitySummary,
  activityAmountText,
} from '../src/utils/activity.js'

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const transfer = { kind: 'transfer', object: '李雷', amount_cents: 1000, status: 'completed' }
const card = { kind: 'card_op', action: 'freeze', object: '6222 **** **** 1234', status: 'pending' }
const sub = { kind: 'subscription_op', action: 'pause', object: 'Adobe 摄影计划', amount_cents: 8800, billing_cycle: 'yearly', status: 'needs_verification' }
const task = { kind: 'task', object: '爱奇艺会员', amount_cents: 2500, billing_cycle: 'monthly', status: 'waiting_confirmation' }

check('A.1 转账摘要', activitySummary(transfer) === '转账给李雷', activitySummary(transfer))
check('A.2 银行卡摘要取尾号', activitySummary(card) === '冻结尾号1234', activitySummary(card))
check('A.3 订阅摘要（暂停）', activitySummary(sub) === '暂停Adobe 摄影计划', activitySummary(sub))
check('A.4 任务摘要（订阅审查）', activitySummary(task) === '订阅审查·爱奇艺会员', activitySummary(task))

check('B.1 转账金额', activityAmountText(transfer) === '¥10.00', activityAmountText(transfer))
check('B.2 订阅金额带按年周期', activityAmountText(sub) === '¥88.00 / 按年', activityAmountText(sub))
check('B.3 银行卡无金额为短横线', activityAmountText(card) === '—', activityAmountText(card))

check('C.1 任务等待确认统一为「待确认」', activityStatusText(task) === '待确认', activityStatusText(task))
check('C.6 独立操作单待确认同样为「待确认」', activityStatusText({ kind: 'transfer', status: 'pending' }) === '待确认')
check('C.7 两类待确认展示一致', activityStatusText(task) === activityStatusText({ kind: 'transfer', status: 'pending' }))
check('C.8 两类待确认配色一致（is-warn）', activityStatusTone(task) === 'is-warn' && activityStatusTone({ kind: 'transfer', status: 'pending' }) === 'is-warn')
check('C.2 订阅状态文案', activityStatusText(sub) === '待强验证', activityStatusText(sub))
check('C.3 完成态配色', activityStatusTone(transfer) === 'is-ok', activityStatusTone(transfer))
check('C.4 待处理配色', activityStatusTone(card) === 'is-warn', activityStatusTone(card))
check('C.5 取消态配色', activityStatusTone({ kind: 'transfer', status: 'cancelled' }) === 'is-muted')

check('D.1 类型标签', ACTIVITY_KIND_LABEL.transfer === '转账' && ACTIVITY_KIND_LABEL.task === '跨场景任务')

console.log('\n共 ' + checks + ' 项检查，' + (failures === 0 ? '全部通过 ✅' : '失败 ' + failures + ' 项 ❌'))
process.exit(failures === 0 ? 0 : 1)
