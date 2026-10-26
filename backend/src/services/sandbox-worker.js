// 沙箱执行 Worker：QuickJS 只在独立 worker_threads 中运行，主线程不被同步执行阻塞。
// 父线程可独立超时并 terminate；本线程不做任何业务读写，只返回结构化结果。
import { parentPort, workerData } from 'node:worker_threads'
import { executeInQuickJs } from './sandbox-core.js'

const { code, input, opts } = workerData || {}

try {
  const r = await executeInQuickJs(code, input, opts)
  parentPort.postMessage({ ok: true, result: r.result, execution_ms: r.executionMs })
} catch (e) {
  parentPort.postMessage({
    ok: false,
    code: e && e.code ? e.code : 'runtime_error',
    message: String(e && e.message ? e.message : e).slice(0, 300),
  })
}
