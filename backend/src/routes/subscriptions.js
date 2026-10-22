import { Router } from 'express'
import { ok } from './helpers.js'
import { listSubscriptions } from '../services/subscriptions.js'

export function createSubscriptionsRouter(db, demoUserId) {
  const router = Router()
  router.get('/', (req, res) => {
    ok(res, listSubscriptions(db, demoUserId))
  })
  return router
}
