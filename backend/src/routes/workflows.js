// 受约束 DAG 计划 API：创建 / 查看 / 选择 / 暂停 / 继续 / 取消 / 重试 / 修改未执行步骤 / 转人工。
// 计划本身不含执行权限；真正的资金 / 状态变更仍由对应操作单的确认 / 强验证接口完成。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import { WorkflowError } from '../services/workflow-plans.js'

function workflowFailure(res, e) {
  if (e instanceof WorkflowError) {
    if (e.code === 'not_found') return res.status(404).json({ success: false, message: e.message })
    if (e.code === 'conflict' || e.code === 'completed') return res.status(409).json({ success: false, message: e.message })
    return badRequest(res, e.message)
  }
  throw e
}

export function createWorkflowsRouter(service) {
  const router = Router()

  router.get('/', async (req, res) => {
    try { ok(res, await service.list(req.query.limit)) } catch (e) { workflowFailure(res, e) }
  })

  router.post('/', async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => !['flow', 'params', 'steps'].includes(k))
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    try {
      const view = await service.create({ flow: body.flow, params: body.params || {}, steps: body.steps })
      ok(res, view)
    } catch (e) { workflowFailure(res, e) }
  })

  router.get('/:planNo', async (req, res) => {
    try {
      const view = await service.get(req.params.planNo)
      if (!view) return res.status(404).json({ success: false, message: '计划不存在' })
      ok(res, view)
    } catch (e) { workflowFailure(res, e) }
  })

  router.post('/:planNo/select', async (req, res) => {
    const body = req.body || {}
    try { ok(res, await service.select(req.params.planNo, body)) } catch (e) { workflowFailure(res, e) }
  })

  for (const action of ['pause', 'resume', 'cancel', 'retry', 'manual']) {
    router.post(`/:planNo/${action}`, async (req, res) => {
      if (Object.keys(req.body || {}).length) return badRequest(res, `${action} 请求不允许提交字段`)
      try { ok(res, await service[action](req.params.planNo)) } catch (e) { workflowFailure(res, e) }
    })
  }

  router.post('/:planNo/modify', async (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'params')
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) return badRequest(res, 'params 必须是对象')
    try { ok(res, await service.modify(req.params.planNo, body.params)) } catch (e) { workflowFailure(res, e) }
  })

  return router
}
