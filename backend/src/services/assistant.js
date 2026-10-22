// AI 助手服务：自然语言 → 模型工具调用 → 实际数据库查询 / 生成待确认转账单 → 最终回答。
//
// 工具白名单：只读工具（get_accounts、get_monthly_analytics、search_transfer_recipients、
// get_transfer_status）+ 生成待确认转账单（prepare_transfer）。不开放任何扣款 / 确认执行工具。
// 用户身份由服务端固定演示用户提供；禁止模型传 user_id、SQL、文件路径或 URL。
// 采用官方 Chat Completions 工具调用协议，正确处理一轮多个 tool_calls。
//
// 会话由服务端生成并保存，带过期时间与历史长度上限；同一会话同时只处理一个请求。
// 历史裁剪按「轮」进行。会话维护「当前待确认转账单」引用，用于用户修改请求时取消旧单。
import { randomUUID } from 'node:crypto'
import { chatCompletions, AiError } from '../lib/ai-client.js'
import { listAccounts } from './accounts.js'
import { listCards } from './cards.js'
import { listSubscriptions } from './subscriptions.js'
import { monthlyAnalytics } from './analytics.js'
import { createTransfer, cancelTransfer, getTransfer, TransferError } from './transfers.js'
import {
  createCardOperation, cancelCardOperation, getCardOperation, CardOpError,
} from './card-operations.js'
import {
  createSubscriptionOperation, cancelSubscriptionOperation, getSubscriptionOperation, SubscriptionOpError,
} from './subscription-operations.js'
import { yuanToCents } from '../lib/money.js'
import { parseMonth } from '../routes/helpers.js'
import { SHANGHAI_OFFSET_MS } from '../lib/shanghai.js'

export const MAX_MODEL_CALLS = 4 // 每条用户消息最多 4 轮模型请求
export const MAX_TOOL_CALLS = 6 // 每条用户消息最多 6 次工具执行
export const MAX_TURNS = 8 // 会话保留最近 8 轮对话
export const MAX_USER_MESSAGE_LEN = 2000 // 消息长度上限（字符）
const SESSION_TTL_MS = 30 * 60 * 1000 // 会话过期时间：30 分钟
const REPLY_MAX_TOKENS = 1024 // 助手回复额度
const CHAT_MAX_MESSAGES_PER_SESSION = 200 // 单会话可见消息上限（约 100 轮，防无限增长）
const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 会话保留期：7 天（懒清理，过期即删）

