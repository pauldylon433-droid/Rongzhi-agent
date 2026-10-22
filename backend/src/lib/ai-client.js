// DeepSeek Chat Completions 调用模块（可复用）。
// 供 npm run ai:check 连接测试与 AI 助手工具调用循环共用，避免重复实现请求与解析逻辑。
//
// 安全约定：
// - 官方 Chat Completions 协议，stream=false；
// - 原生 fetch 的请求 JSON 顶层设置 thinking: { type: "disabled" }（关闭思考模式）；
// - 超时覆盖请求发送与响应体读取全过程（AbortController，读取阶段中断同样抛出超时）；
// - 不自动重试；不向调用方暴露密钥或原始异常对象。
import { getDeepSeekConfig } from '../config.js'

// 模型调用错误：只携带脱敏后的状态码/错误类别，绝不携带密钥、请求体或原始响应。
export class AiError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'AiError'
    this.status = opts.status ?? null
    this.code = opts.code ?? null
    this.kind = opts.kind ?? 'error'
  }
}

const DEFAULT_TIMEOUT_MS = 30000

export function chatEndpoint(baseUrl) {
  return `${(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`
}

// 发起一次非流式对话补全，返回规范化结果。
// 返回字段：httpStatus / contentType / topLevelKeys / choicesCount / model /
//           finishReason / content / reasoningContent / toolCalls / usage
export async function chatCompletions({ messages, tools, maxTokens, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { apiKey, baseUrl, model } = getDeepSeekConfig()
  if (!apiKey) {
    throw new AiError('未配置 DEEPSEEK_API_KEY', { kind: 'no-key' })
  }

  const payload = {
    model,
    messages,
    stream: false,
    thinking: { type: 'disabled' }, // 关闭思考模式，避免思考内容占用额度、content 为空
    max_tokens: maxTokens,
    temperature: 0,
  }
  if (Array.isArray(tools) && tools.length) payload.tools = tools

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const contentType = res.headers.get('content-type') || ''
    if (!res.ok) {
      throw new AiError(`模型接口返回 HTTP ${res.status}`, { status: res.status, kind: 'http' })
    }

    const data = await res.json() // 响应体读取同样在超时窗口内
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined
    return {
      httpStatus: res.status,
      contentType,
      topLevelKeys: Object.keys(data ?? {}),
      choicesCount: Array.isArray(data?.choices) ? data.choices.length : 0,
      model: data?.model || model,
      finishReason: choice?.finish_reason ?? null,
      content: choice?.message?.content ?? '',
      reasoningContent: choice?.message?.reasoning_content ?? null,
      toolCalls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
      usage: data?.usage ?? null,
    }
  } catch (err) {
    if (err instanceof AiError) throw err
    if (err?.name === 'AbortError') {
      throw new AiError('模型请求超时', { kind: 'timeout' })
    }
    throw new AiError('模型请求网络错误', { code: err?.cause?.code || err?.code || '', kind: 'network' })
  } finally {
    clearTimeout(timer)
  }
}
