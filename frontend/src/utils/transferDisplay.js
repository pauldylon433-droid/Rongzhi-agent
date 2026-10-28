// 换单展示：旧单状态与新单编号都来自 prepare_transfer 的服务端返回，不从模型文字推断。
const PREVIOUS_STATUS_TEXT = {
  cancelled: '已取消，未扣款',
  completed: '已完成，未取消',
  expired: '已过期，未取消',
  needs_verification: '需要强验证，未取消',
  failed: '已失败，未取消',
  pending: '仍待确认，未取消',
}

export function shortRef(ref) {
  const s = String(ref || '')
  return s.length > 10 ? `${s.slice(0, 8)}…` : s
}

export function previousTransferNotice(data) {
  const previous = data && data.previous
  if (!previous || !previous.ref_no || !data.ref_no) return ''
  const state = PREVIOUS_STATUS_TEXT[previous.status]
    || (previous.cancelled ? '已取消，未扣款' : '未取消')
  return `原转账单（${shortRef(previous.ref_no)}）${state}；下方为新的转账单（${shortRef(data.ref_no)}）。`
}