// 工具白名单（模型可见的 function schema）
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_accounts',
      description: '查询当前用户的银行账户列表，返回账户名、当前余额（分）、币种、状态、开户日期等。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_monthly_analytics',
      description:
        '查询指定月份（YYYY-MM）的账单统计：已入账收入、支出、净收支、已入账笔数、待入账笔数与金额、支出分类（金额倒序）。月份按 Asia/Shanghai 自然月。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '月份，格式 YYYY-MM，例如 2026-10' },
        },
        required: ['month'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_transfer_recipients',
      description:
        '按姓名（或虚构联系方式）搜索收款人，返回匹配的收款人列表（仅 id、姓名、掩码账户）。搜索无结果时返回空数组；多个匹配时不要自行挑选，应列给用户选择。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '收款人姓名（或部分姓名 / 虚构联系方式）' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_transfer',
      description:
        '在收款人明确、金额与备注等信息齐全后，创建一张「待确认转账单」（不扣款）。返回操作编号、状态、风险等级、有效期与转账详情。扣款必须由用户在界面点击确认完成，本工具不执行扣款。单条用户消息最多调用一次。',
      parameters: {
        type: 'object',
        properties: {
          recipient_id: { type: 'integer', description: '收款人 id（来自 search_transfer_recipients 返回的 id）' },
          amount_yuan: { type: 'string', description: '金额（元）字符串，例如 "100.00"，最多两位小数' },
          remark: { type: 'string', description: '备注，可选' },
          account_id: { type: 'integer', description: '付款账户 id，可选；存在多个付款账户且用户未指定时需先澄清' },
        },
        required: ['recipient_id', 'amount_yuan'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transfer_status',
      description: '按操作编号查询某张转账单的当前状态（以数据库为准，不沿用创建时的旧状态）。',
      parameters: {
        type: 'object',
        properties: {
          ref_no: { type: 'string', description: '转账单操作编号' },
        },
        required: ['ref_no'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cards',
      description:
        '查询当前用户的银行卡列表，返回卡 id、掩码卡号、卡类型、状态（active 正常 / frozen 冻结 / cancelled 已注销）、单日限额等。多个匹配时不要自行挑选，应列给用户选择。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_card_operation',
      description:
        '在卡片明确后，为某张卡创建「银行卡操作单」（冻结 freeze 或解冻 unfreeze），不立即改变卡片状态。返回操作编号、状态、风险等级与卡片信息。冻结需用户点击确认；解冻需交易密码 + 动态验证码强验证。单条用户消息最多调用一次。',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'integer', description: '银行卡 id（来自 get_cards 返回的 id）' },
          action: { type: 'string', description: '操作类型：freeze（冻结）或 unfreeze（解冻）' },
        },
        required: ['card_id', 'action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_card_operation_status',
      description: '按操作编号查询某张银行卡操作单的当前状态（以数据库为准，不沿用创建时的旧状态）。',
      parameters: {
        type: 'object',
        properties: {
          ref_no: { type: 'string', description: '银行卡操作单操作编号' },
        },
        required: ['ref_no'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_subscriptions',
      description:
        '查询当前用户的订阅与代扣列表，返回订阅 id、商户、每期金额（分）、扣费周期、下次扣费日期、状态（active 生效 / paused 暂停 / cancelled 已取消）等。多个匹配时不要自行挑选，应列给用户选择。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_subscription_operation',
      description:
        '在订阅明确后，为某项订阅创建「订阅操作单」（暂停 pause / 恢复 resume / 取消 cancel），不立即改变订阅状态。返回操作编号、状态、风险等级与订阅信息。暂停 / 取消需用户点击确认；恢复需交易密码 + 动态验证码强验证。已取消（cancelled）的订阅不可再操作。单条用户消息最多调用一次。',
      parameters: {
        type: 'object',
        properties: {
          subscription_id: { type: 'integer', description: '订阅 id（来自 get_subscriptions 返回的 id）' },
          action: { type: 'string', description: '操作类型：pause（暂停）/ resume（恢复）/ cancel（取消）' },
        },
        required: ['subscription_id', 'action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_subscription_operation_status',
      description: '按操作编号查询某张订阅操作单的当前状态（以数据库为准，不沿用创建时的旧状态）。',
      parameters: {
        type: 'object',
        properties: {
          ref_no: { type: 'string', description: '订阅操作单操作编号' },
        },
        required: ['ref_no'],
        additionalProperties: false,
      },
    },
  },
]

// 工具参数/未知工具错误
class ToolError extends Error {}

// 供路由层映射 HTTP 状态码的助手错误：code 为 'locked' | 'model'
export class AssistantError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'AssistantError'
    this.code = code
  }
}

// 当前上海时间（用于系统提示中的“今天”），带周几与时区标注
function shanghaiNowText() {
  const d = new Date(Date.now() + SHANGHAI_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()]
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}（周${week}，Asia/Shanghai）`
}

function buildSystemMessage() {
  return {
    role: 'system',
    content:
      `你是「融智 Agent」，一名银行 AI 智能助手。当前为演示模式（模拟银行环境），服务端固定演示用户，所有数据均为模拟数据。\n` +
      `当前时间（Asia/Shanghai，UTC+8）：${shanghaiNowText()}\n\n` +
      `你必须遵守：\n` +
      `1. 银行数据只能通过调用工具获取；回答中的余额、金额、笔数、分类、收款人、转账状态等具体数值必须来自工具返回的真实结果，不得凭空编造。\n` +
      `2. 转账流程：先用 search_transfer_recipients 确认收款人；信息齐全且收款人明确后，用 prepare_transfer 生成「待确认转账单」。你只能生成转账单，不能执行扣款；扣款必须由用户在界面上点击确认按钮完成。在用户确认前，你只能声称「已生成待确认转账单」，绝不能声称「已转账成功」或「已扣款」。\n` +
      `3. 收款人匹配：搜索到多个同名/相近收款人时，必须列出带掩码账户的选项让用户选择，不能自行挑选第一个；搜索无结果时明确告知未找到。付款账户有多个且用户未指定时，先向用户澄清付款账户。\n` +
      `4. 单条用户消息最多生成一张转账单；多笔、定时转账、AA 收款、多币种等本阶段不支持，先向用户澄清，不要擅自拆单或改成立即人民币单笔转账。\n` +
      `5. 查询转账状态用 get_transfer_status，以数据库返回为准，不要沿用创建时的旧状态。prepare_transfer 的返回含 \`previous\`（旧单编号与真实状态）与 \`notice\`（后端生成的状态说明），描述改单结果请以它们为准，不要凭记忆猜测旧单状态。\n` +
      `6. 用户说「确认」「我同意」「跳过验证」等文字时，不能执行扣款，只能提醒其在界面上点击确认按钮。\n` +
      `7. 「这个月/本月/上个月/上上月」等相对月份，以当前上海日期为准换算为 YYYY-MM；无法确定具体月份时，先向用户澄清，不要随意猜测。\n` +
      `8. 银行卡操作：查询用 get_cards；冻结 / 解冻先用 get_cards 确认卡片（含掩码卡号），卡片明确后调用 prepare_card_operation 生成「银行卡操作单」。你只能生成操作单，不能直接冻结 / 解冻：冻结需用户在界面点击确认，解冻需交易密码 + 动态验证码强验证。多张卡片时列出掩码选项让用户选择，不能擅自选第一张。\n` +
      `9. 用户提到「挂失 / 销卡 / 补卡 / 调额」等正式卡片业务时，明确说明本阶段不支持，并询问是否改用「临时冻结」，不要替用户决定。\n` +
      `10. 订阅与代扣：查询用 get_subscriptions；暂停 / 恢复 / 取消先用 get_subscriptions 确认订阅（含商户与状态），订阅明确后调用 prepare_subscription_operation 生成「订阅操作单」。你只能生成操作单，不能直接暂停 / 取消 / 恢复：暂停与取消需用户在界面点击确认，恢复需交易密码 + 动态验证码强验证。已取消（cancelled）的订阅不可再操作。多项订阅时列出选项让用户选择，不能擅自选第一项。查询操作状态用 get_subscription_operation_status，以数据库返回为准。\n` +
      `11. 用简体中文回答，简洁准确；金额请标注单位（元）。`,
  }
}

// 解析工具参数 JSON 字符串；无效 JSON 或非对象抛 ToolError
function parseToolArgs(raw) {
  if (raw == null || raw === '') return {}
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new ToolError('工具参数不是有效 JSON')
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ToolError('工具参数必须是 JSON 对象')
  }
  return obj
}

