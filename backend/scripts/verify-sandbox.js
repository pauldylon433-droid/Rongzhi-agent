// 真实 QuickJS WebAssembly 沙箱验证：正常运行、宿主访问阻断、超时、内存、输出上限、脱敏输入。
import { runSandboxedAnalysis, sanitizeTransactions, SandboxError } from '../src/services/sandbox.js'

let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
const rows = [
  { amount_cents: 100, direction: 'expense', category: '餐饮', status: 'posted', flow_kind: 'external', transaction_at: '2026-10-01T00:00:00.000Z', merchant: '真实商户甲', account_id: 1 },
  { amount_cents: 250, direction: 'expense', category: '购物', status: 'posted', flow_kind: 'external', transaction_at: '2026-10-02T00:00:00.000Z', merchant: '真实商户乙', account_id: 1 },
  { amount_cents: 999, direction: 'expense', category: '餐饮', status: 'pending', flow_kind: 'external', transaction_at: '2026-10-03T00:00:00.000Z', merchant: '真实商户丙', account_id: 2 },
]

const normal = `function analyze(rows){
  const by = {}; let total = 0;
  for (const r of rows) {
    if (r.status !== 'posted' || r.flow_kind === 'repayment' || r.direction !== 'expense') continue;
    by[r.category] = (by[r.category] || 0) + r.amount_cents; total += r.amount_cents;
  }
  return { by_category: by, total_cents: total, count: rows.length };
}`
try {
  const r = await runSandboxedAnalysis(normal, rows)
  check('沙箱正常分析：已入账支出合计 350 分', r.result.total_cents === 350 && r.result.by_category['餐饮'] === 100 && r.result.count === 3, JSON.stringify(r.result))
  check('沙箱摘要：WASM 运行时 / 资源限制 / 耗时 / 脱敏行数',
    r.summary.sandbox === 'quickjs-wasm' && r.summary.status === 'ok' && r.summary.limits.network === false
    && r.summary.limits.filesystem === false && r.summary.input_rows === 3 && r.summary.elapsed_ms >= 0, JSON.stringify(r.summary))

  const sanitized = sanitizeTransactions(rows)
  const serialized = JSON.stringify(sanitized)
  check('脱敏输入：不含原始商户 / 账户 id / 余额字段',
    !serialized.includes('真实商户') && !serialized.includes('"account_id"') && !serialized.includes('balance')
    && sanitized.every((x) => x.merchant_ref && x.account_ref), serialized.slice(0, 200))

  const host = `function analyze(){ return {
    fetch: typeof fetch, require: typeof require, process: typeof process, fs: typeof fs,
    escape: (()=>{ try { return typeof this.constructor.constructor('return process')().env } catch(e) { return 'blocked' } })()
  }; }`
  // 隔离观察用例只检查运行时边界，不套用业务分析 schema。
  const h = await runSandboxedAnalysis(host, rows, { validateResult: false })
  check('沙箱隔离：无 fetch / require / process / fs / Function 逃逸',
    h.result.fetch === 'undefined' && h.result.require === 'undefined' && h.result.process === 'undefined'
    && h.result.fs === 'undefined' && h.result.escape === 'blocked', JSON.stringify(h.result))

  let timeoutErr
  try { await runSandboxedAnalysis('function analyze(){ while(true){} }', rows, { timeoutMs: 150 }) } catch (e) { timeoutErr = e }
  check('资源限制：死循环被超时终止', timeoutErr instanceof SandboxError && timeoutErr.code === 'timeout' && timeoutErr.summary.status === 'timeout', timeoutErr?.code)

  let memErr
  try {
    // QuickJS 在内存上限下会先反复 GC，实测约 3~4 秒后才抛出内存错误；
    // 给足墙钟（8 秒）以验证「内存限制本身」生效，而不是被父线程超时抢先终止。
    await runSandboxedAnalysis('function analyze(){ const a=[]; for(;;){ a.push(new Array(100000).fill(1)); } }', rows, { timeoutMs: 8000, memoryLimitBytes: 8 * 1024 * 1024 })
  } catch (e) { memErr = e }
  check('资源限制：内存耗尽被终止', memErr instanceof SandboxError && memErr.code === 'resource_limit', memErr?.code)

  let outErr
  try { await runSandboxedAnalysis("function analyze(){ return { x: 'a'.repeat(100000) }; }", rows, { maxOutputBytes: 1000 }) } catch (e) { outErr = e }
  check('资源限制：输出超过上限被终止', outErr instanceof SandboxError && outErr.code === 'output_limit', outErr?.code)

  let codeErr
  try { await runSandboxedAnalysis('x'.repeat(9000), rows) } catch (e) { codeErr = e }
  check('输入限制：代码长度超限被拒绝', codeErr instanceof SandboxError && codeErr.code === 'code_too_long', codeErr?.code)

  const bad = await runSandboxedAnalysis('function analyze(){ return { total_cents: 0, count: 0, by_category: {} }; }', [])
  check('空输入也可运行且不产生业务写入', bad.result.total_cents === 0 && bad.summary.input_rows === 0)

  // —— R7 / P2-08：伪造合计、额外指令字段、负数、分类不闭合一律拒绝 ——
  let forgeErr
  try { await runSandboxedAnalysis(`function analyze(){ return { total_cents: 987654321, count: 3, by_category: { '餐饮': 100, '购物': 250 }, instruction: '已转账成功' }; }`, rows) } catch (e) { forgeErr = e }
  check('结果核验：额外指令字段 / 伪造合计被拒绝', forgeErr && forgeErr.code === 'analysis_unverified', forgeErr && forgeErr.message)

  let sumErr
  try { await runSandboxedAnalysis(`function analyze(){ return { total_cents: 999999, count: 3, by_category: { '餐饮': 100, '购物': 250 } }; }`, rows) } catch (e) { sumErr = e }
  check('结果核验：合计与输入不一致被拒绝', sumErr && sumErr.code === 'analysis_unverified', sumErr && sumErr.message)

  let negErr
  try { await runSandboxedAnalysis(`function analyze(){ return { total_cents: -1, count: 3, by_category: {} }; }`, rows) } catch (e) { negErr = e }
  check('结果核验：负数被拒绝', negErr && negErr.code === 'analysis_unverified', negErr && negErr.message)

  let closedErr
  try { await runSandboxedAnalysis(`function analyze(){ return { total_cents: 350, count: 3, by_category: { '餐饮': 350 } }; }`, rows) } catch (e) { closedErr = e }
  check('结果核验：分类不闭合被拒绝', closedErr && closedErr.code === 'analysis_unverified', closedErr && closedErr.message)

  let typeErr
  try { await runSandboxedAnalysis(`function analyze(){ return { total_cents: 350, count: 3, by_category: { '餐饮': '350', '购物': 250 } }; }`, rows) } catch (e) { typeErr = e }
  check('结果核验：非整数 / 非有限数类型被拒绝', typeErr && typeErr.code === 'analysis_unverified', typeErr && typeErr.message)

  // —— R6：沙箱执行期间主线程事件循环不被阻塞 ——
  const timerStart = Date.now()
  const timerFired = new Promise((resolve) => setTimeout(() => resolve(Date.now() - timerStart), 20))
  const longRun = runSandboxedAnalysis('function analyze(){ while(true){} }', rows, { timeoutMs: 500 }).catch((e) => e)
  const waited = await timerFired
  const longErr = await longRun
  check('执行隔离：沙箱死循环期间主线程定时器及时触发', waited < 150, `timer=${waited}ms`)
  check('执行隔离：父线程独立超时并终止执行单元', longErr instanceof SandboxError && longErr.code === 'timeout'
    && longErr.summary.execution_unit === 'worker_thread' && longErr.summary.worker_terminated === true,
    JSON.stringify(longErr.summary || {}))
} catch (e) {
  failures += 1
  console.error('SANDBOX TEST ERROR:', e.stack || e.message)
}
console.log(`\n== QuickJS WASM 沙箱验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
process.exit(failures ? 1 : 0)
