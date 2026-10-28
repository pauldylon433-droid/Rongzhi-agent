// 本地一次性强验证绑定命令（仅限用户在本地终端亲自运行，本轮只交付命令、不代为执行绑定）。
// 流程：隐藏输入并二次确认交易密码（≥8 位）→ 生成密码学安全随机 TOTP 密钥 →
//       生成临时二维码到系统临时目录（非 Vite/Express 静态托管目录）→ 用户扫码并输入验证码 →
//       验证通过才写入绑定 → 成功/取消/失败均清理二维码临时明文。
// 全程不打印 密钥 / otpauth URI / 密码 / 验证码；已绑定则拒绝覆盖，不提供快捷重置。
// 用法：cd backend && node scripts/bind-verification.js
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import QRCode from 'qrcode'
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { generateTotpSecret, verifyTotp, otpauthUri } from '../src/lib/totp.js'
import { getOrCreateVerificationKey } from '../src/lib/verification-key.js'
import { bindVerification, getVerificationStatus, VerificationError } from '../src/services/verification.js'

const CTRL_C = '\x03'
const BACKSPACES = new Set(['\x7f', '\b'])

export class NonInteractiveError extends Error {
  constructor() {
    super('本命令必须在交互式终端（TTY）中运行；检测到非交互环境已拒绝，避免密码明文回显。')
    this.code = 'NON_INTERACTIVE'
  }
}

export class InterruptedError extends Error {
  constructor() {
    super('已取消')
    this.code = 'INTERRUPTED'
  }
}

// 交互式 TTY 守卫：非交互终端直接拒绝，不降级为明文输入。
export function assertInteractive(stdin = process.stdin, stdout = process.stdout) {
  if (!stdin.isTTY || !stdout.isTTY) throw new NonInteractiveError()
}

// 纯按键状态机（就地修改 state）：处理退格、粘贴（多字符）、Ctrl+C、CR / LF / CRLF 回车、
// 以及 ANSI 方向键等控制序列（吞掉，不污染输入）。返回 { submit, interrupt } 动作标记；
// 普通可打印字符追加到 state.buf，是否回显由上层决定（本命令一律不回显）。
export function processKey(state, char) {
  if (state.inEsc) {
    const code = char.charCodeAt(0)
    if (state.inEsc === 'esc') {
      // ESC 后：'['（CSI）或 'O'（SS3）进入序列体；其他为单字符转义，直接吞掉结束
      state.inEsc = char === '[' || char === 'O' ? 'csi' : false
    } else if (code >= 0x40 && code <= 0x7e) {
      state.inEsc = false // CSI 终止字节（0x40–0x7E），之前的参数 / 中间字节被跳过
    }
    return { submit: false, interrupt: false }
  }
  if (char === '\x1b') {
    state.inEsc = 'esc'
    return { submit: false, interrupt: false }
  }
  if (char === CTRL_C) return { submit: false, interrupt: true }
  if (char === '\r' || char === '\n') return { submit: true, interrupt: false }
  if (BACKSPACES.has(char)) {
    state.buf = state.buf.slice(0, -1)
    return { submit: false, interrupt: false }
  }
  if (char < ' ') return { submit: false, interrupt: false } // 其他控制字符忽略
  state.buf += char
  return { submit: false, interrupt: false }
}

// 隐藏输入（不回显）：仅在 TTY 下运行；手动 raw mode 读取 data 事件，自行处理退格 / 回车 / Ctrl+C。
// 每次调用独立：完成 / 取消 / 异常都会复位 raw 并移除本次监听，两次隐藏输入之间重新监听、互不干扰。
export function hidden(prompt, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    assertInteractive(stdin, stdout)
    const state = { buf: '', inEsc: false }
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      stdin.removeListener('data', onData)
      try { stdin.setRawMode(false) } catch { /* 忽略 */ }
      stdin.pause()
    }

    const onData = (chunk) => {
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of text) {
        const r = processKey(state, ch)
        if (r.interrupt) {
          cleanup()
          stdout.write('\n')
          reject(new InterruptedError())
          return
        }
        if (r.submit) {
          cleanup()
          stdout.write('\n')
          resolve(state.buf)
          return
        }
      }
    }

    stdout.write(prompt)
    try {
      stdin.setEncoding('utf8')
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
    } catch (e) {
      cleanup()
      reject(e)
    }
  })
}

async function main() {
  let qrPath = null
  let exitCode = 0
  try {
    assertInteractive() // 顶层拒绝非交互终端（在触碰数据库之前）

    const { db } = initDatabase({ seed: false })
    const user = resolveDemoUser(db)

    const status = getVerificationStatus(db, user.id)
    if (status.bound) {
      console.log('已绑定验证器，拒绝覆盖。本阶段不提供快捷重置。')
      return
    }

    console.log('绑定强验证：交易密码 + 手机验证器（TOTP）')
    const pwd1 = await hidden('请输入交易密码（至少 8 位，不回显）：')
    if (pwd1.length < 8) {
      console.log('交易密码至少 8 位，绑定已取消。')
      return
    }
    const pwd2 = await hidden('请再次输入交易密码确认：')
    if (pwd1 !== pwd2) {
      console.log('两次输入不一致，绑定已取消。')
      return
    }

    const { base32, buffer } = generateTotpSecret()
    const encryptionKey = getOrCreateVerificationKey()
    const uri = otpauthUri({ secretBase32: base32, issuer: '融智 Agent', account: user.name })

    qrPath = join(tmpdir(), `rongzhi-verification-${Date.now()}.png`)
    await QRCode.toFile(qrPath, uri, { type: 'png', width: 360, margin: 2 })

    console.log(`已生成二维码图片：${qrPath}`)
    console.log('验证器名称「融智 Agent」，账户为演示账户。请用手机验证器扫描二维码（图片已尝试自动打开）。')
    try {
      if (process.platform === 'win32') {
        spawnSync('cmd', ['/c', 'start', '', qrPath], { stdio: 'ignore' })
      } else {
        spawnSync('open', [qrPath], { stdio: 'ignore' })
      }
    } catch {
      // 自动打开失败则让用户手动打开
    }

    const code = await hidden('请输入验证器显示的 6 位验证码：')
    const matchedStep = verifyTotp(buffer, code)
    if (matchedStep === null) {
      console.log('验证码校验失败，未写入绑定。请重新运行命令。')
      return
    }

    bindVerification(db, user.id, {
      password: pwd1,
      totpSecretBase32: base32,
      encryptionKey,
      matchedStep,
    })
    console.log('绑定成功。后续红色转账需「交易密码 + 验证器动态码」二次确认。')
  } catch (e) {
    if (e instanceof VerificationError) {
      console.log(`绑定失败：${e.message}`)
    } else if (e && e.code === 'INTERRUPTED') {
      console.log('已取消。')
      exitCode = 130
    } else if (e && e.code === 'NON_INTERACTIVE') {
      console.log(e.message)
      exitCode = 2
    } else {
      console.log(`绑定失败：${e && e.message ? e.message : e}`)
    }
  } finally {
    // 无论成功 / 取消 / 异常，恢复终端状态并清理临时二维码
    try { process.stdin.setRawMode(false) } catch { /* 忽略 */ }
    process.stdin.pause()
    if (qrPath && existsSync(qrPath)) {
      try { unlinkSync(qrPath) } catch { /* 忽略清理失败 */ }
    }
  }
  process.exitCode = exitCode
}

// 仅当被直接运行时执行绑定流程；被测试脚本 import 时不触发（避免导入即执行绑定）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