// 操作编号尾号（用于确定性文案，避免在说明里暴露完整 UUID）
function refTail(refNo) {
  return typeof refNo === 'string' && refNo.length >= 8 ? `${refNo.slice(0, 8)}…` : refNo || ''
}

// 根据旧单取消的真实结果与新旧编号，生成确定性状态说明（状态由服务端读取，不由模型推断）。
function buildTransferNotice(previous, newRefNo) {
  const newT = refTail(newRefNo)
  if (!previous) return `已生成待确认转账单（${newT}）。`
  const old = refTail(previous.ref_no)
  switch (previous.status) {
    case 'cancelled':
      return `已取消原待确认转账单（${old}），并生成新的待确认转账单（${newT}）。`
    case 'completed':
      return `原转账单（${old}）已完成，未取消；已生成新的待确认转账单（${newT}）。`
    case 'expired':
      return `原转账单（${old}）已过期，未取消；已生成新的待确认转账单（${newT}）。`
    case 'needs_verification':
      return `原转账单（${old}）需要强验证，未取消；已生成新的待确认转账单（${newT}）。`
    case 'failed':
      return `原转账单（${old}）已失败，未取消；已生成新的待确认转账单（${newT}）。`
    default:
      return `已生成新的待确认转账单（${newT}）。`
  }
}

// 根据旧银行卡操作单取消的真实结果与新旧编号，生成确定性状态说明（状态由服务端读取，不由模型推断）。
function buildCardOpNotice(previous, newRefNo, action) {
  const newT = refTail(newRefNo)
  const actText = action === 'freeze' ? '冻结' : '解冻'
  if (!previous) return `已生成${actText}操作单（${newT}），请在界面确认。`
  const old = refTail(previous.ref_no)
  switch (previous.status) {
    case 'cancelled':
      return `已取消原待确认操作单（${old}），并生成新的${actText}操作单（${newT}）。`
    case 'completed':
      return `原操作单（${old}）已完成，未取消；已生成新的${actText}操作单（${newT}）。`
    case 'expired':
      return `原操作单（${old}）已过期，未取消；已生成新的${actText}操作单（${newT}）。`
    case 'needs_verification':
      return `原操作单（${old}）需要强验证，未取消；已生成新的${actText}操作单（${newT}）。`
    case 'failed':
      return `原操作单（${old}）已失效，未取消；已生成新的${actText}操作单（${newT}）。`
    default:
      return `已生成新的${actText}操作单（${newT}）。`
  }
}

// 根据旧订阅操作单取消的真实结果与新旧编号，生成确定性状态说明（状态由服务端读取，不由模型推断）。
function buildSubscriptionOpNotice(previous, newRefNo, action) {
  const newT = refTail(newRefNo)
  const actText = { pause: '暂停', resume: '恢复', cancel: '取消' }[action] || action
  if (!previous) return `已生成${actText}订阅操作单（${newT}），请在界面确认。`
  const old = refTail(previous.ref_no)
  switch (previous.status) {
    case 'cancelled':
      return `已取消原待确认操作单（${old}），并生成新的${actText}订阅操作单（${newT}）。`
    case 'completed':
      return `原操作单（${old}）已完成，未取消；已生成新的${actText}订阅操作单（${newT}）。`
    case 'expired':
      return `原操作单（${old}）已过期，未取消；已生成新的${actText}订阅操作单（${newT}）。`
    case 'needs_verification':
      return `原操作单（${old}）需要强验证，未取消；已生成新的${actText}订阅操作单（${newT}）。`
    case 'failed':
      return `原操作单（${old}）已失效，未取消；已生成新的${actText}订阅操作单（${newT}）。`
    default:
      return `已生成新的${actText}订阅操作单（${newT}）。`
  }
}

