// 验证「AI 工作区顶部任务区」当前任务推导（deriveCurrentTaskNo）与右侧业务信息栏共用同一关联。
// 纯 Node、无 Vue 依赖。用法：node scripts/verify-task-area-selection.mjs
import { deriveBusinessEvents, deriveCurrentTaskNo } from '../src/utils/businessEvents.js'

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function tool(name, data) {
  return { name, status: 'ok', data }
}
function msg(role, toolRecords) {
  return { role, text: '', toolRecords: toolRecords || [] }
}

// 旧已完成任务：start_subscription_review（爱奇艺暂停，已完成）
const oldTaskRecord = tool('start_subscription_review', { task_no: 'task-aiqiyi', status: 'completed', month: '2026-10' })
// 独立订阅恢复：prepare_subscription_operation（恢复 iCloud）
const resumeRecord = tool('prepare_subscription_operation', { ref_no: 'sub-r1', action: 'resume', merchant: 'iCloud', status: 'completed' })
// 重新创建受支持的暂停任务：新的 start_subscription_review（另一个 task_no）
const newTaskRecord = tool('start_subscription_review', { task_no: 'task-new', status: 'waiting_selection', month: '2026-10' })
const transferRecord = tool('prepare_transfer', { ref_no: 'tr-1', recipient_name: '李四', status: 'pending' })

// 场景 1：旧爱奇艺任务完成 → 独立恢复 iCloud → 顶部不冒充新任务（当前业务是订阅恢复，不是任务）
{
  const msgs = [msg('assistant', [oldTaskRecord]), msg('assistant', [resumeRecord])]
  check('1.1 旧任务完成后独立恢复 → 当前任务为 null', deriveCurrentTaskNo(msgs) === null, String(deriveCurrentTaskNo(msgs)))
  const evs = deriveBusinessEvents(msgs)
  check('1.2 最新业务事件是订阅操作（恢复）', evs[evs.length - 1].kind === 'subscription_op', evs[evs.length - 1].kind)
  check('1.3 旧任务仍在事件序列（保留为历史）', evs.some((e) => e.kind === 'task' && e.taskNo === 'task-aiqiyi'))
}

// 场景 2：主动打开旧任务所在会话（消息以旧完成任务的 start_subscription_review 结尾）
// → 当前任务识别为该旧任务 task_no（据此拉取其原始快照，卡片标注「历史任务」）
{
  const msgs = [msg('user', []), msg('assistant', [oldTaskRecord])]
  check('2.1 打开旧任务会话 → 当前任务为该旧任务', deriveCurrentTaskNo(msgs) === 'task-aiqiyi', deriveCurrentTaskNo(msgs))
}

// 场景 3：重新创建受支持的暂停任务 → 顶部显示对应新任务
{
  const msgs = [msg('assistant', [newTaskRecord])]
  check('3.1 新暂停任务 → 当前任务为新 task_no', deriveCurrentTaskNo(msgs) === 'task-new', deriveCurrentTaskNo(msgs))
}

// 场景 4：任务后接转账 → 当前业务是转账，不挂出旧任务
{
  const msgs = [msg('assistant', [oldTaskRecord]), msg('assistant', [transferRecord])]
  check('4.1 任务后接转账 → 当前任务为 null', deriveCurrentTaskNo(msgs) === null)
}

// 场景 5：仅独立恢复（无任何任务）→ null
{
  const msgs = [msg('assistant', [resumeRecord])]
  check('5.1 仅恢复操作 → null', deriveCurrentTaskNo(msgs) === null)
}

// 场景 6：空会话 → null
{
  check('6.1 空消息 → null', deriveCurrentTaskNo([]) === null)
}

// 场景 7：两个任务依次出现 → 当前为最后一个任务（顺序正确）
{
  const msgs = [msg('assistant', [oldTaskRecord]), msg('assistant', [newTaskRecord])]
  check('7.1 两个任务 → 当前为最后一个', deriveCurrentTaskNo(msgs) === 'task-new', deriveCurrentTaskNo(msgs))
}

// 场景 8：切换会话 / 刷新后重新推导（不同 messages 数组互不影响，无跨会话残留）
{
  const sessionA = [msg('assistant', [oldTaskRecord])]
  const sessionB = [msg('assistant', [resumeRecord])]
  check('8.1 会话 A（旧任务）→ 旧 task_no', deriveCurrentTaskNo(sessionA) === 'task-aiqiyi')
  check('8.2 会话 B（恢复）→ null', deriveCurrentTaskNo(sessionB) === null)
  check('8.3 重新读会话 A 仍稳定', deriveCurrentTaskNo(sessionA) === 'task-aiqiyi')
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
