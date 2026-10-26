// 真实代码沙箱入口：模型生成的「脱敏流水分析」代码在专用 worker_threads 中执行，
// QuickJS WebAssembly 运行时位于该 Worker 内，主线程事件循环不被同步执行阻塞。
// 隔离边界：
//   * 独立 Worker + 独立 QuickJS WASM 堆，不暴露 Node 的 require、process、fetch、fs；
//   * 无网络、无文件系统、无业务数据库 / 密钥 / 银行写接口；
//   * 每次执行设置内存 / 栈 / 墙钟 / 输出上限；父线程可独立超时并 terminate；
//   * 有限并发 + 有界队列；排队时间与执行时间分开记录；
//   * 输出必须符合可核验的分析 schema，并与沙箱输入独立复算一致，否则标记「未核验」并拒绝。
// 这不是 OS 容器，隔离边界是 Worker + WebAssembly 运行时。
import { createHash, randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { CORE_DEFAULTS } from './sandbox-core.js'

const num = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
const DEFAULTS = {
  ...CORE_DEFAULTS,
  maxConcurrency: num('SANDBOX_MAX_CONCURRENT', 2),
  maxQueue: num('SANDBOX_MAX_QUEUE', 20),
  queueTimeoutMs: num('SANDBOX_QUEUE_TIMEOUT_MS', 5000),
}

export class SandboxError extends Error {
  constructor(message, code = 'sandbox_error', detail = {}) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
    Object.assign(this, detail)
  }
}

function stableRef(value, salt) {
  return createHash('sha256').update(salt).update('\0').update(String(value ?? '')).digest('hex').slice(0, 12)
}

// 只输出分析所需的脱敏特征；商户 / 账户 / 用户标识不进入沙箱原文。
export function sanitizeTransactions(rows, now = new Date()) {
  const salt = randomBytes(16).toString('hex')
  return rows.map((r) => ({
    amount_cents: Number(r.amount_cents),
    direction: r.direction,
    category: typeof r.category === 'string' ? r.category.slice(0, 40) : '',
    status: r.status,
    flow_kind: r.flow_kind,
    transaction_at: r.transaction_at,
    month: String(r.transaction_at || '').slice(0, 7),
    merchant_ref: r.merchant ? stableRef(r.merchant, salt) : null,
    account_ref: r.account_id != null ? stableRef(`account:${r.account_id}`, salt) : null,
  }))
}

function limitSummary(opts) {
  return {
    timeout_ms: opts.timeoutMs,
    memory_limit_bytes: opts.memoryLimitBytes,
    stack_limit_bytes: opts.stackSizeBytes,
    max_output_bytes: opts.maxOutputBytes,
    max_code_chars: opts.maxCodeChars,
    max_concurrency: opts.maxConcurrency,
    max_queue: opts.maxQueue,
    queue_timeout_ms: opts.queueTimeoutMs,
    network: false,
    filesystem: false,
    host_bindings: false,
  }
}

// —— 有限并发 + 有界队列 ——
let activeWorkers = 0
const waiters = []
function acquireSlot(opts) {
  if (activeWorkers < opts.maxConcurrency) {
    activeWorkers += 1
    return Promise.resolve(true)
  }
  if (waiters.length >= opts.maxQueue) return Promise.resolve(false)
  return new Promise((resolve) => {
    const entry = { resolve, timer: null }
    entry.timer = setTimeout(() => {
      const i = waiters.indexOf(entry)
      if (i >= 0) waiters.splice(i, 1)
      resolve(false)
    }, opts.queueTimeoutMs)
    waiters.push(entry)
  })
}
function releaseSlot() {
  const next = waiters.shift()
  if (next) {
    clearTimeout(next.timer)
    // 直接把槽位交给下一个等待者（activeWorkers 不变）
    next.resolve(true)
    return
  }
  activeWorkers = Math.max(0, activeWorkers - 1)
}

