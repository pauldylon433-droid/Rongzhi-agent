// DeepSeek API 独立连接检查脚本（复用 src/lib/ai-client.js 的调用逻辑）。
//
// 目标：用户填写密钥后，通过官方 Chat Completions 接口发起一次最小对话，
// 确认模型真正返回文本。不发送任何银行数据。
//
// 安全约定：
// - 只发送一句「请回复：连接成功」；非流式、关闭思考、限制输出长度、超时、不重试；
// - 日志不输出密钥 / Authorization / 完整请求对象 / 环境变量 / 思考内容 / 完整响应；
// - 只有得到非空最终回复才报告「连接成功」；缺少密钥时提示填写、不发请求。
//
// 用法：npm run ai:check
import { getDeepSeekConfig, hasAiKey } from '../src/config.js'
import { chatCompletions, AiError } from '../src/lib/ai-client.js'

if (!hasAiKey()) {
  console.log('未检测到 DEEPSEEK_API_KEY。')
  console.log('请先编辑 backend/.env 填入真实密钥（模板见 backend/.env.example），再运行：npm run ai:check')
  process.exit(0)
}

const { model } = getDeepSeekConfig()

function describe(v) {
  if (v == null) return 'null'
  if (typeof v === 'string') return `string(len=${v.length})`
  if (Array.isArray(v)) return `array(len=${v.length})`
  return typeof v
}

try {
  const r = await chatCompletions({
    messages: [{ role: 'user', content: '请回复：连接成功' }],
    maxTokens: 128,
    timeoutMs: 20000,
  })

  console.log('--- 脱敏诊断 ---')
  console.log(`HTTP 状态：${r.httpStatus}`)
  console.log(`Content-Type：${r.contentType}`)
  console.log(`响应顶层字段：${r.topLevelKeys.join(', ') || '(空)'}`)
  console.log(`model：${r.model}`)
  console.log(`choices 数量：${r.choicesCount}`)
  console.log(`finish_reason：${r.finishReason ?? '(无)'}`)
  console.log(`content 类型/长度：${describe(r.content)}`)
  console.log(`reasoning_content：${describe(r.reasoningContent)}`)
  console.log(`usage：${JSON.stringify(r.usage ?? {})}`)

  const finalReply = typeof r.content === 'string' ? r.content.trim() : ''
  if (finalReply) {
    console.log('连接成功 ✅')
    console.log(`模型：${r.model}`)
    console.log(`回复：${finalReply}`)
  } else {
    console.log('连接失败：未得到非空最终回复。')
    process.exit(1)
  }
} catch (err) {
  if (err instanceof AiError) {
    console.log(`连接失败：${err.message}`)
  } else {
    console.log('连接失败：未知错误')
  }
  process.exit(1)
}