// 校验并执行白名单工具，返回业务数据；未知工具/额外参数/非法参数抛 ToolError。
// ctx = { session, messageState }，prepare_transfer 会写入会话待确认单引用与单消息去重标记。
function executeTool(db, demoUserId, name, args, ctx) {
  if (name === 'get_accounts') {
    if (Object.keys(args).length > 0) {
      throw new ToolError('get_accounts 不接受额外参数')
    }
    return listAccounts(db, demoUserId)
  }
  if (name === 'get_monthly_analytics') {
    const extra = Object.keys(args).filter((k) => k !== 'month')
    if (extra.length) {
      throw new ToolError(`get_monthly_analytics 不接受额外参数：${extra.join('、')}`)
    }
    const parsed = parseMonth(args.month)
    if (!parsed) {
      throw new ToolError('month 参数格式应为 YYYY-MM（月份 01-12）')
    }
    return monthlyAnalytics(db, demoUserId, { ...parsed, asOf: new Date().toISOString() })
  }
  if (name === 'search_transfer_recipients') {
    const extra = Object.keys(args).filter((k) => k !== 'name')
    if (extra.length) {
      throw new ToolError(`search_transfer_recipients 不接受额外参数：${extra.join('、')}`)
    }
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) throw new ToolError('name 参数不能为空')
    const like = `%${name}%`
    return db
      .prepare(
        'SELECT id, name, masked_account FROM transfer_recipients WHERE name LIKE ? OR masked_account LIKE ? ORDER BY id',
      )
      .all(like, like)
  }
  if (name === 'get_transfer_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_transfer_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = getTransfer(db, demoUserId, refNo)
    if (!op) throw new ToolError('未找到该转账单')
    return op
  }
  if (name === 'prepare_transfer') {
    if (ctx.messageState.prepareTransferDone) {
      throw new ToolError('本条消息已生成转账单，请先确认或取消后再发起新转账')
    }
    const extra = Object.keys(args).filter(
      (k) => !['recipient_id', 'amount_yuan', 'remark', 'account_id'].includes(k),
    )
    if (extra.length) {
      throw new ToolError(`prepare_transfer 不接受额外参数：${extra.join('、')}`)
    }

    // 收款人：由服务端校验存在性
    const recipientId = args.recipient_id
    if (typeof recipientId !== 'number' || !Number.isSafeInteger(recipientId) || recipientId <= 0) {
      throw new ToolError('recipient_id 必须为正整数')
    }
    const recipient = db.prepare('SELECT id, name, masked_account FROM transfer_recipients WHERE id = ?').get(recipientId)
    if (!recipient) {
      throw new ToolError('收款人不存在，请先用 search_transfer_recipients 确认收款人')
    }

    // 金额：元字符串 → 整数分（不接受浮点乘 100）
    const cents = yuanToCents(args.amount_yuan)
    if (cents === null) {
      throw new ToolError('amount_yuan 格式不正确（须为非负数字字符串，最多两位小数，不能为负/零/科学计数法）')
    }
    if (cents <= 0) throw new ToolError('金额必须大于 0')

    // 备注
    const remark = typeof args.remark === 'string' ? args.remark.trim() : ''

    // 付款账户：明确指定，或唯一时自动选用，多个时澄清
    const accts = db
      .prepare("SELECT id, account_name FROM accounts WHERE user_id = ? AND status = 'active' ORDER BY id")
      .all(demoUserId)
    let fromAccountId
    if (args.account_id !== undefined) {
      if (typeof args.account_id !== 'number' || !Number.isSafeInteger(args.account_id) || args.account_id <= 0) {
        throw new ToolError('account_id 必须为正整数')
      }
      if (!accts.some((a) => a.id === args.account_id)) {
        throw new ToolError('付款账户不存在或不可用')
      }
      fromAccountId = args.account_id
    } else if (accts.length === 1) {
      fromAccountId = accts[0].id
    } else if (accts.length > 1) {
      throw new ToolError('存在多个付款账户，请先让用户选择付款账户')
    } else {
      throw new ToolError('没有可用的付款账户')
    }

    let op
    try {
      op = createTransfer(db, demoUserId, { recipientId, amountCents: cents, remark, fromAccountId })
    } catch (e) {
      if (e instanceof TransferError) {
        // 创建失败：旧待确认单未被取消，如实说明两件事（创建失败 + 原单未变更），不声称已生成新单
        const prevRef = ctx.session.pendingTransferRef
        const prevNote = prevRef ? `；原待确认转账单（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`转账单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }

    // 修改请求：取消本会话旧的待确认单（幂等；已完成/已取消的单不受影响），
    // 并基于实际结果返回旧单编号与真实状态、新单编号与真实状态（服务端读取，非模型推断）。
    const prevRef = ctx.session.pendingTransferRef
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = cancelTransfer(db, demoUserId, prevRef)
      const prevStatus = cr.op ? cr.op.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingTransferRef = op.ref_no
    ctx.messageState.prepareTransferDone = true
    return { ...op, previous, notice: buildTransferNotice(previous, op.ref_no) }
  }
  if (name === 'get_cards') {
    if (Object.keys(args).length > 0) {
      throw new ToolError('get_cards 不接受额外参数')
    }
    return listCards(db, demoUserId)
  }
  if (name === 'get_card_operation_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_card_operation_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = getCardOperation(db, demoUserId, refNo)
    if (!op) throw new ToolError('未找到该银行卡操作单')
    return op
  }
  if (name === 'prepare_card_operation') {
    if (ctx.messageState.prepareCardOpDone) {
      throw new ToolError('本条消息已生成银行卡操作单，请先确认或取消后再发起新操作')
    }
    const extra = Object.keys(args).filter((k) => !['card_id', 'action'].includes(k))
    if (extra.length) {
      throw new ToolError(`prepare_card_operation 不接受额外参数：${extra.join('、')}`)
    }

    // 卡片与动作由服务端校验；不接受模型指定风险级别 / 状态 / 用户身份
    const cardId = args.card_id
    if (typeof cardId !== 'number' || !Number.isSafeInteger(cardId) || cardId <= 0) {
      throw new ToolError('card_id 必须为正整数')
    }
    const action = args.action
    if (action !== 'freeze' && action !== 'unfreeze') {
      throw new ToolError('action 必须是 freeze 或 unfreeze')
    }
    const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(cardId, demoUserId)
    if (!card) {
      throw new ToolError('未找到该银行卡，请先用 get_cards 查询本人银行卡')
    }

    let op
    try {
      op = createCardOperation(db, demoUserId, { cardId, action })
    } catch (e) {
      if (e instanceof CardOpError) {
        // 创建失败：旧待确认操作单未被取消，如实说明两件事（创建失败 + 原操作单未变更）
        const prevRef = ctx.session.pendingCardOpRef
        const prevNote = prevRef ? `；原待确认银行卡操作（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`银行卡操作单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }

    // 修改请求：取消本会话旧的待确认操作单（幂等；已完成/已取消的单不受影响），
    // 并基于实际结果返回旧单编号与真实状态、新单编号与真实状态（服务端读取，非模型推断）。
    const prevRef = ctx.session.pendingCardOpRef
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = cancelCardOperation(db, demoUserId, prevRef)
      const prevStatus = cr.op ? cr.op.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingCardOpRef = op.ref_no
    ctx.messageState.prepareCardOpDone = true
    return { ...op, previous, notice: buildCardOpNotice(previous, op.ref_no, op.action) }
  }
  if (name === 'get_subscriptions') {
    if (Object.keys(args).length > 0) {
      throw new ToolError('get_subscriptions 不接受额外参数')
    }
    return listSubscriptions(db, demoUserId)
  }
  if (name === 'get_subscription_operation_status') {
    const extra = Object.keys(args).filter((k) => k !== 'ref_no')
    if (extra.length) throw new ToolError(`get_subscription_operation_status 不接受额外参数：${extra.join('、')}`)
    const refNo = typeof args.ref_no === 'string' ? args.ref_no.trim() : ''
    if (!refNo) throw new ToolError('ref_no 参数不能为空')
    const op = getSubscriptionOperation(db, demoUserId, refNo)
    if (!op) throw new ToolError('未找到该订阅操作单')
    return op
  }
  if (name === 'prepare_subscription_operation') {
    if (ctx.messageState.prepareSubscriptionOpDone) {
      throw new ToolError('本条消息已生成订阅操作单，请先确认或取消后再发起新操作')
    }
    const extra = Object.keys(args).filter((k) => !['subscription_id', 'action'].includes(k))
    if (extra.length) {
      throw new ToolError(`prepare_subscription_operation 不接受额外参数：${extra.join('、')}`)
    }

    // 订阅与动作由服务端校验；不接受模型指定风险级别 / 状态 / 用户身份
    const subscriptionId = args.subscription_id
    if (typeof subscriptionId !== 'number' || !Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
      throw new ToolError('subscription_id 必须为正整数')
    }
    const action = args.action
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
      throw new ToolError('action 必须是 pause、resume 或 cancel')
    }
    const sub = db.prepare('SELECT id FROM subscriptions WHERE id = ? AND user_id = ?').get(subscriptionId, demoUserId)
    if (!sub) {
      throw new ToolError('未找到该订阅，请先用 get_subscriptions 查询本人订阅')
    }

    let op
    try {
      op = createSubscriptionOperation(db, demoUserId, { subscriptionId, action })
    } catch (e) {
      if (e instanceof SubscriptionOpError) {
        // 创建失败：旧待确认操作单未被取消，如实说明两件事（创建失败 + 原操作单未变更）
        const prevRef = ctx.session.pendingSubscriptionOpRef
        const prevNote = prevRef ? `；原待确认订阅操作（${refTail(prevRef)}）未变更` : ''
        throw new ToolError(`订阅操作单创建失败：${e.message}${prevNote}`)
      }
      throw e
    }

    // 修改请求：取消本会话旧的待确认操作单（幂等；已完成/已取消的单不受影响），
    // 并基于实际结果返回旧单编号与真实状态、新单编号与真实状态（服务端读取，非模型推断）。
    const prevRef = ctx.session.pendingSubscriptionOpRef
    let previous = null
    if (prevRef && prevRef !== op.ref_no) {
      const cr = cancelSubscriptionOperation(db, demoUserId, prevRef)
      const prevStatus = cr.op ? cr.op.status : cr.outcome
      previous = { ref_no: prevRef, status: prevStatus, outcome: cr.outcome, cancelled: prevStatus === 'cancelled' }
    }
    ctx.session.pendingSubscriptionOpRef = op.ref_no
    ctx.messageState.prepareSubscriptionOpDone = true
    return { ...op, previous, notice: buildSubscriptionOpNotice(previous, op.ref_no, op.action) }
  }
  throw new ToolError(`未知工具：${name}`)
}

