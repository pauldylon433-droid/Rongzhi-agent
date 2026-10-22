import { Router } from 'express'
import { ok } from './helpers.js'
import { listCards } from '../services/cards.js'

export function createCardsRouter(db, demoUserId) {
  const router = Router()
  router.get('/', (req, res) => {
    ok(res, listCards(db, demoUserId))
  })
  return router
}
