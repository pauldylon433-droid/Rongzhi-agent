// 跨场景任务路由：最近任务 / 查看 / 选择订阅 / 暂停 / 继续 / 取消 / 转手动。
// 身份与数据归属由服务端演示用户固定；客户端不能指定任务类型、节点、依赖或任何业务步骤。
// 选择订阅仅接受 subscription_id；暂停 / 继续 / 取消 / 手动不接受任何额外字段。
import { Router } from 'express'
import { ok, badRequest } from './helpers.js'
import {
  getTask, listRecentTasks, selectSubscription, pauseTask, resumeTask, cancelTask, manualTask, AgentTaskError,
} from '../services/agent-tasks.js'

const SELECT_MSG = {
  bad_state: '当前任务状态不可选择订阅',
  not_found: '未找到该订阅',
  not_active: '该订阅当前不是生效状态，不能暂停',
  failed: '准备暂停单失败',
}

const LIFECYCLE_MSG = {
  bad_state: '当前任务状态不可执行此操作',
  not_found: '任务不存在',
  completed: '任务已完成',
  cancelled: '任务已取消',
  manual: '任务已转手动处理',
}

export function createAgentTasksRouter(db, demoUserId) {
  const router = Router()

  // 最近任务（轻量入口，便于新对话后继续查看）
  router.get('/recent', (req, res) => {
    try {
      ok(res, listRecentTasks(db, demoUserId))
    } catch (e) {
      console.error('[任务] 读取最近任务失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '读取最近任务失败' })
    }
  })

  // 查看任务（先对账再返回，刷新 / 重启可恢复）
  router.get('/:taskNo', (req, res) => {
    try {
      const task = getTask(db, demoUserId, req.params.taskNo)
      if (!task) return res.status(404).json({ success: false, message: '任务不存在' })
      ok(res, task)
    } catch (e) {
      console.error('[任务] 读取任务失败：', e && e.message ? e.message : e)
      res.status(500).json({ success: false, message: '读取任务失败' })
    }
  })

  // 用户选择要暂停的订阅（生成暂停操作单，不执行）
  router.post('/:taskNo/select', (req, res) => {
    const body = req.body || {}
    const extra = Object.keys(body).filter((k) => k !== 'subscription_id')
    if (extra.length) return badRequest(res, `不允许提交字段：${extra.join('、')}`)

    try {
      const r = selectSubscription(db, demoUserId, req.params.taskNo, body.subscription_id)
      if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
      if (r.outcome === 'selected') return ok(res, r.task)
      return res.status(409).json({ success: false, message: SELECT_MSG[r.outcome] || '当前状态不可选择订阅', data: r.task })
    } catch (e) {
      if (e instanceof AgentTaskError) return badRequest(res, e.message)
      throw e
    }
  })

  // 暂停任务（后端阻断关联未执行操作单）
  router.post('/:taskNo/pause', (req, res) => {
    const body = req.body || {}
    if (Object.keys(body).length) return badRequest(res, `暂停请求不允许提交字段：${Object.keys(body).join('、')}`)
    const r = pauseTask(db, demoUserId, req.params.taskNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
    if (r.outcome === 'paused' || r.outcome === 'completed') return ok(res, r.task)
    return res.status(409).json({ success: false, message: LIFECYCLE_MSG[r.outcome] || '当前状态不可暂停', data: r.task })
  })

  // 继续任务（重新校验，过期 / 失效单需重新生成并再次确认）
  router.post('/:taskNo/resume', (req, res) => {
    const body = req.body || {}
    if (Object.keys(body).length) return badRequest(res, `继续请求不允许提交字段：${Object.keys(body).join('、')}`)
    const r = resumeTask(db, demoUserId, req.params.taskNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
    if (r.outcome === 'waiting_selection' || r.outcome === 'waiting_confirmation') return ok(res, r.task)
    return res.status(409).json({ success: false, message: LIFECYCLE_MSG[r.outcome] || '当前状态不可继续', data: r.task })
  })

  // 取消任务（后端阻断关联未执行操作单；已确认变更不反向）
  router.post('/:taskNo/cancel', (req, res) => {
    const body = req.body || {}
    if (Object.keys(body).length) return badRequest(res, `取消请求不允许提交字段：${Object.keys(body).join('、')}`)
    const r = cancelTask(db, demoUserId, req.params.taskNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
    if (r.outcome === 'cancelled' || r.outcome === 'completed') return ok(res, r.task)
    return res.status(409).json({ success: false, message: LIFECYCLE_MSG[r.outcome] || '当前状态不可取消', data: r.task })
  })

  // 转手动处理（复用已有订阅操作入口，不虚假显示已接通客服）
  router.post('/:taskNo/manual', (req, res) => {
    const body = req.body || {}
    if (Object.keys(body).length) return badRequest(res, `手动请求不允许提交字段：${Object.keys(body).join('、')}`)
    const r = manualTask(db, demoUserId, req.params.taskNo)
    if (r.outcome === 'not_found') return res.status(404).json({ success: false, message: '任务不存在' })
    if (r.outcome === 'manual') return ok(res, r.task)
    return res.status(409).json({ success: false, message: LIFECYCLE_MSG[r.outcome] || '当前状态不可转手动', data: r.task })
  })

  return router
}