// 工具调用循环：把工具结果按 tool_call_id 回传，直到模型给出最终回答或达到上限。
async function runLoop(messages, db, demoUserId, chatFn, ctx) {
  const toolRecords = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  let modelCalls = 0
  let toolExecutions = 0
  let finalReply = ''
  let incomplete = false

  for (;;) {
    if (modelCalls >= MAX_MODEL_CALLS) {
      incomplete = true
      finalReply = '（已达到本轮模型调用上限，回答未完成，请稍后重试）'
      break
    }
    modelCalls += 1

    let r
    try {
      r = await chatFn({ messages, tools: TOOL_DEFS, maxTokens: REPLY_MAX_TOKENS })
    } catch (e) {
      if (e instanceof AiError) {
        throw new AssistantError(e.message, 'model')
      }
      throw e
    }

    if (r.usage) {
      usage.prompt_tokens += r.usage.prompt_tokens || 0
      usage.completion_tokens += r.usage.completion_tokens || 0
      usage.total_tokens += r.usage.total_tokens || 0
    }

    const tcs = Array.isArray(r.toolCalls) ? r.toolCalls : []
    const content = typeof r.content === 'string' ? r.content.trim() : ''

    if (tcs.length === 0) {
      finalReply = content || '（模型未返回有效回答）'
      break
    }

    // 模型请求工具：保留 assistant tool_calls 消息（content 可为 null）
    messages.push({ role: 'assistant', content: content || null, tool_calls: tcs })

    let stopped = false
    for (const call of tcs) {
      if (toolExecutions >= MAX_TOOL_CALLS) {
        incomplete = true
        finalReply = '（已达到本轮工具执行上限，回答未完成，请稍后重试）'
        stopped = true
        break
      }
      toolExecutions += 1

      const id = typeof call?.id === 'string' && call.id ? call.id : `tool_${toolExecutions}`
      const name = typeof call?.function?.name === 'string' ? call.function.name : '(未知)'

      let args
      try {
        args = parseToolArgs(call?.function?.arguments)
      } catch (e) {
        toolRecords.push({
          name,
          args: null,
          status: 'error',
          queryTime: new Date().toISOString(),
          error: e.message,
        })
        messages.push({ role: 'tool', tool_call_id: id, content: `错误：${e.message}` })
        continue
      }

      try {
        const data = executeTool(db, demoUserId, name, args, ctx)
        toolRecords.push({ name, args, status: 'ok', queryTime: new Date().toISOString(), data })
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(data) })
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : '工具执行失败'
        toolRecords.push({ name, args, status: 'error', queryTime: new Date().toISOString(), error: msg })
        messages.push({ role: 'tool', tool_call_id: id, content: `错误：${msg}` })
      }
    }
    if (stopped) break
  }

  // 无论完成或未完成，都追加最终 assistant 回复，保证会话历史结构完整
  messages.push({ role: 'assistant', content: finalReply })

  return { finalReply, toolRecords, incomplete, usage }
}