const ALLOWED_RESULT_KEYS = new Set(['total_cents', 'count', 'by_category', 'income_cents', 'expense_count', 'income_count'])

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function isNonNegativeInt(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 }

// 独立复算：以脱敏输入为准，检查模型声称的合计 / 计数 / 分类是否闭合。
// 口径：total_cents / by_category 只统计「已入账、非还款、支出」；count 为输入行数。
export function expectedAnalysis(input) {
  const posted = input.filter((r) => r.status === 'posted' && r.flow_kind !== 'repayment')
  const expense = posted.filter((r) => r.direction === 'expense')
  const income = posted.filter((r) => r.direction === 'income')
  const byCategory = {}
  let total = 0
  for (const r of expense) {
    const amount = Number(r.amount_cents)
    if (!Number.isSafeInteger(amount) || amount < 0) continue
    const key = typeof r.category === 'string' ? r.category : ''
    byCategory[key] = (byCategory[key] || 0) + amount
    total += amount
  }
  return {
    total_cents: total,
    count: input.length,
    by_category: byCategory,
    income_cents: income.reduce((s, r) => s + (Number.isSafeInteger(Number(r.amount_cents)) ? Number(r.amount_cents) : 0), 0),
    expense_count: expense.length,
    income_count: income.length,
  }
}

export function validateAnalysisResult(result, input) {
  const fail = (msg) => { throw new SandboxError(`分析结果未通过核验：${msg}`, 'analysis_unverified') }
  if (!isPlainObject(result)) fail('结果必须是对象')
  const unknown = Object.keys(result).filter((k) => !ALLOWED_RESULT_KEYS.has(k))
  if (unknown.length) fail(`包含未定义字段（${unknown.slice(0, 5).join('、')}）`)
  if (!isNonNegativeInt(result.total_cents)) fail('total_cents 必须是非负安全整数')
  if (result.count !== undefined && !isNonNegativeInt(result.count)) fail('count 必须是非负安全整数')
  if (result.by_category !== undefined && !isPlainObject(result.by_category)) fail('by_category 必须是对象')
  const cats = result.by_category ? Object.keys(result.by_category) : []
  if (cats.length > 100) fail('分类数量过多')
  for (const k of cats) {
    if (typeof k !== 'string' || k.length > 60) fail('分类名称不合法')
    if (!isNonNegativeInt(result.by_category[k])) fail(`分类 ${k} 的金额必须是非负安全整数`)
  }
  for (const key of ['income_cents', 'expense_count', 'income_count']) {
    if (result[key] !== undefined && !isNonNegativeInt(result[key])) fail(`${key} 必须是非负安全整数`)
  }
  const expected = expectedAnalysis(input)
  if (result.total_cents !== expected.total_cents) {
    fail(`支出合计与输入不一致（声称 ${result.total_cents}，复算 ${expected.total_cents}）`)
  }
  if (result.count !== undefined && result.count !== expected.count) {
    fail(`行数与输入不一致（声称 ${result.count}，实际 ${expected.count}）`)
  }
  if (result.by_category !== undefined) {
    const claimedCats = Object.keys(result.by_category).sort()
    const expectedCats = Object.keys(expected.by_category).sort()
    if (claimedCats.length !== expectedCats.length || claimedCats.some((k, i) => k !== expectedCats[i])) {
      fail('分类集合与输入不一致')
    }
    for (const k of expectedCats) {
      if (result.by_category[k] !== expected.by_category[k]) {
        fail(`分类 ${k} 的金额与输入不一致`)
      }
    }
  }
  if (result.income_cents !== undefined && result.income_cents !== expected.income_cents) fail('收入合计与输入不一致')
  if (result.expense_count !== undefined && result.expense_count !== expected.expense_count) fail('支出笔数与输入不一致')
  if (result.income_count !== undefined && result.income_count !== expected.income_count) fail('收入笔数与输入不一致')
  const out = { total_cents: result.total_cents }
  if (result.by_category !== undefined) out.by_category = { ...result.by_category }
  if (result.count !== undefined) out.count = result.count
  if (result.income_cents !== undefined) out.income_cents = result.income_cents
  if (result.expense_count !== undefined) out.expense_count = result.expense_count
  if (result.income_count !== undefined) out.income_count = result.income_count
  return out
}

