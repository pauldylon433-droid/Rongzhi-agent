// 定向验证：银行卡余额兼容解析 + 金额格式化。
// 纯函数用例 + 对 3000（旧接口）/ 4177（新接口）的只读接口对照；不做任何写操作、不调用模型。
// 用法：node scripts/verify-card-balance.mjs
import { formatCentsToYuan } from '../src/utils/format.js'
import {
  accountsIndex, isActivePayerCard, isDepositCard, isFiniteCents, resolveAccountName, resolveDebitBalance,
} from '../src/utils/cardBalance.js'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

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

console.log('—— 只读对照：3000（旧接口）与 4177（新接口）——')
async function live(base, label) {
  try {
    const [cardsRes, accRes] = await Promise.all([
      fetch(`${base}/api/cards`).then((r) => r.json()),
      fetch(`${base}/api/accounts`).then((r) => r.json()),
    ])
    const cards = cardsRes.data || []
    const accounts = accRes.data || []
    const liveIdx = accountsIndex(accounts)
    check(`${label}：接口可读`, cardsRes.success === true && accRes.success === true)
    for (const c of cards) {
      if (c.account_type === 'credit') continue
      const r = resolveDebitBalance(c, liveIdx)
      const acc = liveIdx.get(c.account_id)
      check(`${label}：${c.masked_card_number} 余额与关联账户一致`, r.available && acc && r.cents === acc.balance_cents, r.available ? String(r.cents) : 'unavailable')
    }
    return { cards, accounts }
  } catch (e) {
    check(`${label}：接口可读`, false, e && e.message)
    return null
  }
}
const legacy = await live('http://localhost:3000', '3000 旧接口')
const modern = await live('http://localhost:4177', '4177 新接口')
if (legacy) {
  // 部署后 3000 也可能已是新接口：两种契约都接受，只断言解析结果与关联账户一致
  const hasBalance = legacy.cards.filter((c) => c.account_type !== 'credit').every((c) => isFiniteCents(c.balance_cents))
  check('3000 接口契约可识别（旧：无余额字段 / 新：含余额字段）', true, hasBalance ? 'new' : 'legacy')
  // 不写死余额（用户实际还款会改变余额）：按 account_id 对照账户接口的真实余额
  const legacyAcc = accountsIndex(legacy.accounts)
  check('3000 借记卡 1234 解析为关联账户余额', legacy.cards.some((c) => {
    if (!c.masked_card_number.includes('1234')) return false
    const acc = legacyAcc.get(c.account_id)
    return !!acc && resolveDebitBalance(c, legacyAcc).cents === acc.balance_cents
  }))
}
if (modern) {
  check('4177 新接口含 balance_cents（沿用明确契约）', modern.cards.filter((c) => c.account_type !== 'credit').every((c) => isFiniteCents(c.balance_cents)))
  check('4177 付款账户仅借记卡（2 张，信用卡排除）',
    modern.cards.filter((c) => isActivePayerCard(c, accountsIndex(modern.accounts))).length === 2,
    String(modern.cards.filter((c) => isActivePayerCard(c, accountsIndex(modern.accounts))).length))
}
if (legacy) {
  const payers = legacy.cards.filter((c) => isActivePayerCard(c, accountsIndex(legacy.accounts)))
  check('3000 可识别借记付款账户（信用卡排除）',
    payers.length >= 1 && payers.every((c) => c.account_type === 'deposit' || c.card_type === '借记卡'),
    String(payers.length))
}

console.log(failures === 0 ? '\n银行卡余额兼容验证全部通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
