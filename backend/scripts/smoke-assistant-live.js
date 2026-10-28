// AI 助手真实模型冒烟测试：最多 3 条用户问题，验证真实 DeepSeek 工具调用与数据库结果一致。
//
// 使用独立临时数据库（初始化种子数据），不修改开发数据库，不依赖运行中的服务。
// 结果中的余额/统计与直接调用查询服务得到的结果比对，确保「银行数据来自本次实际查询」。
// 不输出密钥。用法：node scripts/smoke-assistant-live.js
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { listAccounts } from '../src/services/accounts.js'
import { monthlyAnalytics } from '../src/services/analytics.js'
import { createAssistant } from '../src/services/assistant.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-assistant-live.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: true })
const demo = resolveDemoUser(db)

// 直接查询服务的预期结果（权威）
const expectedAccounts = listAccounts(db, demo.id)
const asOf = new Date().toISOString()
const expectedByMonth = {
  '2026-10': monthlyAnalytics(db, demo.id, { year: 2026, month: 10, asOf }),
  '2026-09': monthlyAnalytics(db, demo.id, { year: 2026, month: 9, asOf }),
}

function analyticsEqual(a, b) {
  return a.month === b.month
    && a.income_cents === b.income_cents
    && a.expense_cents === b.expense_cents
    && a.net_cents === b.net_cents
    && a.posted_count === b.posted_count
    && a.pending.count === b.pending.count
    && a.pending.amount_cents === b.pending.amount_cents
    && JSON.stringify(a.expense_by_category) === JSON.stringify(b.expense_by_category)
}

const assistant = createAssistant({ db, demoUserId: demo.id })

const questions = [
  '我的账户余额是多少？',
  '这个月支出最多的是哪一类？',
  '上个月呢？',
]

let sessionId = null
let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
let failures = 0
let checkedAccounts = false
let checkedOct = false
let checkedSep = false

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

for (const q of questions) {
  console.log(`\n===== 用户问题：${q} =====`)
  const r = await assistant.chat({ message: q, sessionId })
  sessionId = r.sessionId
  if (r.usage) {
    totalUsage.prompt_tokens += r.usage.prompt_tokens || 0
    totalUsage.completion_tokens += r.usage.completion_tokens || 0
    totalUsage.total_tokens += r.usage.total_tokens || 0
  }
  console.log(`回复：${r.reply}`)

  for (const rec of r.toolRecords) {
    if (rec.status !== 'ok' || rec.data == null) {
      console.log(`  工具：${rec.name || '(未知)'} 失败（${rec.error}）`)
      check(`工具 ${rec.name} 执行失败（无伪造数据）`, rec.data === undefined)
      continue
    }
    console.log(`  工具：${rec.name} 成功（${rec.args ? JSON.stringify(rec.args) : '无参数'}）`)
    if (rec.name === 'get_accounts') {
      checkedAccounts = true
      check('余额工具结果与账户服务一致', JSON.stringify(rec.data) === JSON.stringify(expectedAccounts), `balance=${rec.data[0]?.balance_cents}`)
    } else if (rec.name === 'get_monthly_analytics') {
      const month = rec.data.month
      const exp = expectedByMonth[month]
      if (month === '2026-10') checkedOct = true
      if (month === '2026-09') checkedSep = true
      if (exp) {
        check(`月度统计（${month}）与统计服务一致`, analyticsEqual(rec.data, exp), `收入=${rec.data.income_cents} 支出=${rec.data.expense_cents} 净=${rec.data.net_cents}`)
      } else {
        check(`月度统计（${month}）在预期范围`, false, month)
      }
    }
  }
}

console.log('\n===== 工具调用覆盖 =====')
check('真实模型调用了 get_accounts', checkedAccounts)
check('真实模型调用了 get_monthly_analytics(2026-10)', checkedOct)
check('真实模型在追问中调用了 get_monthly_analytics(2026-09)', checkedSep)

console.log('\n===== 用量汇总（3 条用户问题） =====')
console.log(`prompt_tokens=${totalUsage.prompt_tokens} completion_tokens=${totalUsage.completion_tokens} total_tokens=${totalUsage.total_tokens}`)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n真实模型冒烟测试通过 ✅' : `\n存在 ${failures} 项不一致 ❌`)
process.exit(failures === 0 ? 0 : 1)
