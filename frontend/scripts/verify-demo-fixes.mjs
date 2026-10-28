// 演示问题定向前端回归（纯逻辑，不启动服务、不调用模型）：
// 1) 首页借记账户余额合计，信用卡额度 / 欠款不计入；
// 2) 未完成提示不重复；
// 3) 换卡改单时旧单取消与新单编号区分。
// 用法：node scripts/verify-demo-fixes.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { summarizeOverviewBalance } from '../src/utils/accountBalance.js'
import { hasIncompleteNotice } from '../src/utils/chatNotice.js'
import { previousTransferNotice, shortRef } from '../src/utils/transferDisplay.js'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const accounts = [
  { id: 1, account_name: '日常活期账户', account_type: 'deposit', balance_cents: 1000000, currency: 'CNY' },
  { id: 2, account_name: '储蓄活期账户', account_type: 'deposit', balance_cents: 250000, currency: 'CNY' },
  { id: 3, account_name: '信用卡', account_type: 'credit', balance_cents: -30000, currency: 'CNY' },
]

// —— 1. 首页余额 ——
{
  const total = summarizeOverviewBalance(accounts)
  check('1.1 未筛选时为全部借记账户合计', total.mode === 'total' && total.totalCents === 1250000,
    JSON.stringify(total))
  check('1.2 标注为“借记账户余额合计”', total.label === '借记账户余额合计', total.label)
  check('1.3 信用卡额度 / 欠款不计入', total.totalCents === 1250000 && total.count === 2, String(total.totalCents))

  const one = summarizeOverviewBalance(accounts, 2)
  check('1.4 选中借记账户时显示该账户余额', one.mode === 'account' && one.totalCents === 250000
    && one.label === '账户余额', JSON.stringify(one))

  const credit = summarizeOverviewBalance(accounts, 3)
  check('1.5 选中信用卡时仍显示借记合计，并说明信用卡不计入',
    credit.mode === 'total' && credit.totalCents === 1250000
      && credit.subText.includes('信用卡额度与欠款不计入'), credit.subText)

  const onlyCredit = summarizeOverviewBalance([accounts[2]])
  check('1.6 没有借记账户时显示暂无，不拿信用卡顶替',
    onlyCredit.mode === 'empty' && onlyCredit.totalCents === null, JSON.stringify(onlyCredit))

  const mixed = summarizeOverviewBalance([
    { id: 1, account_type: 'deposit', balance_cents: 100, currency: 'CNY' },
    { id: 2, account_type: 'deposit', balance_cents: 200, currency: 'USD' },
  ])
  check('1.7 多币种不直接相加', mixed.mode === 'mixed' && mixed.totalCents === null, JSON.stringify(mixed))

  const bad = summarizeOverviewBalance([
    { id: 1, account_type: 'deposit', balance_cents: 100, currency: 'CNY' },
    { id: 2, account_type: 'deposit', balance_cents: '200', currency: 'CNY' },
  ])
  check('1.8 非法金额按 0 处理，不产生 NaN', bad.totalCents === 100, String(bad.totalCents))

  check('1.9 空列表不报错', summarizeOverviewBalance([]).mode === 'empty')
  check('1.10 非数组不报错', summarizeOverviewBalance(null).mode === 'empty')
}

// —— 2. 未完成提示去重 ——
{
  check('2.1 服务端“本轮回答未完成”不重复追加', hasIncompleteNotice('（本轮回答未完成，请稍后重试）'))
  check('2.2 服务端“已达到本轮模型调用上限”不重复追加', hasIncompleteNotice('（已达到本轮模型调用上限，回答未完成，请稍后重试）'))
  check('2.3 普通回答不误判', !hasIncompleteNotice('本月支出 300.00 元。'))
  check('2.4 空值安全', !hasIncompleteNotice(null))
}

// —— 3. 换卡改单文案 ——
{
  const data = {
    ref_no: 'c2e2a206-1111-2222-3333-444455556666',
    previous: { ref_no: 'dc1f08db-aaaa-bbbb-cccc-ddddeeeeffff', status: 'cancelled' },
  }
  const notice = previousTransferNotice(data)
  check('3.1 同时标明旧单已取消与新单编号',
    notice.includes('dc1f08db') && notice.includes('c2e2a206')
      && notice.includes('已取消，未扣款') && notice.includes('新的转账单'), notice)
  check('3.2 旧单已完成时不得写成“已取消”',
    previousTransferNotice({ ...data, previous: { ref_no: 'dc1f08db', status: 'completed' } }).includes('已完成，未取消'))
  check('3.3 无旧单时不显示换单说明', previousTransferNotice({ ref_no: 'abc' }) === '')
  check('3.4 短编号不截断来源', shortRef('short') === 'short' && shortRef('123456789012').endsWith('…'))
}

// —— 4. 页面确实接入上述逻辑 ——
{
  const overview = readFileSync(join(here, '../src/views/OverviewView.vue'), 'utf8')
  check('4.1 首页使用合计函数并渲染服务端字段',
    overview.includes('summarizeOverviewBalance') && overview.includes('balanceSummary.label')
      && overview.includes('balanceSummary.totalCents'))
  const chat = readFileSync(join(here, '../src/components/ChatPanel.vue'), 'utf8')
  check('4.2 聊天面板接入去重与换单说明',
    chat.includes('hasIncompleteNotice') && chat.includes('previousTransferNotice'))
}

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
