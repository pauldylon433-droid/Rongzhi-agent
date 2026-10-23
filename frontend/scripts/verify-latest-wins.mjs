// 验证右面板「权威状态回读」的异步竞态防护（requestGuard + 事件归属双重丢弃）。
// 复现 BusinessInfoPanel.fetchAuthoritative 的判定逻辑，用真实乱序 Promise 覆盖两个场景：
//   1) 同一操作的旧 pending 请求晚于 completed 请求返回 → 不得覆盖 completed；
//   2) 切换会话后旧响应返回（含切换后重开同一 key）→ 不得覆盖当前会话正确状态。
// 纯 Node、无 Vue 依赖。用法：node scripts/verify-latest-wins.mjs
import { createRequestGuard } from '../src/utils/requestGuard.js'

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 复现组件判定：发起回读时取令牌；响应到达时「令牌最新 && key 仍在当前事件」才写入。
function makeResolver() {
  const guard = createRequestGuard()
  const state = new Map()
  const events = new Set() // 当前会话业务事件的 key 集合
  async function resolve(key, delayMs, view) {
    const token = guard.next(key)
    await sleep(delayMs)
    if (view && guard.isLatest(key, token) && events.has(key)) {
      state.set(key, view)
    }
  }
  return { guard, state, events, resolve }
}

// 场景 1：同一操作旧 pending 晚于 completed 返回
{
  const { state, events, resolve } = makeResolver()
  events.add('op-1')
  // 先发起（慢）的 pending，后发起（快）的 completed —— completed 先返回，pending 后返回
  const p1 = resolve('op-1', 60, { status: 'pending' })
  const p2 = resolve('op-1', 10, { status: 'completed' })
  await Promise.all([p1, p2])
  check('1.1 旧 pending 晚到不覆盖 completed', state.get('op-1').status === 'completed', state.get('op-1').status)
}

// 场景 2：切换会话后，旧会话 key 的响应返回 → 丢弃（key 已不在当前事件）
{
  const { state, events, resolve } = makeResolver()
  events.add('op-old')
  const p = resolve('op-old', 30, { status: 'pending' })
  events.delete('op-old') // 切换会话：新会话不含 op-old
  await p
  check('2.1 切换会话后旧响应不写入', state.get('op-old') === undefined, String(state.get('op-old')))
}

// 场景 3：切换会话后又重开同一 key（同一会话被重新打开，重新回读）→ 旧访问的迟到响应不覆盖新回读
{
  const { state, events, resolve } = makeResolver()
  events.add('op-1')
  const stale = resolve('op-1', 60, { status: 'pending' }) // 上次访问发起的（慢）请求
  // 离开又回来：重新发起回读（最新令牌），返回权威 completed
  const fresh = resolve('op-1', 5, { status: 'completed' })
  await Promise.all([stale, fresh])
  check('3.1 重开同一 key 时旧响应不覆盖新回读', state.get('op-1').status === 'completed', state.get('op-1').status)
}

// 场景 4：不同 key 互不影响（A 的迟到响应不影响 B）
{
  const { state, events, resolve } = makeResolver()
  events.add('a')
  events.add('b')
  const pa = resolve('a', 40, { status: 'pending' })
  const pb = resolve('b', 5, { status: 'completed' })
  await Promise.all([pa, pb])
  check('4.1 B 正常写入', state.get('b').status === 'completed')
  check('4.2 A 正常写入（与 B 无关）', state.get('a').status === 'pending')
}

// 场景 5：守卫原语语义
{
  const g = createRequestGuard()
  const t1 = g.next('k')
  const t2 = g.next('k')
  check('5.1 令牌严格递增', t2 === t1 + 1, `${t1}->${t2}`)
  check('5.2 旧令牌不再最新', g.isLatest('k', t1) === false)
  check('5.3 新令牌为最新', g.isLatest('k', t2) === true)
  check('5.4 不同 key 各自独立', g.next('other') === 1 && g.isLatest('k', t2) === true)
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
