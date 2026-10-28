// 「业务活动」展示辅助：把后端 /api/activity 返回的四类记录（转账 / 银行卡 / 订阅 / 跨场景任务）
// 统一映射为中文标签、摘要、金额或周期、状态文本与状态配色。仅做展示层映射，不改变后端字段语义。
import { formatCentsToYuan } from './format.js'

export const ACTIVITY_KIND_LABEL = {
  transfer: '转账',
  card_op: '银行卡',
  subscription_op: '订阅',
  repayment: '信用卡还款',
  task: '跨场景任务',
}

// 操作单状态与任务状态各自的展示文案（仅展示映射，保留原始语义，后端字段不变）
const OP_STATUS_TEXT = {
  pending: '待确认',
  needs_verification: '待强验证',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  failed: '已失效',
}
const TASK_STATUS_TEXT = {
  waiting_selection: '等待选择',
  waiting_confirmation: '待确认', // 与独立操作单 pending 统一为「待确认」（语义均为等待界面确认）
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
  manual: '手动处理',
}

export function activityStatusText(row) {
  const map = row && row.kind === 'task' ? TASK_STATUS_TEXT : OP_STATUS_TEXT
  return (row && map[row.status]) || (row && row.status) || '—'
}

// 状态配色（复用全局 .status-badge 色板）：绿=完成，红=失败，黄=待确认/待验证/等待中，灰=已取消/已过期/已暂停/手动
export function activityStatusTone(row) {
  const s = row && row.status
  if (s === 'completed') return 'is-ok'
  if (s === 'failed') return 'is-danger'
  if (s === 'pending' || s === 'needs_verification' || s === 'waiting_selection' || s === 'waiting_confirmation') return 'is-warn'
  return 'is-muted'
}

const SUB_ACTION_TEXT = { pause: '暂停', resume: '恢复', cancel: '取消', change_source: '更换扣款账户' }
const CARD_ACTION_TEXT = { freeze: '冻结', unfreeze: '解冻' }
const CYCLE_TEXT = { monthly: '按月', yearly: '按年' }

// 银行卡掩码 → 「尾号1234」
function shortCardMask(masked) {
  const m = String(masked || '').trim()
  const tail = m.match(/(\d{4})\s*$/)
  return tail ? `尾号${tail[1]}` : (m || '银行卡')
}

// 列表 / 详情共用的摘要文案（由真实字段提炼，非写死文案）
export function activitySummary(row) {
  if (!row) return '—'
  switch (row.kind) {
    case 'transfer':
      return `转账给${row.object || '—'}`
    case 'card_op':
      return `${CARD_ACTION_TEXT[row.action] || row.action || ''}${shortCardMask(row.object)}`
    case 'subscription_op':
      return `${SUB_ACTION_TEXT[row.action] || row.action || ''}${row.object || ''}`
    case 'repayment':
      return `还款${row.object ? ` ${row.object}` : ''}`
    case 'task':
      return row.object ? `订阅审查·${row.object}` : '订阅审查'
    default:
      return '—'
  }
}

// 金额或周期：银行卡操作无金额 → 短横线；订阅带金额并按月 / 按年标注周期
export function activityAmountText(row) {
  if (!row || row.kind === 'card_op') return '—'
  const c = row.amount_cents
  if (!Number.isInteger(c)) return '—'
  let text = `¥${formatCentsToYuan(c)}`
  if (row.billing_cycle) text += ` / ${CYCLE_TEXT[row.billing_cycle] || row.billing_cycle}`
  return text
}
