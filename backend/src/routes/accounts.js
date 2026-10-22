import { Router } from 'express'
import { ok } from './helpers.js'
import { listAccounts } from '../services/accounts.js'

export function createAccountsRouter(db, demoUserId) {
  const router = Router()
  router.get('/', (req, res) => {
    ok(res, listAccounts(db, demoUserId))
  })
  return router
}
