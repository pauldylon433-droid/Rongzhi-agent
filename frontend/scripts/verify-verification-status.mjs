// Render the actual four Vue confirmation cards against local fetch fixtures.
// No real server, credentials, model calls or business writes are used.
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { parse, compileScript } from '@vue/compiler-sfc'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'CustomEvent']) {
  globalThis[name] = dom.window[name]
}
const { createApp, nextTick } = await import('vue')
const originalFetch = globalThis.fetch
const settle = async () => {
  for (let i = 0; i < 12; i++) { await new Promise((r) => setImmediate(r)); await nextTick() }
}
let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++; console.log(`PASS ${label}`) }

try {
  for (const name of ['Transfer', 'CardOperation', 'SubscriptionOperation', 'Repayment']) {
    const source = new URL(`../src/components/${name}ConfirmCard.vue`, import.meta.url)
    const compiled = new URL(`../src/components/.verify-status-${process.pid}-${name}.mjs`, import.meta.url)
    const { descriptor } = parse(await readFile(source, 'utf8'))
    await writeFile(compiled, compileScript(descriptor, { id: `test-${name}`, inlineTemplate: true }).content)
    try {
      const component = (await import(compiled.href)).default
      for (const scenario of ['failed-after-credentials', 'unbound', 'locked', 'invalid-response']) {
        let current = { bound: true, locked: false, remaining_attempts: 5 }
        if (scenario === 'unbound') current.bound = false
        if (scenario === 'locked') Object.assign(current, { locked: true, locked_until: '2099-01-01T00:00:00Z' })
        if (scenario === 'invalid-response') current = {}
        const requests = []
        const op = { ref_no: `test-${name}`, status: 'needs_verification', risk_level: 'red', action: 'change_source', amount_cents: 1500 }
        globalThis.fetch = async (path, options = {}) => {
          const method = options.method || 'GET'
          requests.push({ path, method })
          if (method === 'POST') {
            assert.ok(String(path).endsWith('/verify'), 'only fixture verification may be submitted')
            current = null
            return new Response(JSON.stringify({ success: false, code: 'bad_credentials', message: '交易密码或动态验证码不正确，请核对后重试（还可尝试 4 次）' }), { status: 401 })
          }
          if (path === '/api/verification/status') {
            if (current === null) return new Response('unavailable', { status: 503 })
            return new Response(JSON.stringify({ success: true, data: current }))
          }
          return new Response(JSON.stringify({ success: true, data: op }))
        }
        const host = document.createElement('div')
        document.body.append(host)
        const app = createApp(component, { op })
        try {
          app.mount(host)
          await settle()
          const label = `${name}/${scenario}`
          if (scenario === 'failed-after-credentials') {
            check(`${label}: initial bound status permits form`, host.querySelectorAll('input').length === 2)
            const inputs = host.querySelectorAll('input')
            for (let i = 0; i < inputs.length; i++) {
              inputs[i].value = i === 0 ? 'fake-test-password' : '000000'
              inputs[i].dispatchEvent(new Event('input', { bubbles: true }))
            }
            await nextTick()
            host.querySelector('.verify-section button.btn').click()
            await settle()
            check(`${label}: credential error remains uniform`, host.textContent.includes('交易密码或动态验证码不正确'))
          }
          if (scenario === 'failed-after-credentials' || scenario === 'invalid-response') {
            check(`${label}: read failure does not claim unbound`, host.textContent.includes('验证器状态读取失败') && !host.textContent.includes('尚未绑定验证器，无法执行'))
            check(`${label}: unknown status blocks credential form`, host.querySelectorAll('input').length === 0)
            const before = requests.length
            current = { bound: true, locked: false, remaining_attempts: 4 }
            const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === '重新查询状态')
            assert.ok(retry)
            retry.click()
            await settle()
            check(`${label}: retry only reads status`, requests.length === before + 1 && requests[before].path === '/api/verification/status' && requests[before].method === 'GET')
            check(`${label}: recovery restores empty inputs`, host.querySelectorAll('input').length === 2 && [...host.querySelectorAll('input')].every((i) => i.value === ''))
          } else if (scenario === 'unbound') {
            check(`${label}: explicit unbound is accurately shown`, host.textContent.includes('尚未绑定验证器，无法执行') && host.querySelectorAll('input').length === 0)
          } else {
            check(`${label}: locked stays blocked`, host.textContent.includes('强验证已锁定') && host.querySelectorAll('input').length === 0)
          }
        } finally { app.unmount(); host.remove() }
      }
    } finally { await unlink(compiled) }
  }
  console.log(`Verification status rendering: ${passed} PASS`)
} finally {
  globalThis.fetch = originalFetch
  dom.window.close()
}
