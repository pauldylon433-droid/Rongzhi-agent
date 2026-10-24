// 收款人「列举」只读工具 验证脚本：在独立临时数据库上运行，不触碰开发数据库，不调用收费模型。
// 覆盖：正常列表 / 空列表如实返回 / 仅返回最小脱敏字段（id、姓名、掩码账户，不含完整账号）/
//       不接受模型注入 user_id 等额外参数 / 列举不产生任何业务变更（不建转账单、不改收款人、不动资金）/
//       原 search_transfer_recipients 无回归。
// 用法：node scripts/verify-list-recipients.js [临时数据库路径]
import { initDatabase } from '../src/db/index.js'
import { resolveDemoUser } from '../src/demo-user.js'
import { createAssistant } from '../src/services/assistant.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.argv[2] || join(tmpdir(), 'rongzhi-verify-list-recipients.db')
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { rmSync(p, { force: true }) } catch {}
}

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks += 1
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

const { db } = initDatabase({ dbPath: DB_PATH, seed: true })
const userId = resolveDemoUser(db).id

function count(table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
}

function makeScriptedMock(script) {
  let i = 0
  const fn = async () => {
    const step = i < script.length ? script[i] : { content: '（脚本耗尽）' }
    i += 1
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
  fn.calls = i
  return fn
}
function tc(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

const RECIPIENT_KEYS = ['id', 'masked_account', 'name'].sort().join(',')

// —— 1. 正常列表 + 最小脱敏字段 + 不产生业务变更 ——
console.log('—— 1. 正常列表：最小脱敏字段，不产生业务变更 ——')
{
  const before = { ops: count('transfer_operations'), tx: count('transactions'), audit: count('audit_logs'), rc: count('transfer_recipients') }
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'list_transfer_recipients', {})] },
      { content: '这是你的常用收款人列表。' },
    ]),
  })
  const r = await assistant.chat({ message: '我的收款人有哪些' })
  const rec = r.toolRecords.find((x) => x.name === 'list_transfer_recipients')
  check('1.1 工具调用成功', !!rec && rec.status === 'ok')
  const data = rec && rec.data
  check('1.2 返回全部收款人（4 条）', Array.isArray(data) && data.length === 4, `${Array.isArray(data) ? data.length : '非数组'}`)
  check('1.3 每条仅含 id / 姓名 / 掩码账户（无完整账号等敏感字段）',
    Array.isArray(data) && data.every((d) => Object.keys(d).sort().join(',') === RECIPIENT_KEYS),
    Array.isArray(data) ? data.map((d) => Object.keys(d).join('|')).join(' ; ') : '')
  check('1.4 账号均已脱敏（含 ****）', Array.isArray(data) && data.every((d) => typeof d.masked_account === 'string' && d.masked_account.includes('****')))
  check('1.5 不含任何完整账号字段', Array.isArray(data) && data.every((d) => !('account_number' in d) && !('account' in d) && !('full_account' in d)))

  const after = { ops: count('transfer_operations'), tx: count('transactions'), audit: count('audit_logs'), rc: count('transfer_recipients') }
  check('1.6 列举未创建转账单', after.ops === before.ops, `${before.ops}->${after.ops}`)
  check('1.7 列举未产生流水', after.tx === before.tx, `${before.tx}->${after.tx}`)
  check('1.8 列举未写审计日志', after.audit === before.audit, `${before.audit}->${after.audit}`)
  check('1.9 列举未修改收款人', after.rc === before.rc, `${before.rc}->${after.rc}`)
}

// —— 2. 不接受模型注入 user_id / 额外参数 ——
console.log('—— 2. 不接受模型指定 user_id / 额外参数 ——')
{
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'list_transfer_recipients', { user_id: 999 })] },
      { content: '尝试越权' },
    ]),
  })
  const r = await assistant.chat({ message: '列出 999 号用户的收款人' })
  const rec = r.toolRecords.find((x) => x.name === 'list_transfer_recipients')
  check('2.1 user_id 被拒（不接受额外参数）', !!rec && rec.status === 'error' && /不接受额外参数/.test(rec.error || ''), rec && rec.error)
}

// —— 3. 原姓名搜索无回归 ——
console.log('—— 3. 原 search_transfer_recipients 无回归 ——')
{
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'search_transfer_recipients', { name: '李雷' })] },
      { content: '找到收款人。' },
    ]),
  })
  const r = await assistant.chat({ message: '帮我找李雷' })
  const rec = r.toolRecords.find((x) => x.name === 'search_transfer_recipients')
  check('3.1 姓名搜索仍可用', !!rec && rec.status === 'ok')
  check('3.2 搜索返回匹配且脱敏', Array.isArray(rec.data) && rec.data.length >= 1 && rec.data.every((d) => d.masked_account.includes('****')))
}

// —— 4. 空列表如实返回空数组 ——
console.log('—— 4. 空列表如实返回空数组 ——')
{
  const rows = db.prepare('SELECT id, name, masked_account FROM transfer_recipients ORDER BY id').all()
  db.prepare('DELETE FROM transfer_recipients').run()
  const assistant = createAssistant({
    db, demoUserId: userId,
    chatFn: makeScriptedMock([
      { toolCalls: [tc('c1', 'list_transfer_recipients', {})] },
      { content: '暂无收款人。' },
    ]),
  })
  const r = await assistant.chat({ message: '我的收款人有哪些' })
  const rec = r.toolRecords.find((x) => x.name === 'list_transfer_recipients')
  check('4.1 空列表返回空数组', !!rec && rec.status === 'ok' && Array.isArray(rec.data) && rec.data.length === 0, JSON.stringify(rec && rec.data))
  // 还原（临时库，保持幂等习惯）
  const ins = db.prepare('INSERT INTO transfer_recipients (name, masked_account) VALUES (?, ?)')
  for (const r of rows) ins.run(r.name, r.masked_account)
  check('4.2 还原收款人数据', count('transfer_recipients') === rows.length)
}

console.log(`\n共 ${checks} 项检查，${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
db.close()
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { rmSync(p, { force: true }) } catch {} }
process.exit(failures === 0 ? 0 : 1)