// 创建助手实例（会话持久化到 SQLite，刷新 / 后端重启可恢复当前对话）。chatFn 可注入以做单元测试（默认真实调用）。
export function createAssistant({ db, demoUserId, chatFn = chatCompletions, sessionTtlMs = SESSION_TTL_MS }) {
  // 内存缓存：保存活跃会话对象（含 locked 锁与待确认单引用），用于同进程并发控制与测试观察。
  // 持久化权威数据在 SQLite（chat_sessions / chat_messages / chat_state），重启后按需从库恢复。
  const sessions = new Map()

  function parseJson(text, fallback) {
    if (typeof text !== 'string' || text === '') return fallback
    try {
      const v = JSON.parse(text)
      return v ?? fallback
    } catch {
      return fallback
    }
  }

  // 从库读取会话（限定演示用户；不存在的会话或他用户会话返回 null，避免越权）
  function loadSessionRow(sessionId) {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, demoUserId)
    if (!row) return null
    return {
      id: row.id,
      userId: demoUserId,
      messages: parseJson(row.messages_json, []),
      locked: false,
      pendingTransferRef: row.pending_transfer_ref,
      pendingCardOpRef: row.pending_card_op_ref,
      pendingSubscriptionOpRef: row.pending_subscription_op_ref,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    }
  }

  // 从缓存或库取得会话；TTL 过期时清空模型上下文（可见历史仍保留，仅上下文重新开始，不假装记得）。
  function getSession(sessionId) {
    if (!sessionId) return null
    let s = sessions.get(sessionId)
    if (s) {
      if (Date.now() - s.lastActiveAt <= sessionTtlMs) return s
      // 已过期：清空模型上下文，保留会话标识以延续可见历史
      s.messages = []
      s.pendingTransferRef = null
      s.pendingCardOpRef = null
      s.pendingSubscriptionOpRef = null
      s.lastActiveAt = Date.now()
      return s
    }
    s = loadSessionRow(sessionId)
    if (!s) return null
    sessions.set(s.id, s)
    if (Date.now() - s.lastActiveAt <= sessionTtlMs) return s
    s.messages = []
    s.pendingTransferRef = null
    s.pendingCardOpRef = null
    s.pendingSubscriptionOpRef = null
    s.lastActiveAt = Date.now()
    return s
  }

  // 懒清理：删除超过保留期的会话与其可见消息（不影响任何业务数据；先在 getCurrent 与新建会话时触发）
  function purgeExpiredSessions() {
    const cutoff = Date.now() - CHAT_RETENTION_MS
    const ids = db.prepare('SELECT id FROM chat_sessions WHERE last_active_at < ?').all(cutoff).map((r) => r.id)
    if (ids.length === 0) return
    db.transaction(() => {
      for (const id of ids) {
        db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
      }
    })()
  }

  // 当前会话指针（单用户演示：服务端「当前对话」，刷新据此恢复）
  function setCurrentSession(sessionId) {
    db.prepare(
      `INSERT INTO chat_state (user_id, current_session_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET current_session_id = excluded.current_session_id`,
    ).run(demoUserId, sessionId)
  }
  function clearCurrentSession() {
    db.prepare('DELETE FROM chat_state WHERE user_id = ?').run(demoUserId)
  }

  // 持久化一轮对话：会话元数据 + 模型上下文（part B）+ 用户可见消息（part A），单事务保证一致。
  function persistChat(session, { userText, reply, toolRecords, incomplete }) {
    const now = session.lastActiveAt
    db.transaction(() => {
      db.prepare(
        `INSERT INTO chat_sessions
           (id, user_id, messages_json, pending_transfer_ref, pending_card_op_ref, pending_subscription_op_ref, created_at, last_active_at)
         VALUES (@id, @userId, @messagesJson, @pendingTransferRef, @pendingCardOpRef, @pendingSubscriptionOpRef, @createdAt, @lastActiveAt)
         ON CONFLICT(id) DO UPDATE SET
           messages_json = excluded.messages_json,
           pending_transfer_ref = excluded.pending_transfer_ref,
           pending_card_op_ref = excluded.pending_card_op_ref,
           pending_subscription_op_ref = excluded.pending_subscription_op_ref,
           last_active_at = excluded.last_active_at`,
      ).run({
        id: session.id,
        userId: demoUserId,
        messagesJson: JSON.stringify(session.messages),
        pendingTransferRef: session.pendingTransferRef,
        pendingCardOpRef: session.pendingCardOpRef,
        pendingSubscriptionOpRef: session.pendingSubscriptionOpRef,
        createdAt: session.createdAt,
        lastActiveAt: now,
      })

      const baseSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE session_id = ?').get(session.id).m
      const insertMsg = db.prepare(
        `INSERT INTO chat_messages (session_id, user_id, seq, role, text, tool_records_json, incomplete, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      insertMsg.run(session.id, demoUserId, baseSeq + 1, 'user', userText, null, 0, null, now)
      insertMsg.run(
        session.id, demoUserId, baseSeq + 2, 'assistant', reply,
        toolRecords && toolRecords.length ? JSON.stringify(toolRecords) : null,
        incomplete ? 1 : 0, null, now,
      )

      // 记录上限：超出时删除最旧的可见消息，保证单会话不无限增长
      const count = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(session.id).c
      const excess = count - CHAT_MAX_MESSAGES_PER_SESSION
      if (excess > 0) {
        db.prepare(
          `DELETE FROM chat_messages WHERE session_id = ? AND id IN (
             SELECT id FROM chat_messages WHERE session_id = ? ORDER BY seq ASC, id ASC LIMIT ?
           )`,
        ).run(session.id, session.id, excess)
      }

      setCurrentSession(session.id)
    })()
  }

  // 按「轮」裁剪历史：保留最近 MAX_TURNS 轮（一轮 = 一条 user 消息及其后的 assistant/tool 消息），
  // 保证工具调用与结果配对完整不被拆散。
  function trimHistory(messages) {
    const userIdx = []
    messages.forEach((m, i) => {
      if (m.role === 'user') userIdx.push(i)
    })
    if (userIdx.length <= MAX_TURNS) return messages
    return messages.slice(userIdx[userIdx.length - MAX_TURNS])
  }

  async function chat({ message, sessionId }) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new AssistantError('消息不能为空')
    }
    if (message.length > MAX_USER_MESSAGE_LEN) {
      throw new AssistantError(`消息过长（最多 ${MAX_USER_MESSAGE_LEN} 字符）`)
    }

    const trimmed = message.trim()
    let session = getSession(sessionId)
    if (!session) {
      purgeExpiredSessions() // 新建会话时顺带清理超期会话，控制保留规模
      session = {
        id: randomUUID(),
        userId: demoUserId,
        messages: [],
        locked: false,
        pendingTransferRef: null, // 本会话当前待确认转账单编号（用于修改时取消旧单）
        pendingCardOpRef: null, // 本会话当前待确认银行卡操作单编号（用于修改时取消旧单）
        pendingSubscriptionOpRef: null, // 本会话当前待确认订阅操作单编号（用于修改时取消旧单）
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      }
      sessions.set(session.id, session)
    }

    if (session.locked) {
      throw new AssistantError('该会话正在处理上一个请求，请稍候再试', 'locked')
    }
    session.locked = true
    session.lastActiveAt = Date.now()

    try {
      const history = trimHistory(session.messages)
      const messages = [buildSystemMessage(), ...history, { role: 'user', content: trimmed }]

      const messageState = { prepareTransferDone: false, prepareCardOpDone: false, prepareSubscriptionOpDone: false }
      const { finalReply, toolRecords, incomplete, usage } = await runLoop(
        messages, db, demoUserId, chatFn, { session, messageState },
      )

      // 保存本轮新增消息（去掉 system 与原有 history），再裁剪
      session.messages.push(...messages.slice(1 + history.length))
      session.messages = trimHistory(session.messages)
      session.lastActiveAt = Date.now()

      // 持久化：会话（模型上下文）+ 可见消息（user + assistant）单事务写入
      persistChat(session, { userText: trimmed, reply: finalReply, toolRecords, incomplete })

      return {
        sessionId: session.id,
        reply: finalReply,
        toolRecords,
        incomplete,
        usage,
      }
    } finally {
      session.locked = false
      session.lastActiveAt = Date.now()
    }
  }

  // 读取当前对话（只读恢复）：不调用模型、不重发消息、不修改任何数据。
  function getCurrent() {
    purgeExpiredSessions()
    const state = db.prepare('SELECT current_session_id FROM chat_state WHERE user_id = ?').get(demoUserId)
    const sessionId = state && state.current_session_id ? state.current_session_id : null
    if (!sessionId) {
      return { sessionId: null, expired: false, messages: [] }
    }
    const row = db.prepare('SELECT last_active_at FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, demoUserId)
    if (!row) {
      // 指针指向的会话已不存在（异常），返回空
      return { sessionId: null, expired: false, messages: [] }
    }
    const expired = Date.now() - row.last_active_at > sessionTtlMs
    const rows = db
      .prepare('SELECT * FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY seq ASC, id ASC')
      .all(sessionId, demoUserId)
    const messages = rows.map((r) => ({
      role: r.role,
      text: r.text,
      toolRecords: parseJson(r.tool_records_json, []),
      incomplete: !!r.incomplete,
      error: r.error || '',
    }))
    return { sessionId, expired, messages }
  }

  // 服务端切换「新建对话」：清除当前对话指针，刷新不再恢复旧对话（不删除历史、不改业务数据）。
  function newConversation() {
    clearCurrentSession()
    return { sessionId: null }
  }

  return { chat, getCurrent, newConversation, _sessions: sessions }
}
