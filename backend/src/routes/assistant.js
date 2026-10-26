// AI 助手路由：POST /api/assistant/chat、GET /api/assistant/current、POST /api/assistant/new。
// 只接受用户消息与可选会话标识；拒绝 system 消息、tool 结果、完整模型历史等字段。
// 用户身份由服务端固定演示用户提供（demoUserId），不接受客户端切换。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import { createAssistant, AssistantError, MAX_USER_MESSAGE_LEN } from '../services/assistant.js'
import { hasAiKey, isPublicDemo, getPublicDemoConfig } from '../config.js'
import { createAiGuard } from '../lib/ai-guard.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { chatCompletions } from '../lib/ai-client.js'
import { createModelBreaker, isSuspiciousError } from '../services/security-guard.js'

const ALLOWED_BODY_KEYS = ['message', 'sessionId', 'selectedCardId']

// 解析并校验请求体。返回 { error } 或 { message, sessionId, selectedCardId }。
export function parseChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' }
  }
  const keys = Object.keys(body)
  const forbidden = keys.filter((k) => !ALLOWED_BODY_KEYS.includes(k))
  if (forbidden.length) {
    return { error: `不允许提交字段：${forbidden.join('、')}（客户端只能提交 message、sessionId 与 selectedCardId）` }
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
  if (body.selectedCardId !== undefined && body.selectedCardId !== null) {
    if (typeof body.selectedCardId !== 'number' || !Number.isSafeInteger(body.selectedCardId) || body.selectedCardId <= 0) {
      return { error: 'selectedCardId 必须是正整数' }
    }
  }
  return {
    message: body.message.trim(),
    sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined,
    selectedCardId:
      typeof body.selectedCardId === 'number' && Number.isSafeInteger(body.selectedCardId) && body.selectedCardId > 0
        ? body.selectedCardId
        : null,
  }
}

export function createAssistantRouter(db, demoUserId) {
  const publicDemo = isPublicDemo()
  const publicCfg = getPublicDemoConfig()
  // 公网演示：AI 默认关闭；显式开启时所有模型调用（含工具循环）经过配额 / 并发护栏，
  // 并对 /chat 做按 IP 的请求限流。本地模式保持原行为（无限流、无配额）。
  let assistant
  let chatLimiter = null
  if (publicDemo && publicCfg.aiEnabled) {
    const guard = createAiGuard({
      chatFn: chatCompletions,
      dailyCallQuota: publicCfg.aiDailyCallQuota,
      maxConcurrency: publicCfg.aiMaxConcurrency,
    })
    assistant = createAssistant({ db, demoUserId, chatFn: guard.chatFn })
    chatLimiter = createRateLimiter({ windowMs: 60 * 1000, max: publicCfg.aiRateLimitPerMin })
  } else {
    assistant = createAssistant({ db, demoUserId })
  }
  const router = Router()

  router.post('/chat', async (req, res) => {
    const parsed = parseChatBody(req.body)
    if (parsed.error) return badRequest(res, parsed.error)

    // 公网演示默认关闭 AI；即使存在密钥也不得默认开启
    if (publicDemo && !publicCfg.aiEnabled) {
      return res.status(503).json({
        success: false,
        message: '公网演示环境未开启 AI 助手；查询与手动操作仍可使用',
      })
    }
    if (!hasAiKey()) {
      return res.status(503).json({
        success: false,
        message: 'AI 助手尚未配置模型密钥，请在 backend/.env 配置后重启后端',
      })
    }
    if (chatLimiter) {
      const lim = chatLimiter(req.ip || 'unknown')
      if (!lim.allowed) {
        res.set('Retry-After', String(Math.ceil(lim.retryAfterMs / 1000)))
        return res.status(429).json({ success: false, message: 'AI 请求过于频繁，请稍后重试' })
      }
    }

    try {
      const result = await assistant.chat({ message: parsed.message, sessionId: parsed.sessionId, selectedCardId: parsed.selectedCardId, requestId: res.locals.requestId })
      ok(res, result)
    } catch (e) {
      if (e instanceof AssistantError) {
        if (e.code === 'locked') {
          return res.status(409).json({ success: false, message: e.message })
        }
        if (e.code === 'bad_card') {
          return res.status(400).json({ success: false, message: e.message })
        }
        if (e.code === 'credential_detected') {
          // 固定安全提示，不含用户原文；不写日志、不落库。
          return res.status(400).json({ success: false, code: 'credential_detected', message: e.message })
        }
        if (e.code === 'ai_quota') {
          // 公网护栏：配额 / 并发限制；消息为固定文案，不含密钥或用户内容
          return res.status(429).json({ success: false, message: e.message })
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

  // 会话历史列表（只读）：返回当前用户全部会话（标题取首条用户消息），无需模型密钥。
  router.get('/conversations', (req, res) => {
    try {
      ok(res, assistant.listConversations())
    } catch (e) {
      console.error('[助手] 读取会话列表失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '读取会话列表失败' })
    }
  })

  // 打开历史会话：切换当前对话指针并返回该会话消息（无需模型密钥、不重发消息、不调用模型）。
  router.post('/conversations/:id/select', (req, res) => {
    try {
      const view = assistant.getConversation(req.params.id)
      if (!view) return badRequest(res, '会话不存在或已失效')
      ok(res, view)
    } catch (e) {
      console.error('[助手] 打开历史会话失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '打开历史会话失败' })
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
