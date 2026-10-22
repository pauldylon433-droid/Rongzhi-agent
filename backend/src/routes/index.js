import { Router } from 'express'
import { createAccountsRouter } from './accounts.js'
import { createTransactionsRouter } from './transactions.js'
import { createCardsRouter } from './cards.js'
import { createSubscriptionsRouter } from './subscriptions.js'
import { createAnalyticsRouter } from './analytics.js'
import { createAssistantRouter } from './assistant.js'
import { createTransfersRouter } from './transfers.js'
import { createVerificationRouter } from './verification.js'

export function createApiRouter(db, demoUserId) {
  const router = Router()
  router.use('/accounts', createAccountsRouter(db, demoUserId))
  router.use('/transactions', createTransactionsRouter(db, demoUserId))
  router.use('/cards', createCardsRouter(db, demoUserId))
  router.use('/subscriptions', createSubscriptionsRouter(db, demoUserId))
  router.use('/analytics', createAnalyticsRouter(db, demoUserId))
  router.use('/assistant', createAssistantRouter(db, demoUserId))
  router.use('/transfers', createTransfersRouter(db, demoUserId))
  router.use('/verification', createVerificationRouter(db, demoUserId))
  return router
}
