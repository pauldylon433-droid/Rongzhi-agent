// 定向验证：强验证两类凭据失败对外响应一致 + 正确双因素可通过 + 锁定 / 防重放不变。
//
// 使用独立临时库（initDatabase seed:true 于系统临时目录），不触碰开发库，不调用收费模型。
// 覆盖：
//   1) 错误密码 + 有效动态码、正确密码 + 错误动态码 → 相同 HTTP 状态 / 业务码 / 文案；
//   2) 响应体不含 factor / 密码或验证码明文等调试字段，文案不暗示哪一项正确；
//   3) 剩余次数按累计规则展示，不随失败因素变化；
//   4) 正确密码 + 有效动态码 → 成功且仅扣款一次；
//   5) 锁定（连续 5 次，交替两类错误）与防重放（同一时间步不可复用）保持有效。
// 用法：node scripts/verify-verify-message-uniform.js
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createTransfer } from '../src/services/transfers.js'
import { bindVerification, MAX_VERIFY_FAILURES } from '../src/services/verification.js'
import { totpAt, totpStep } from '../src/lib/totp.js'
import { createApiRouter } from '../src/routes/index.js'
import express from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const tmpPath = join(tmpdir(), 'rongzhi-verify-uniform.db')
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

const SECRET_BUF = Buffer.from('12345678901234567890', 'ascii')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const KEY = Buffer.alloc(32, 0x42)
const PASSWORD = 'verify-uniform-pass'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: tmpPath, seed: true })
const userId = resolveDemoUser(db).id
bindVerification(db, userId, { password: PASSWORD, totpSecretBase32: SECRET_B32, encryptionKey: KEY, matchedStep: 0 })
process.env.VERIFICATION_KEY = KEY.toString('base64')

const nowStep = () => totpStep(Date.now())
const goodCode = () => totpAt(SECRET_BUF, nowStep())
// 构造一个必然无效的动态码（避开本步与相邻步，防止窗口内误命中）
function badCode() {
  const good = goodCode()
  const near = new Set([good, totpAt(SECRET_BUF, nowStep() - 1), totpAt(SECRET_BUF, nowStep() + 1)])
  let n = (Number(good) + 7) % 1000000
  let s = String(n).padStart(6, '0')
  while (near.has(s)) { n = (n + 1) % 1000000; s = String(n).padStart(6, '0') }
  return s
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const debit = () => db.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(userId).b
const failCount = () => (db.prepare('SELECT fail_count AS c FROM verification_failures WHERE user_id = ?').get(userId) || { c: 0 }).c

async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(db, userId))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try { await fn(`http://127.0.0.1:${server.address().port}/api`) } finally { await new Promise((r) => server.close(r)) }
}