function runWorker(code, input, opts) {
  return new Promise((resolve, reject) => {
    let settled = false
    let worker
    // 父线程的墙钟是权威超时；Worker 内部的 QuickJS 中断只作为兜底（更长），
    // 这样正常超时由父线程 terminate 并如实记录 worker_terminated。
    const coreOpts = { ...opts, timeoutMs: opts.timeoutMs + 1000 }
    const parentDeadlineMs = opts.timeoutMs + 250
    try {
      worker = new Worker(new URL('./sandbox-worker.js', import.meta.url), {
        workerData: { code, input, opts: coreOpts },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      })
    } catch (e) {
      reject(new SandboxError('沙箱执行单元启动失败', 'runtime_error', { detail: String(e && e.message).slice(0, 200) }))
      return
    }
    let terminated = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      terminated = true
      worker.terminate().catch(() => {})
      finish(reject, new SandboxError('分析超时，已终止沙箱执行单元', 'timeout', { worker_terminated: true }))
    }, parentDeadlineMs)
    worker.once('message', (m) => {
      finish(resolve, m)
      worker.terminate().catch(() => {})
    })
    worker.once('error', (e) => {
      finish(reject, new SandboxError('沙箱执行单元异常', 'runtime_error', {
        detail: String(e && e.message ? e.message : e).slice(0, 200),
      }))
    })
    worker.once('exit', () => {
      if (!settled) finish(reject, new SandboxError('沙箱执行单元提前退出', 'runtime_error', { worker_terminated: terminated }))
    })
  })
}

export async function runSandboxedAnalysis(code, rows, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (typeof code !== 'string' || !code.trim()) throw new SandboxError('分析代码不能为空', 'bad_code')
  if (code.length > opts.maxCodeChars) {
    throw new SandboxError('分析代码超过长度上限', 'code_too_long', { limit: opts.maxCodeChars })
  }
  const input = sanitizeTransactions(rows)
  const requestedAt = Date.now()
  const acquired = await acquireSlot(opts)
  if (!acquired) {
    throw new SandboxError('沙箱分析请求过多，请稍后重试', 'sandbox_busy', {
      limits: limitSummary(opts), queue_ms: Date.now() - requestedAt,
    })
  }
  const started = Date.now()
  const queueMs = started - requestedAt
  let status = 'ok'
  let result = null
  let error = null
  let workerTerminated = false
  const execStarted = Date.now()
  try {
    const msg = await runWorker(code, input, opts)
    if (!msg || msg.ok !== true) {
      status = msg && msg.code ? String(msg.code) : 'runtime_error'
      throw new SandboxError(msg && msg.message ? msg.message : '沙箱执行失败', status)
    }
    result = opts.validateResult === false ? msg.result : validateAnalysisResult(msg.result, input)
  } catch (e) {
    if (e instanceof SandboxError) {
      error = e
      status = e.code
      workerTerminated = e.worker_terminated === true
    } else {
      error = new SandboxError('沙箱执行失败', 'runtime_error')
      status = 'runtime_error'
    }
  } finally {
    releaseSlot()
  }
  const executionMs = Date.now() - execStarted
  const summary = {
    sandbox: 'quickjs-wasm',
    execution_unit: 'worker_thread',
    status,
    queue_ms: queueMs,
    execution_ms: executionMs,
    elapsed_ms: Date.now() - requestedAt,
    worker_terminated: workerTerminated,
    limits: limitSummary(opts),
    input_rows: input.length,
    output_bytes: result ? Buffer.byteLength(JSON.stringify(result), 'utf8') : 0,
    code_sha256: createHash('sha256').update(code).digest('hex'),
  }
  if (error) throw Object.assign(error, { summary })
  return { result, summary }
}
