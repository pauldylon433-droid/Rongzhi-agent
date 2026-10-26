// 真实代码沙箱：在独立 QuickJS WebAssembly 运行时中执行模型生成的「脱敏流水分析」代码。
// 隔离边界：
//   * 独立 WASM 运行时 / 独立堆，不暴露 Node 的 require、process、fetch、fs 或任何宿主函数；
//   * 无网络、无文件系统、无业务数据库 / 密钥 / 银行写接口；
//   * 每次执行设置内存上限、栈上限、墙钟超时、输出上限；超限立即中断并丢弃整个运行时；
//   * 只接收脱敏后的流水特征（金额 / 方向 / 分类 / 状态 / 时间 / 商户哈希），不接收余额或账户事实。
// 这不是 Node vm / eval / 普通子进程；也不是 OS 容器，隔离边界是 WebAssembly 运行时。
import { createHash, randomBytes } from 'node:crypto'
import { getQuickJS } from 'quickjs-emscripten'

const DEFAULTS = {
  timeoutMs: 2000,
  memoryLimitBytes: 32 * 1024 * 1024,
  stackSizeBytes: 1024 * 1024,
  maxOutputBytes: 16 * 1024,
  maxCodeChars: 8000,
}

let quickJsPromise = null
function quickJs() {
  if (!quickJsPromise) quickJsPromise = getQuickJS()
  return quickJsPromise
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
    network: false,
    filesystem: false,
    host_bindings: false,
  }
}

const WRAPPER_PREFIX = `(() => {
  "use strict";
  const __input = JSON.parse(globalThis.__SANDBOX_INPUT__);
  try {
    let __result;
`
const WRAPPER_SUFFIX = `
    if (typeof analyze !== "function") throw new Error("必须定义 analyze(transactions) 函数");
    __result = analyze(__input);
    const __json = JSON.stringify(__result);
    if (typeof __json !== "string") throw new Error("分析结果无法序列化为 JSON");
    return __json;
  } catch (e) {
    return JSON.stringify({ __sandbox_error: String(e && e.message ? e.message : e) });
  }
})()`

export async function runSandboxedAnalysis(code, rows, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (typeof code !== 'string' || !code.trim()) throw new SandboxError('分析代码不能为空', 'bad_code')
  if (code.length > opts.maxCodeChars) {
    throw new SandboxError('分析代码超过长度上限', 'code_too_long', { limit: opts.maxCodeChars })
  }
  const input = sanitizeTransactions(rows)
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  const QuickJS = await quickJs()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(opts.memoryLimitBytes)
  runtime.setMaxStackSize(opts.stackSizeBytes)
  runtime.setInterruptHandler(() => Date.now() > deadline)
  const context = runtime.newContext()
  let status = 'ok'
  let result = null
  let error = null
  try {
    const inputHandle = context.newString(JSON.stringify(input))
    context.setProp(context.global, '__SANDBOX_INPUT__', inputHandle)
    inputHandle.dispose()
    const source = WRAPPER_PREFIX + code + WRAPPER_SUFFIX
    const evalResult = context.evalCode(source, 'model-analysis.js')
    const value = context.unwrapResult(evalResult)
    const text = context.getString(value)
    value.dispose()
    if (Buffer.byteLength(text, 'utf8') > opts.maxOutputBytes) {
      status = 'output_limit'
      throw new SandboxError('分析输出超过上限，已终止', 'output_limit', { limit: opts.maxOutputBytes })
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new SandboxError('分析结果不是合法 JSON', 'bad_output') }
    if (parsed && typeof parsed === 'object' && parsed.__sandbox_error) {
      const msg = String(parsed.__sandbox_error)
      if (/out of memory|memory limit|stack overflow/i.test(msg)) {
        status = 'resource_limit'
        throw new SandboxError('分析超出内存 / 栈限制，已终止沙箱', 'resource_limit')
      }
      status = 'script_error'
      throw new SandboxError(`分析代码执行失败：${msg.slice(0, 200)}`, 'script_error')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      status = 'bad_output'
      throw new SandboxError('分析结果必须是 JSON 对象', 'bad_output')
    }
    result = parsed
  } catch (e) {
    if (e instanceof SandboxError) {
      error = e
    } else if (Date.now() > deadline) {
      status = 'timeout'
      error = new SandboxError('分析超时，已终止沙箱', 'timeout', { timeout_ms: opts.timeoutMs })
    } else if (/out of memory|memory limit|stack overflow|interrupted/i.test(String(e && e.message))) {
      status = 'resource_limit'
      error = new SandboxError('分析超出内存 / 栈限制，已终止沙箱', 'resource_limit')
    } else {
      status = 'runtime_error'
      error = new SandboxError('沙箱执行失败', 'runtime_error', { detail: String(e && e.message).slice(0, 200) })
    }
  } finally {
    try { context.dispose() } catch { /* ignore */ }
    try { runtime.dispose() } catch { /* ignore */ }
  }
  const summary = {
    sandbox: 'quickjs-wasm',
    status,
    elapsed_ms: Date.now() - started,
    limits: limitSummary(opts),
    input_rows: input.length,
    output_bytes: result ? Buffer.byteLength(JSON.stringify(result), 'utf8') : 0,
    code_sha256: createHash('sha256').update(code).digest('hex'),
  }
  if (error) throw Object.assign(error, { summary })
  return { result, summary }
}
