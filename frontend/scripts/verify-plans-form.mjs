// 计划页面表单回归（JSDOM + 真实 Vue SFC，经项目 Vite 编译）。
// 覆盖：已保存参数恢复、失效选择不静默换成第一项、指定账单只列已出账账单、无可选账单空态。
// 这是组件 DOM 实测，不是 Chromium / 手机实机或视觉验收。
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const work = mkdtempSync(join(ROOT, '.plans-form-test-'))
let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

try {
  const entry = join(work, 'entry.mjs')
  const vuePath = join(ROOT, 'src', 'views', 'PlansView.vue').replace(/\\/g, '/')
  writeFileSync(entry, `import { createApp } from 'vue'\nimport PlansView from '${vuePath}'\nexport { createApp, PlansView }\n`)
  await build({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.js'),
    logLevel: 'silent',
    build: {
      lib: { entry, formats: ['es'], fileName: () => 'plans-dom-bundle.mjs' },
      outDir: join(work, 'dist'), emptyOutDir: true, minify: false,
    },
  })

  const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1' })
  for (const k of ['Document', 'ShadowRoot', 'document', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver']) {
    globalThis[k] = window[k]
  }
  globalThis.window = window
  globalThis.localStorage = window.localStorage
  let fixture
  globalThis.fetch = async (path) => ({
    ok: true, status: 200,
    json: async () => ({ success: true, data: path.includes('/api/workflows?') ? [fixture] : fixture }),
  })
  const { createApp, PlansView } = await import(pathToFileURL(join(work, 'dist', 'plans-dom-bundle.mjs')).href)
  async function mount(p) {
    fixture = p
    const el = document.createElement('div')
    document.body.append(el)
    const app = createApp(PlansView)
    app.mount(el)
    await new Promise((r) => setTimeout(r, 60))
    return { el, app }
  }
  const fields = (el) => [...el.querySelectorAll('.plans-panel .plans-form label')].map((l) => ({
    label: l.textContent.trim().replace(/\s+/g, ' '),
    value: l.querySelector('select')?.value ?? null,
    options: [...l.querySelectorAll('option')].map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })),
  }))
  const field = (el, prefix) => fields(el).find((f) => f.label.startsWith(prefix))
  const common = {
    plan_no: 'wf-dom-test', status: 'waiting_selection', nodes: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    selectable_deposit_accounts: [{ id: 1, account_name: '账户A' }, { id: 2, account_name: '账户B' }],
    selectable_subscriptions: [{ id: 1, merchant: '会员', amount_cents: 1500, billing_cycle: 'monthly' }],
    selectable_credit_accounts: [],
  }

  {
    const p = { ...common, flow: 'subscription_review', params: { month: '2026-10', action: 'change_source', to_account_id: 2, subscription_id: 1 } }
    const { el, app } = await mount(p)
    check('已保存 action / 新扣款账户 / 订阅被恢复',
      field(el, '操作')?.value === 'change_source' && field(el, '新扣款账户')?.value === '2' && field(el, '订阅')?.value === '1',
      JSON.stringify(fields(el)))
    app.unmount(); el.remove()
  }
  {
    const p = {
      ...common, flow: 'repayment_review', params: { scope: 'all_posted', from_account_id: 2, credit_account_id: 1 },
      selectable_credit_accounts: [{ id: 1, account_name: '信用卡', statements: [] }],
    }
    const { el, app } = await mount(p)
    check('已保存还款范围 / 付款账户被恢复',
      field(el, '还款范围')?.value === 'all_posted' && field(el, '付款账户')?.value === '2' && !field(el, '账单'),
      JSON.stringify(fields(el)))
    app.unmount(); el.remove()
  }
  {
    const issued = { id: 1, statement_month: '2026-09', remaining_due_cents: 50000, issued: true, status: 'open' }
    const unissued = { id: 2, statement_month: '2026-10', remaining_due_cents: 30000, issued: false, status: 'unissued' }
    const p = {
      ...common, flow: 'repayment_review', params: { scope: 'statement', statement_id: 2, from_account_id: 2, credit_account_id: 1 },
      selectable_credit_accounts: [{ id: 1, account_name: '信用卡', statements: [issued, unissued] }],
    }
    const { el, app } = await mount(p)
    const statement = field(el, '账单')
    const submit = [...el.querySelectorAll('.plans-form-actions button')].find((b) => b.textContent.includes('选择并生成操作单'))
    check('指定账单只列已出账账单（未出账不在选项内）',
      !(statement?.options || []).some((o) => o.value === '2') && !(statement?.options || []).some((o) => o.text.includes('2026-10')))
    check('失效的已保存账单不静默换成第一项，并要求重选', !statement?.value && !!submit?.disabled,
      JSON.stringify({ selected: statement?.value, disabled: submit?.disabled }))
    app.unmount(); el.remove()
  }
  {
    const unissued = { id: 2, statement_month: '2026-10', remaining_due_cents: 30000, issued: false, status: 'unissued' }
    const p = {
      ...common, flow: 'repayment_review', params: { scope: 'statement', statement_id: 2, from_account_id: 2, credit_account_id: 1 },
      selectable_credit_accounts: [{ id: 1, account_name: '信用卡', statements: [unissued] }],
    }
    const { el, app } = await mount(p)
    const statement = field(el, '账单')
    const submit = [...el.querySelectorAll('.plans-form-actions button')].find((b) => b.textContent.includes('选择并生成操作单'))
    check('无可选已出账账单时显示空态并禁止提交',
      (statement?.options || []).length === 1 && (statement?.options || [])[0]?.disabled === true && !!submit?.disabled,
      JSON.stringify({ options: statement?.options, disabled: submit?.disabled }))
    app.unmount(); el.remove()
  }
  window.close()
} catch (e) {
  failures += 1
  console.error('PLANS FORM TEST ERROR:', e.stack || e.message)
} finally {
  rmSync(work, { recursive: true, force: true })
  console.log(`\n== 计划页面表单验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
