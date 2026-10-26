// QuickJS WebAssembly 执行核心：只在专用 Worker 线程中调用（见 sandbox-worker.js）。
// 不暴露 require / process / fetch / fs；无网络、无文件系统、无业务数据库。
import { getQuickJS } from 'quickjs-emscripten'

export const CORE_DEFAULTS = {
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

export class SandboxCoreError extends Error {
  constructor(message, code = 'sandbox_error') {
    super(message)
    this.name = 'SandboxCoreError'
    this.code = code
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

export async function executeInQuickJs(code, input, options = {}) {
  const opts = { ...CORE_DEFAULTS, ...options }
  if (typeof code !== 'string' || !code.trim()) throw new SandboxCoreError('分析代码不能为空', 'bad_code')
  if (code.length > opts.maxCodeChars) throw new SandboxCoreError('分析代码超过长度上限', 'code_too_long')
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  const QuickJS = await quickJs()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(opts.memoryLimitBytes)
  runtime.setMaxStackSize(opts.stackSizeBytes)
  runtime.setInterruptHandler(() => Date.now() > deadline)
  const context = runtime.newContext()
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
      throw new SandboxCoreError('分析输出超过上限，已终止', 'output_limit')
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new SandboxCoreError('分析结果不是合法 JSON', 'bad_output') }
    if (parsed && typeof parsed === 'object' && parsed.__sandbox_error) {
      const msg = String(parsed.__sandbox_error)
      if (/out of memory|memory limit|stack overflow/i.test(msg)) {
        throw new SandboxCoreError('分析超出内存 / 栈限制，已终止沙箱', 'resource_limit')
      }
      throw new SandboxCoreError(`分析代码执行失败：${msg.slice(0, 200)}`, 'script_error')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SandboxCoreError('分析结果必须是 JSON 对象', 'bad_output')
    }
    return { result: parsed, executionMs: Date.now() - started }
  } catch (e) {
    if (e instanceof SandboxCoreError) throw e
    const msg = String(e && e.message)
    // 资源错误可能表现为 "out of memory" 或中断；先区分明确的资源错误。
    if (/out of memory|memory limit|stack overflow/i.test(msg)) {
      throw new SandboxCoreError('分析超出内存 / 栈限制，已终止沙箱', 'resource_limit')
    }
    if (Date.now() >= deadline - 5) throw new SandboxCoreError('分析超时，已终止沙箱', 'timeout')
    if (/interrupted/i.test(msg)) {
      throw new SandboxCoreError('分析超出内存 / 栈限制，已终止沙箱', 'resource_limit')
    }
    throw new SandboxCoreError('沙箱执行失败', 'runtime_error')
  } finally {
    try { context.dispose() } catch { /* ignore */ }
    try { runtime.dispose() } catch { /* ignore */ }
  }
}
