// 定向验证：银行卡余额兼容解析 + 金额格式化。
//
// 两部分：
//  1) 纯逻辑（默认总是执行，不依赖任何运行中的服务）；
//  2) 可选 HTTP 集成检查：仅当显式指定 `--base <url>` 或环境变量 VERIFY_BASE_URL 时执行；
//     未指定时明确显示「未执行」；指定后连接失败必须 FAIL（不吞掉失败）。
// 不做任何写操作、不调用模型。
//
// 用法：
//   node scripts/verify-card-balance.mjs                     # 只跑纯逻辑
//   node scripts/verify-card-balance.mjs --base http://localhost:3000
import { pathToFileURL } from 'node:url'
import { formatCentsToYuan } from '../src/utils/format.js'
import {
  accountsIndex, isActivePayerCard, isDepositCard, isFiniteCents, resolveAccountName, resolveDebitBalance,
} from '../src/utils/cardBalance.js'

// —— 可复用的 HTTP 集成检查（供本脚本与独立临时服务测试共用）——
// 连接失败会抛出异常，由调用方明确记为 FAIL。
export async function checkHttpIntegration(base, check) {
  const [cardsRes, accRes] = await Promise.all([
    fetch(`${base}/api/cards`).then((r) => r.json()),
    fetch(`${base}/api/accounts`).then((r) => r.json()),
  ])
  const cards = cardsRes.data || []
  const accounts = accRes.data || []
  const idx = accountsIndex(accounts)
  check(`HTTP ${base}：接口可读`, cardsRes.success === true && accRes.success === true)

  const deposits = cards.filter((c) => isDepositCard(c))
  check(`HTTP ${base}：存在借记卡`, deposits.length >= 1, String(deposits.length))
  for (const c of deposits) {
    const r = resolveDebitBalance(c, idx)
    const acc = idx.get(c.account_id)
    check(
      `HTTP ${base}：${c.masked_card_number} 结余与关联账户一致`,
      r.available && !!acc && r.cents === acc.balance_cents,
      r.available ? String(r.cents) : 'unavailable',
    )
    check(`HTTP ${base}：${c.masked_card_number} 账户名可解析`, resolveAccountName(c, idx) !== '')
  }

  const credits = cards.filter((c) => c.account_type === 'credit')
  for (const c of credits) {
    check(`HTTP ${base}：信用卡 ${c.masked_card_number} 不可作付款账户`, isActivePayerCard(c, idx) === false)
  }

  // 旧接口（无 balance_cents）与新接口（含余额字段）都能被正确解析
  const contract = deposits.every((c) => isFiniteCents(c.balance_cents)) ? 'new' : 'legacy'
  check(`HTTP ${base}：接口契约可识别`, true, contract)
  return { cards, accounts, contract }
}

function runPureChecks(check) {
  console.log('—— 金额格式化 ——')
  check('合法 0 → 0.00（不是不可用）', formatCentsToYuan(0) === '0.00', formatCentsToYuan(0))
  check('合法金额 → 两位小数', formatCentsToYuan(4046338) === '40,463.38', formatCentsToYuan(4046338))
  check('null → 不可用占位', formatCentsToYuan(null) === '—')
  check('undefined → 不可用占位', formatCentsToYuan(undefined) === '—')
  check('NaN → 不可用占位', formatCentsToYuan(NaN) === '—')
  check('Infinity → 不可用占位', formatCentsToYuan(Infinity) === '—')
  check('字符串数字不被当作金额', formatCentsToYuan('1234') === '—')

  console.log('—— 余额解析（纯函数）——')
  const acc1 = { id: 1, account_name: '人民币活期账户', balance_cents: 4046338, status: 'active' }
  const acc2 = { id: 2, account_name: '工资储蓄账户', balance_cents: 500000, status: 'active' }
  const zeroAcc = { id: 3, account_name: '零余额账户', balance_cents: 0, status: 'active' }
  const idx = accountsIndex([acc1, acc2, zeroAcc])
  check('accountsIndex 按 id 建索引', idx.size === 3 && idx.get(2) === acc2)

  const oldCard = { id: 10, account_id: 1, masked_card_number: '6222 **** **** 1234', card_type: '借记卡', status: 'active', daily_limit_cents: 5000000 }
  const r1 = resolveDebitBalance(oldCard, idx)
  check('旧接口卡片（无 balance_cents）→ 关联账户余额', r1.available && r1.cents === 4046338, JSON.stringify(r1))
  check('旧接口卡片余额 ≠ 首个账户的错误映射（按 account_id）', resolveDebitBalance({ ...oldCard, account_id: 2 }, idx).cents === 500000)

  const newCard = { ...oldCard, account_id: 1, account_type: 'deposit', balance_cents: 4203730 }
  check('新接口卡片 → 使用卡片明确字段', resolveDebitBalance(newCard, idx).cents === 4203730)

  check('合法零余额 → 0（可用）', (() => { const r = resolveDebitBalance({ ...oldCard, account_id: 3 }, idx); return r.available && r.cents === 0 })())
  for (const bad of [null, undefined, NaN, Infinity, 'x']) {
    const r = resolveDebitBalance({ ...oldCard, balance_cents: bad }, new Map())
    check(`非法余额（${String(bad)}）且无法关联 → 不可用`, r.available === false && r.cents === null)
  }
  check('非法余额但可关联账户 → 回退账户余额', resolveDebitBalance({ ...oldCard, balance_cents: NaN }, idx).cents === 4046338)
  check('account_id 不存在 → 不可用（不取第一个账户）', resolveDebitBalance({ ...oldCard, account_id: 999 }, idx).available === false)

  console.log('—— 账户名 / 付款资格 ——')
  check('旧接口账户名回退到关联账户', resolveAccountName(oldCard, idx) === '人民币活期账户')
  check('新接口优先使用卡片字段', resolveAccountName({ ...newCard, account_name: '卡片字段名' }, idx) === '卡片字段名')
  check('关联失败 → 空串（界面显示暂无法获取）', resolveAccountName({ ...oldCard, account_id: 999 }, idx) === '')

  check('旧接口借记卡可作付款账户（卡片 active + 关联账户 active）', isActivePayerCard(oldCard, idx) === true)
  check('信用卡不可作付款账户', isActivePayerCard({ ...newCard, account_type: 'credit' }, idx) === false)
  check('卡片冻结不可作付款账户', isActivePayerCard({ ...oldCard, status: 'frozen' }, idx) === false)
  check('未找到关联账户 → 不可作付款账户', isActivePayerCard({ ...oldCard, account_id: 999 }, idx) === false)
  check('旧接口 card_type=借记卡 视为借记（不猜账户类型）', isDepositCard(oldCard) === true && isDepositCard({ ...oldCard, card_type: '信用卡' }) === false)
}

async function main() {
  let failures = 0
  const check = (name, cond, detail = '') => {
    const ok = Boolean(cond)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
    if (!ok) failures += 1
  }
  runPureChecks(check)

  // —— 可选 HTTP 集成：显式指定才执行；未指定明确显示「未执行」——
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--base')
  const base = (i >= 0 ? argv[i + 1] : undefined) || process.env.VERIFY_BASE_URL || null
  if (!base) {
    console.log('\nHTTP 集成检查：未执行（未指定 --base <url> 或 VERIFY_BASE_URL；纯逻辑检查已完成）')
  } else {
    try {
      await checkHttpIntegration(base, check)
    } catch (e) {
      check(`HTTP 集成：连接 ${base} 失败`, false, e && e.message)
    }
  }

  console.log(failures === 0 ? '\n银行卡余额兼容验证通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
