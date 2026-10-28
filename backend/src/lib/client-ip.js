// 客户端来源标识：仅在 CloudBase 网关模式下读取网关注入的 X-Original-Forwarded-For。
// 实测该网关会用真实客户端 IP 覆盖/追加该头（最后一段），而 X-Forwarded-For / X-Real-IP
// 会把客户端自带值原样透传，不能作为限流 / 可疑锁定的 scope 依据。
import net from 'node:net'

export const CLOUDBASE_TRUST_PROXY_MODE = 'cloudbase'

function headerValue(req, name) {
  const raw = req && req.headers ? req.headers[name] : undefined
  if (Array.isArray(raw)) return raw.join(',')
  return typeof raw === 'string' ? raw : ''
}

// 网关在链尾追加真实客户端 IP：取最后一个合法 IP，忽略客户端在左侧伪造的段落。
export function parseOriginalForwardedFor(value) {
  const parts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (net.isIP(parts[i])) return parts[i]
  }
  return ''
}

export function getClientIp(req, rawMode = process.env.TRUST_PROXY) {
  const mode = String(rawMode || '').trim().toLowerCase()
  if (mode === CLOUDBASE_TRUST_PROXY_MODE) {
    const parsed = parseOriginalForwardedFor(headerValue(req, 'x-original-forwarded-for'))
    if (parsed) return parsed
  }
  // 默认沿用 Express 的 req.ip（默认不信任代理头，即 socket 地址）；
  // TRUST_PROXY=1 / 数字时由 Express 按显式配置解析 X-Forwarded-For。
  return (req && req.ip) || (req && req.socket && req.socket.remoteAddress) || 'unknown'
}
