// 聊天入口凭据保护：识别「明确标注 + 明确取值」的凭据消息，阻止其进入模型与持久化。
//
// 设计边界（务必如实对外说明）：
// - 只识别**显式标注**的凭据，例如「交易密码是 xxx」「验证码：123456」「DEEPSEEK_API_KEY=...」
//   「TOTP 密钥：...」「主密钥：...」；
// - 不识别未标注的任意密码 / 验证码（例如单独一句「123456」或「abc123」），也不把所有 6 位数字当验证码；
// - 命中后只返回原因类型，不保留命中值；调用方只使用固定安全提示，不拼接原文。
const RULES = [
  // 交易 / 支付 / 取款 / 账户密码的显式赋值（排除疑问句：「是什么」「是不是」「几位」等）
  {
    reason: 'password',
    re: /(?:交易密码|支付密码|取款密码|银行卡密码|账户密码)\s*(?<!不)(?:是|为|[:：=])\s*(?![不否吗么几啥什])\S{4,}/,
  },
  // 动态验证码：显式标注 + 6 位数字（避免把任意 6 位数字当验证码；排除「是不是」疑问句）
  {
    reason: 'totp_code',
    re: /(?:动态验证码|验证码|动态码|TOTP\s*码|一次性密码|OTP)\s*(?<!不)(?:是|为|[:：=])\s*(?![不否吗么几啥什])\d{6}(?!\d)/i,
  },
  // 明确标注的 TOTP 种子 / 验证器密钥 / 加密主密钥
  {
    reason: 'totp_seed',
    re: /(?:TOTP\s*(?:种子|密钥|secret)|验证器密钥|主密钥|VERIFICATION_KEY)\s*(?:是|为|[:：=])\s*[A-Za-z0-9+/=_\-]{8,}/i,
  },
  // 常见 API Key 赋值形态
  {
    reason: 'api_key',
    re: /(?:DEEPSEEK_API_KEY|API[_\-\s]?KEY|SECRET[_\-\s]?KEY|ACCESS[_\-\s]?KEY)\s*[:：=]\s*[A-Za-z0-9_\-]{12,}/i,
  },
  // 裸 Key 形态（sk- 前缀）
  { reason: 'api_key', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
]

// 返回原因类型（'password' | 'totp_code' | 'totp_seed' | 'api_key'）或 null。
// 不返回、不记录命中的值。
export function detectCredential(text) {
  if (typeof text !== 'string' || !text) return null
  for (const { reason, re } of RULES) {
    if (re.test(text)) return reason
  }
  return null
}

// 固定安全提示（不含用户原文，可直接返回给客户端并展示）。
export const CREDENTIAL_REJECTION_MESSAGE =
  '为保护您的账户安全，这条消息包含疑似交易密码 / 动态验证码 / 密钥的内容，已拦截，' +
  '不会发送给 AI，也不会保存。请在页面上的专用验证表单中直接输入；请勿在聊天中发送密码、验证码或密钥。'

// 历史重放保护：构造「发给模型」的消息副本时，把命中凭据的文本替换为占位符。
// 只影响本轮模型输入，不改写数据库中的历史记录。
export const CREDENTIAL_REDACTED_PLACEHOLDER = '[该条历史内容含疑似凭据，已从模型输入中移除]'

export function scrubMessagesForModel(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m
    let out = m
    if (typeof m.content === 'string' && detectCredential(m.content)) {
      out = { ...out, content: CREDENTIAL_REDACTED_PLACEHOLDER }
    }
    if (Array.isArray(m.tool_calls)) {
      const calls = m.tool_calls.map((c) => {
        const raw = c && c.function && typeof c.function.arguments === 'string' ? c.function.arguments : null
        if (raw && detectCredential(raw)) {
          return { ...c, function: { ...c.function, arguments: '{}' } }
        }
        return c
      })
      out = { ...out, tool_calls: calls }
    }
    return out
  })
}