await withServer(async (base) => {
  // 红色待验证单（超过当日累计限额）
  const redOp = createTransfer(db, userId, { recipientId: 1, amountCents: 150000 })
  check('构造红色待验证单', redOp.status === 'needs_verification', redOp.status)

  // ① 错误密码 + 有效动态码
  const beforeAny = debit()
  const r1 = await postJson(`${base}/transfers/${redOp.ref_no}/verify`, { password: PASSWORD + 'x', totp: goodCode() })
  const b1 = await r1.json()
  // ② 正确密码 + 错误动态码
  const r2 = await postJson(`${base}/transfers/${redOp.ref_no}/verify`, { password: PASSWORD, totp: badCode() })
  const b2 = await r2.json()

  // 剩余次数按累计规则递增变化，比较文案时剔除次数后缀，只比较「不随失败因素变化」的正文
  const stripCount = (m) => String(m || '').replace(/（还可尝试 \d+ 次）/, '')
  check('两类失败 HTTP 状态一致（401）', r1.status === 401 && r2.status === 401, `${r1.status} / ${r2.status}`)
  check('两类失败业务码一致（bad_credentials）', b1.code === 'bad_credentials' && b2.code === 'bad_credentials', `${b1.code} / ${b2.code}`)
  check('两类失败文案正文完全一致', stripCount(b1.message) === stripCount(b2.message), `${stripCount(b1.message)} / ${stripCount(b2.message)}`)
  check('文案为通用提示（不区分因素）', /交易密码或动态验证码不正确/.test(b1.message || ''), b1.message)
  check('文案不含「交易密码错误」「动态验证码错误」等区分性措辞', !/密码错误|验证码错误|动态验证码错误或已过期/.test(b1.message || ''))
  check('响应不含 factor / 密码 / 验证码回显字段', !('factor' in b1) && !('factor' in b2) && !JSON.stringify(b1).includes(PASSWORD) && !JSON.stringify(b1).includes(goodCode()))
  check('剩余次数按累计规则（第 1 次失败后 4 次）', /还可尝试 4 次/.test(b1.message || ''), b1.message)
  check('剩余次数按累计规则（第 2 次失败后 3 次）', /还可尝试 3 次/.test(b2.message || ''), b2.message)
  check('失败计数累计为 2', failCount() === 2, String(failCount()))
  check('两类失败均未扣款', debit() === beforeAny, `${beforeAny}→${debit()}`)

  // ③ 正确密码 + 有效动态码 → 成功
  const before = debit()
  const code = goodCode()
  const step = nowStep()
  const r3 = await postJson(`${base}/transfers/${redOp.ref_no}/verify`, { password: PASSWORD, totp: code })
  const b3 = await r3.json()
  check('正确双因素 → 成功（200 completed）', r3.status === 200 && b3.data && b3.data.status === 'completed', `${r3.status} ${b3.message || ''}`)
  check('仅扣款一次（150000）', before - debit() === 150000, `${before}→${debit()}`)
  check('成功后失败计数清零', failCount() === 0, String(failCount()))

  // ④ 防重放：新单复用同一时间步 → code_reused
  const redOp2 = createTransfer(db, userId, { recipientId: 2, amountCents: 150000 })
  const before2 = debit()
  const r4 = await postJson(`${base}/transfers/${redOp2.ref_no}/verify`, { password: PASSWORD, totp: code })
  const b4 = await r4.json()
  check('同一时间步跨单复用被拒（409 code_reused）', r4.status === 409 && b4.code === 'code_reused', `${r4.status} ${b4.code || ''}`)
  check('防重放拒绝不扣款', debit() === before2)
  check('防重放拒绝不累计失败次数', failCount() === 0, String(failCount()))

  // ⑤ 锁定：交替两类错误连续 5 次 → 第 5 次锁定；前 4 次文案仍一致
  const redOp3 = createTransfer(db, userId, { recipientId: 1, amountCents: 150000 })
  const msgs = []
  const codes = []
  const statuses = []
  for (let i = 0; i < MAX_VERIFY_FAILURES; i += 1) {
    const body = i % 2 === 0 ? { password: PASSWORD + 'x', totp: goodCode() } : { password: PASSWORD, totp: badCode() }
    const res = await postJson(`${base}/transfers/${redOp3.ref_no}/verify`, body)
    const b = await res.json()
    statuses.push(res.status)
    msgs.push(b.message)
    codes.push(b.code)
    if (i === MAX_VERIFY_FAILURES - 2) {
      check('锁定前最后一次仍为通用响应（401 / bad_credentials）', res.status === 401 && b.code === 'bad_credentials', `${res.status}`)
      check('锁定前四次文案正文一致（交替错误不改变提示）', new Set(msgs.slice(0, i + 1).map(stripCount)).size === 1, stripCount(msgs[0]))
      check('剩余次数按累计递减（4→3→2→1）', msgs.slice(0, 4).map((m) => (m.match(/还可尝试 (\d+) 次/) || [])[1]).join(',') === '4,3,2,1')
    }
  }
  check(`连续 ${MAX_VERIFY_FAILURES} 次错误触发锁定（423 locked）`, statuses[MAX_VERIFY_FAILURES - 1] === 423 && codes[MAX_VERIFY_FAILURES - 1] === 'locked', `${statuses[MAX_VERIFY_FAILURES - 1]} ${codes[MAX_VERIFY_FAILURES - 1]}`)
  const st = await (await fetch(`${base}/verification/status`)).json()
  check('锁定状态对外可见（locked=true）', st.data.locked === true && !!st.data.locked_until, JSON.stringify(st.data))
  const beforeLocked = debit()
  const rLocked = await postJson(`${base}/transfers/${redOp3.ref_no}/verify`, { password: PASSWORD, totp: goodCode() })
  const bLocked = await rLocked.json()
  check('锁定期间即使凭据正确也被阻断（423）', rLocked.status === 423 && bLocked.code === 'locked', `${rLocked.status}`)
  check('锁定期间不扣款', debit() === beforeLocked)
})

db.close()
for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n定向验证全部通过 ✅（独立临时库，开发库未改动）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
