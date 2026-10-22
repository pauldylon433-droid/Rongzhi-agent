// AI 助手·转账真实模型冒烟测试：最多 3 条用户消息，验证真实 DeepSeek 的转账工具选择与澄清。
//
// 使用独立临时数据库（初始化种子数据），不修改开发数据库，不在开发库自动确认转账，不调用运行中的服务。
// 核心不变量：助手只能生成待确认转账单，绝不扣款——余额不变、无已完成转账单、无转账流水。
// 不输出密钥。用法：node scripts/smoke-assistant-transfer-live.js
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createAssistant } from '../src/services/assistant.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(tmpdir(), 'rongzhi-assistant-transfer-live.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: true })
const demo = resolveDemoUser(db)

function balance() {
  return db.prepare('SELECT balance_cents AS b FROM accounts WHERE user_id = ?').get(demo.id).b
}
function completedCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM transfer_operations WHERE user_id = ? AND status = 'completed'").get(demo.id).c
}
function transferTxCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE transfer_ref IS NOT NULL').get().c
}

const beforeBal = balance()
const beforeCompleted = completedCount()
const beforeTx = transferTxCount()

const assistant = createAssistant({ db, demoUserId: demo.id })

const questions = [
  '给李雷转100元，备注还饭钱',
  '刚才那笔改成给韩梅梅转50元',
  '帮我查一下最后那笔转账的状态',
]

let sessionId = null
let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
let failures = 0
let sawSearch = false
let sawPrepare = false
let sawStatus = false

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

for (const q of questions) {
  console.log(`\n===== 用户消息：${q} =====`)
  const r = await assistant.chat({ message: q, sessionId })
  sessionId = r.sessionId
  if (r.usage) {
    totalUsage.prompt_tokens += r.usage.prompt_tokens || 0
    totalUsage.completion_tokens += r.usage.completion_tokens || 0
    totalUsage.total_tokens += r.usage.total_tokens || 0
  }
  console.log(`回复：${r.reply || '（无）'}`)

  for (const rec of r.toolRecords) {
    if (rec.status !== 'ok' || rec.data == null) {
      console.log(`  工具：${rec.name || '(未知)'} 失败（${rec.error}）`)
      continue
    }
    console.log(`  工具：${rec.name} 成功（${rec.args ? JSON.stringify(rec.args) : '无参数'}）`)
    if (rec.name === 'search_transfer_recipients') {
      sawSearch = true
      console.log(`    匹配收款人：${JSON.stringify(rec.data)}`)
    } else if (rec.name === 'prepare_transfer') {
      sawPrepare = true
      const d = rec.data
      console.log(`    草稿：ref=${d.ref_no} 金额=${d.amount_cents}分 状态=${d.status} 风险=${d.risk_level} 收款人=${d.recipient_name}`)
      check(`草稿结构合法（${d.ref_no}）`, typeof d.ref_no === 'string' && Number.isSafeInteger(d.amount_cents) && ['pending', 'needs_verification'].includes(d.status))
    } else if (rec.name === 'get_transfer_status') {
      sawStatus = true
      console.log(`    状态：${rec.data.status}（ref=${rec.data.ref_no}）`)
    }
  }
}

const afterBal = balance()
const afterCompleted = completedCount()
const afterTx = transferTxCount()

console.log('\n===== 核心不变量（助手绝不扣款） =====')
check('余额全程不变（未扣款）', afterBal === beforeBal, `${beforeBal}->${afterBal}`)
check('无已完成转账单（未执行）', afterCompleted === beforeCompleted, `${beforeCompleted}->${afterCompleted}`)
check('无转账流水产生', afterTx === beforeTx, `${beforeTx}->${afterTx}`)

console.log('\n===== 工具调用覆盖 =====')
console.log(`search_transfer_recipients 被调用：${sawSearch ? '是' : '否'}`)
console.log(`prepare_transfer 被调用：${sawPrepare ? '是' : '否'}`)
console.log(`get_transfer_status 被调用：${sawStatus ? '是' : '否'}`)
check('真实模型调用了 prepare_transfer', sawPrepare)

console.log('\n===== 用量汇总（3 条用户消息） =====')
console.log(`prompt_tokens=${totalUsage.prompt_tokens} completion_tokens=${totalUsage.completion_tokens} total_tokens=${totalUsage.total_tokens}`)

db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

console.log(failures === 0 ? '\n真实模型转账冒烟测试通过 ✅' : `\n存在 ${failures} 项不一致 ❌`)
process.exit(failures === 0 ? 0 : 1)
