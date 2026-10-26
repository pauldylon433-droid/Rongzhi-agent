// 可疑行为范围锁定中间件：按 IP / 会话 scope 隔离，不锁死整个共享演示服务。
// 与请求限流（429）、强验证锁定（423）分开；触发条件来自服务端拒绝 / 工具拒绝，而不是提示词关键词。
import { isSuspiciousError } from '../services/security-guard.js'

export function securityGuardMiddleware(guardFactory) {
  return async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
    const scopeKey = req.ip || req.socket?.remoteAddress || 'unknown'
    let guard
    try { guard = guardFactory(scopeKey) } catch { return next() }
    req.securityGuard = guard
    try {
      const allowed = await guard.assertAllowed()
      if (!allowed.allowed) {
        return res.status(423).json({
          success: false, code: 'suspicious_locked',
          message: '检测到异常操作，当前访问范围已临时锁定，请稍后重试',
          locked_until: allowed.locked_until,
        })
      }
    } catch {
      return next()
    }
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      res.locals.securityBody = body
      return originalJson(body)
    }
    res.on('finish', () => {
      const body = res.locals.securityBody
      if ([400, 403].includes(res.statusCode) && body && isSuspiciousError(body.message)) {
        guard.record('http_rejected', {
          method: req.method, path: `${req.baseUrl}${req.path}`.replace(/\/+$/, '') || '/',
          status: res.statusCode, message: String(body.message).slice(0, 120),
        }).catch((e) => console.error('[安全] 异常事件写入失败：', e && e.message ? e.message : e))
      }
    })
    return next()
  }
}
