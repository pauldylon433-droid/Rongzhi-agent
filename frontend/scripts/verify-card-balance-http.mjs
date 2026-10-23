// 独立临时本地服务验证：verify-card-balance 的 HTTP 集成检查逻辑。
//
// 不依赖 3000 / 4177 或任何运行中的验收环境；在 127.0.0.1 随机空闲端口启动临时 HTTP 服务，
// 分别以「旧接口（卡片无余额字段）」与「新接口（卡片含余额）」两组夹具执行同一套检查函数，
// 并验证：数据不一致时检查会 FAIL、连接失败会抛错（不被吞掉算 PASS）。
//
// 用法：node scripts/verify-card-balance-http.mjs
import http from 'node:http'
import { checkHttpIntegration } from './verify-card-balance.mjs'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function startServer(fixture) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (req.url.startsWith('/api/cards')) return res.end(JSON.stringify({ success: true, data: fixture.cards }))
      if (req.url.startsWith('/api/accounts')) return res.end(JSON.stringify({ success: true, data: fixture.accounts }))
      res.statusCode = 404
      res.end(JSON.stringify({ success: false, message: 'not found' }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}
const close = (server) => new Promise((r) => server.close(r))

const legacyFixture = {
  accounts: [{ id: 1, account_name: '人民币活期账户', balance_cents: 4046338, currency: 'CNY', status: 'active' }],
  cards: [{ id: 1, account_id: 1, masked_card_number: '6222 **** **** 1234', card_type: '借记卡', status: 'active' }],
}
const modernFixture = {
  accounts: [
    { id: 1, account_name: '人民币活期账户', account_type: 'deposit', balance_cents: 4203730, currency: 'CNY', status: 'active' },
    { id: 2, account_name: '人民币信用卡', account_type: 'credit', balance_cents: 0, currency: 'CNY', status: 'active' },
  ],
  cards: [
    { id: 1, account_id: 1, account_type: 'deposit', account_name: '人民币活期账户', account_status: 'active', balance_cents: 4203730, masked_card_number: '6222 **** **** 0001', card_type: '借记卡', status: 'active' },
    { id: 2, account_id: 2, account_type: 'credit', account_name: '人民币信用卡', account_status: 'active', balance_cents: 0, masked_card_number: '6259 **** **** 0003', card_type: '信用卡', status: 'active' },
  ],
}
// 数据不一致夹具：卡片余额与关联账户不一致，检查函数必须报 FAIL
const brokenFixture = {
  accounts: [{ id: 1, account_name: '人民币活期账户', balance_cents: 1000, currency: 'CNY', status: 'active' }],
  cards: [{ id: 1, account_id: 1, account_type: 'deposit', account_status: 'active', balance_cents: 9999, masked_card_number: '6222 **** **** 0001', card_type: '借记卡', status: 'active' }],
}

async function runFixture(fixture, label) {
  const { server, base } = await startServer(fixture)
  let localFailures = 0
  const localCheck = (name, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  [${label}] ${name}${detail ? '  [' + detail + ']' : ''}`)
    if (!cond) localFailures += 1
  }
  try {
    const out = await checkHttpIntegration(base, localCheck)
    return { out, localFailures }
  } finally {
    await close(server)
  }
}

console.log('—— 旧接口夹具（卡片无余额字段 → 按 account_id 关联账户）——')
{
  const { out, localFailures } = await runFixture(legacyFixture, 'legacy')
  check('旧接口：集成检查全部通过', localFailures === 0, String(localFailures))
  check('旧接口：契约识别为 legacy', out.contract === 'legacy', out.contract)
}

console.log('—— 新接口夹具（卡片含余额 + 信用卡）——')
{
  const { out, localFailures } = await runFixture(modernFixture, 'modern')
  check('新接口：集成检查全部通过', localFailures === 0, String(localFailures))
  check('新接口：契约识别为 new', out.contract === 'new', out.contract)
}

console.log('—— 负向：数据不一致必须 FAIL ——')
{
  const { localFailures } = await runFixture(brokenFixture, 'broken')
  check('数据不一致时检查函数报 FAIL（不静默通过）', localFailures >= 1, String(localFailures))
}

console.log('—— 负向：连接失败必须抛错（不吞掉算 PASS）——')
{
  let threw = false
  try {
    await checkHttpIntegration('http://127.0.0.1:1', () => {})
  } catch {
    threw = true
  }
  check('连接失败抛出异常，由调用方记 FAIL', threw === true)
}

console.log(failures === 0 ? '\n卡片余额 HTTP 检查（独立本地服务）全部通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
