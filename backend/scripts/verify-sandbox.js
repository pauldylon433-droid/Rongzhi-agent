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
  const h = await runSandboxedAnalysis(host, rows)
  check('沙箱隔离：无 fetch / require / process / fs / Function 逃逸',
    h.result.fetch === 'undefined' && h.result.require === 'undefined' && h.result.process === 'undefined'
    && h.result.fs === 'undefined' && h.result.escape === 'blocked', JSON.stringify(h.result))

  let timeoutErr
  try { await runSandboxedAnalysis('function analyze(){ while(true){} }', rows, { timeoutMs: 150 }) } catch (e) { timeoutErr = e }
  check('资源限制：死循环被超时终止', timeoutErr instanceof SandboxError && timeoutErr.code === 'timeout' && timeoutErr.summary.status === 'timeout', timeoutErr?.code)

  let memErr
  try {
    await runSandboxedAnalysis('function analyze(){ const a=[]; for(;;){ a.push(new Array(100000).fill(1)); } }', rows, { timeoutMs: 1000, memoryLimitBytes: 8 * 1024 * 1024 })
  } catch (e) { memErr = e }
  check('资源限制：内存耗尽被终止', memErr instanceof SandboxError && memErr.code === 'resource_limit', memErr?.code)

  let outErr
  try { await runSandboxedAnalysis("function analyze(){ return { x: 'a'.repeat(100000) }; }", rows, { maxOutputBytes: 1000 }) } catch (e) { outErr = e }
  check('资源限制：输出超过上限被终止', outErr instanceof SandboxError && outErr.code === 'output_limit', outErr?.code)

  let codeErr
  try { await runSandboxedAnalysis('x'.repeat(9000), rows) } catch (e) { codeErr = e }
  check('输入限制：代码长度超限被拒绝', codeErr instanceof SandboxError && codeErr.code === 'code_too_long', codeErr?.code)

  const bad = await runSandboxedAnalysis('function analyze(){ return { ok: true }; }', [])
  check('空输入也可运行且不产生业务写入', bad.result.ok === true && bad.summary.input_rows === 0)
} catch (e) {
  failures += 1
  console.error('SANDBOX TEST ERROR:', e.stack || e.message)
}
console.log(`\n== QuickJS WASM 沙箱验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
process.exit(failures ? 1 : 0)
