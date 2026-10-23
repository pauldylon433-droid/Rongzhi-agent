// 从当前会话消息的结构化工具记录推导「业务事件」列表（不解析 AI 回复文字）。
// 仅依据 toolRecords 中 status === 'ok' 的结构化 data（操作编号 ref_no / 任务编号 task_no），
// 与「真实会话 + 结构化结果 + 任务 ID + 操作引用」对齐；同名后续状态查询覆盖先前 prepare 快照。
//
// 事件类型：
//  - transfer          转账单（prepare_transfer / get_transfer_status）
//  - card_op           银行卡操作单（prepare_card_operation / get_card_operation_status）
//  - subscription_op   订阅操作单（prepare_subscription_operation / get_subscription_operation_status）
//  - repayment         信用卡还款单（prepare_repayment / get_repayment_status）
//  - task              跨场景任务（start_subscription_review，key = task_no）
//
// 纯函数、无 Vue 依赖，便于独立验证（node scripts/verify-business-events.mjs）。

const OP_DEFS = {
  prepare_transfer: { kind: 'transfer', key: (d) => d && d.ref_no },
  get_transfer_status: { kind: 'transfer', key: (d) => d && d.ref_no },
  prepare_card_operation: { kind: 'card_op', key: (d) => d && d.ref_no },
  get_card_operation_status: { kind: 'card_op', key: (d) => d && d.ref_no },
  prepare_subscription_operation: { kind: 'subscription_op', key: (d) => d && d.ref_no },
  get_subscription_operation_status: { kind: 'subscription_op', key: (d) => d && d.ref_no },
  prepare_repayment: { kind: 'repayment', key: (d) => d && d.ref_no },
  get_repayment_status: { kind: 'repayment', key: (d) => d && d.ref_no },
  start_subscription_review: { kind: 'task', key: (d) => d && d.task_no },
}

function displayFields(kind, d) {
  const base = {
    status: d && d.status ? d.status : '',
    action: d && d.action ? d.action : null,
    amountCents: Number.isInteger(d && d.amount_cents) ? d.amount_cents : null,
    billingCycle: d && d.billing_cycle ? d.billing_cycle : null,
    month: d && d.month ? d.month : null,
    object: null,
    objectSub: null,
  }
  if (kind === 'transfer') {
    base.object = d && d.recipient_name ? d.recipient_name : (d && d.recipient_masked_account ? d.recipient_masked_account : null)
    base.objectSub = d && d.recipient_masked_account ? d.recipient_masked_account : null
  } else if (kind === 'card_op') {
    base.object = d && d.masked_card_number ? d.masked_card_number : null
    base.objectSub = d && d.card_type ? d.card_type : null
  } else if (kind === 'subscription_op') {
    base.object = d && d.merchant ? d.merchant : null
  } else if (kind === 'repayment') {
    base.object = d && d.credit_account_name ? d.credit_account_name : null
    base.objectSub = d && d.statement_month ? d.statement_month : null
  } else if (kind === 'task') {
    base.object = '订阅审查'
  }
  return base
}

export function deriveBusinessEvents(messages) {
  const events = []
  const byKey = new Map()
  for (const m of messages || []) {
    const records = (m && m.toolRecords) || []
    for (const rec of records) {
      if (!rec || rec.status !== 'ok' || rec.data == null) continue
      const def = OP_DEFS[rec.name]
      if (!def) continue
      const key = def.key(rec.data)
      if (!key) continue
      const fields = displayFields(def.kind, rec.data)
      const event = {
        kind: def.kind,
        key,
        refNo: def.kind === 'task' ? null : key,
        taskNo: def.kind === 'task' ? key : null,
        ...fields,
      }
      const idx = byKey.get(key)
      if (idx === undefined) {
        byKey.set(key, events.length)
        events.push(event)
      } else {
        // 后续状态查询覆盖先前快照（仅覆盖非空展示字段），保持事件首次出现的位置（即最新「业务」顺序）。
        const prev = events[idx]
        const merged = { ...prev }
        for (const [k, v] of Object.entries(event)) {
          if (v != null && v !== '') merged[k] = v
        }
        events[idx] = merged
      }
    }
  }
  return events
}

// 操作单 / 任务的「终态」：完成后展示回执，不再显示「待确认」黄色提示。
export const TERMINAL_STATUSES = ['completed', 'cancelled', 'expired', 'failed']
export function isTerminalStatus(s) {
  return !!s && TERMINAL_STATUSES.includes(s)
}

// 当前会话「当前业务」若为跨场景任务，返回其 task_no，否则 null。
// 顶部紧凑任务区与右侧业务信息栏共用同一推导：仅当最新业务事件是任务时才把它当作「当前任务」，
// 独立订阅恢复 / 转账 / 银行卡操作等不挂出旧任务（不冒充新任务、不为恢复模板生成假任务）。
export function deriveCurrentTaskNo(messages) {
  const evs = deriveBusinessEvents(messages)
  const last = evs[evs.length - 1]
  return last && last.kind === 'task' ? last.taskNo : null
}
