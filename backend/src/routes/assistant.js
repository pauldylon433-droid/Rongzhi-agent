// AI 助手路由：POST /api/assistant/chat、GET /api/assistant/current、POST /api/assistant/new。
// 只接受用户消息与可选会话标识；拒绝 system 消息、tool 结果、完整模型历史等字段。
// 用户身份由服务端固定演示用户提供（demoUserId），不接受客户端切换。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import { createAssistant, AssistantError, MAX_USER_MESSAGE_LEN } from '../services/assistant.js'
import { hasAiKey } from '../config.js'

const ALLOWED_BODY_KEYS = ['message', 'sessionId']

// 解析并校验请求体。返回 { error } 或 { message, sessionId }。
export function parseChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' }
  }
  const keys = Object.keys(body)
  const forbidden = keys.filter((k) => !ALLOWED_BODY_KEYS.includes(k))
  if (forbidden.length) {
    return { error: `不允许提交字段：${forbidden.join('、')}（客户端只能提交 message 与 sessionId）` }
  }
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return { error: 'message 不能为空' }
  }
  if (body.message.length > MAX_USER_MESSAGE_LEN) {
    return { error: `message 过长（最多 ${MAX_USER_MESSAGE_LEN} 字符）` }
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    return { error: 'sessionId 必须是字符串' }
  }
  if (typeof body.sessionId === 'string' && body.sessionId.trim() === '') {
    return { error: 'sessionId 不能是空白字符串' }
  }
  return {
    message: body.message.trim(),
    sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined,
  }
}

export function createAssistantRouter(db, demoUserId) {
  const assistant = createAssistant({ db, demoUserId })
  const router = Router()

  router.post('/chat', async (req, res) => {
    const parsed = parseChatBody(req.body)
    if (parsed.error) return badRequest(res, parsed.error)

    if (!hasAiKey()) {
      return res.status(503).json({
        success: false,
        message: 'AI 助手尚未配置模型密钥，请在 backend/.env 配置后重启后端',
      })
    }

    try {
      const result = await assistant.chat({ message: parsed.message, sessionId: parsed.sessionId })
      ok(res, result)
    } catch (e) {
      if (e instanceof AssistantError) {
        if (e.code === 'locked') {
          return res.status(409).json({ success: false, message: e.message })
        }
        if (e.code === 'model') {
          console.error('[助手] 模型调用失败（脱敏）：', e.message)
          return res.status(502).json({ success: false, message: '模型服务暂不可用，请稍后重试' })
        }
      }
      console.error('[助手] 未预期错误：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '助手服务内部错误' })
    }
  })

  // 读取当前对话（只读恢复）：不调用模型、不重发消息、不修改数据。未配置密钥也可用（用于刷新恢复历史）。
  router.get('/current', (req, res) => {
    try {
      ok(res, assistant.getCurrent())
    } catch (e) {
      console.error('[助手] 读取当前对话失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '读取聊天记录失败' })
    }
  })

  // 服务端切换「新建对话」：清除当前对话指针，刷新不再恢复旧对话。不删除历史、不改业务数据，无需模型密钥。
  router.post('/new', (req, res) => {
    try {
      ok(res, assistant.newConversation())
    } catch (e) {
      console.error('[助手] 切换新对话失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '切换新对话失败' })
    }
  })

  return router
}
