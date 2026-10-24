import { Router } from 'express'
import { createAccountsRouter } from './accounts.js'
import { createTransactionsRouter } from './transactions.js'
import { createCardsRouter } from './cards.js'
import { createSubscriptionsRouter } from './subscriptions.js'
import { createAnalyticsRouter } from './analytics.js'
import { createAssistantRouter } from './assistant.js'
import { createTransfersRouter } from './transfers.js'
import { createVerificationRouter } from './verification.js'
import { createCardOperationsRouter } from './card-operations.js'
import { createSubscriptionOperationsRouter } from './subscription-operations.js'
import { createAgentTasksRouter } from './agent-tasks.js'
import { createActivityRouter } from './activity.js'
import { createCreditRouter } from './credit.js'
import { createRepaymentsRouter } from './repayments.js'

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
  router.use('/card-operations', createCardOperationsRouter(db, demoUserId))
  router.use('/subscription-operations', createSubscriptionOperationsRouter(db, demoUserId))
  router.use('/agent-tasks', createAgentTasksRouter(db, demoUserId))
  router.use('/activity', createActivityRouter(db, demoUserId))
  router.use('/credit', createCreditRouter(db, demoUserId))
  router.use('/repayments', createRepaymentsRouter(db, demoUserId))
  return router
}
