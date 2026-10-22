// 交互输入处理单元校验：验证隐藏输入状态机（退格 / 粘贴 / 回车 CR/LF/CRLF / Ctrl+C / ANSI 控制序列）
// 与非交互终端拒绝逻辑。纯单元测试：不触碰数据库、不绑定、不读真实凭据、不打印任何秘密。
// 用法：node scripts/verify-bind-interaction.js
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  processKey,
  hidden,
  assertInteractive,
  NonInteractiveError,
  InterruptedError,
} from './bind-verification.js'

let passed = 0
const checks = []
function check(name, fn) {
  checks.push([name, fn])
}

function fakeStdin() {
  const em = new EventEmitter()
  em.isTTY = true
  em.isRaw = false
  em.setRawMode = (v) => { em.isRaw = v }
  em.setEncoding = () => {}
  em.resume = () => {}
  em.pause = () => {}
  return em
}

function captureStdout() {
  const writes = []
  return { isTTY: true, write: (s) => { writes.push(String(s)); return true }, writes }
}

console.log('校验：隐藏输入状态机 processKey')

check('追加可打印字符', () => {
  const s = { buf: '', inEsc: false }
  processKey(s, 'a'); processKey(s, 'b'); processKey(s, '1')
  assert.equal(s.buf, 'ab1')
})

check('退格 \\x7f 与 \\b', () => {
  const s = { buf: 'abc', inEsc: false }
  processKey(s, '\x7f')
  assert.equal(s.buf, 'ab')
  processKey(s, '\b')
  assert.equal(s.buf, 'a')
})

check('CR 回车触发 submit', () => {
  const s = { buf: 'pw', inEsc: false }
  assert.deepEqual(processKey(s, '\r'), { submit: true, interrupt: false })
})

check('LF 回车触发 submit', () => {
  const s = { buf: 'pw', inEsc: false }
  assert.equal(processKey(s, '\n').submit, true)
})

check('CRLF：CR 触发 submit 且不残留字符', () => {
  const s = { buf: '', inEsc: false }
  let submitted = false
  for (const ch of 'pw\r\n') {
    const r = processKey(s, ch)
    if (r.submit) { submitted = true; break }
  }
  assert.equal(submitted, true)
  assert.equal(s.buf, 'pw')
})

check('Ctrl+C 触发 interrupt', () => {
  const s = { buf: '', inEsc: false }
  assert.equal(processKey(s, '\x03').interrupt, true)
})

check('ANSI 方向键 / 功能键序列被吞掉，不污染输入', () => {
  for (const seq of ['\x1b[A', '\x1b[B', '\x1b[1;5D', '\x1bOH', '\x1bOF']) {
    const s = { buf: 'pw', inEsc: false }
    for (const ch of seq) processKey(s, ch)
    assert.equal(s.buf, 'pw')
  }
})

check('其他控制字符（Tab）忽略', () => {
  const s = { buf: 'pw', inEsc: false }
  processKey(s, '\t')
  assert.equal(s.buf, 'pw')
})

console.log('校验：hidden 隐藏输入（无回显 + 退格 + 粘贴 + 回车 + 连续两次 + Ctrl+C）')

check('粘贴多字符 + 退格 + 回车，且不回显输入字符', async () => {
  const stdin = fakeStdin()
  const stdout = captureStdout()
  const p = hidden('密码：', { stdin, stdout })
  stdin.emit('data', 'Hello') // 粘贴
  stdin.emit('data', '\x7f') // 退格删掉 'o'
  stdin.emit('data', 'X\r') // 追加 X 并回车
  const val = await p
  assert.equal(val, 'HellX')
  assert.equal(stdin.isRaw, false) // 完成后复位 raw
  assert.equal(stdout.writes.join(''), '密码：\n') // 只有提示与换行，绝无输入字符
})

check('CRLF 回车提交', async () => {
  const stdin = fakeStdin()
  const stdout = captureStdout()
  const p = hidden('密码：', { stdin, stdout })
  stdin.emit('data', 'abc\r\n')
  assert.equal(await p, 'abc')
})

check('Ctrl+C 拒绝并复位', async () => {
  const stdin = fakeStdin()
  const stdout = captureStdout()
  const p = hidden('密码：', { stdin, stdout })
  stdin.emit('data', 'ab')
  stdin.emit('data', '\x03')
  await assert.rejects(p, (e) => e instanceof InterruptedError)
  assert.equal(stdin.isRaw, false)
})

check('连续两次隐藏输入互不干扰（每次独立监听与复位）', async () => {
  const stdin = fakeStdin()
  const stdout = captureStdout()
  const p1 = hidden('第一次：', { stdin, stdout })
  stdin.emit('data', 'pw123456\r')
  const v1 = await p1
  const p2 = hidden('第二次：', { stdin, stdout })
  stdin.emit('data', 'pw123456\r')
  const v2 = await p2
  assert.equal(v1, 'pw123456')
  assert.equal(v2, 'pw123456')
  assert.equal(stdin.isRaw, false)
})

console.log('校验：非交互终端拒绝')

check('非 TTY 明确拒绝（抛 NonInteractiveError）', () => {
  assert.throws(() => assertInteractive({ isTTY: false }, { isTTY: true }), NonInteractiveError)
  assert.throws(() => assertInteractive({ isTTY: true }, { isTTY: false }), NonInteractiveError)
})

async function run() {
  for (const [name, fn] of checks) {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  }
  console.log(`\n全部通过：${passed} 项校验`)
}

run().catch((e) => {
  console.error('校验失败：', e)
  process.exit(1)
})
