// 强验证状态路由：只读返回绑定与锁定状态（不含任何密码 / 密钥 / 验证码）。
import { Router } from 'express'
import { ok } from './helpers.js'
import { getVerificationStatus } from '../services/verification.js'

export function createVerificationRouter(db, demoUserId) {
  const router = Router()

  router.get('/status', (req, res) => {
    ok(res, getVerificationStatus(db, demoUserId))
  })

  return router
}
