// 初始化 CloudBase 持久库的独立演示数据（幂等；不重置、不覆盖）。
// 用法（后端环境变量已配置 CLOUDBASE_RPC_BASE / CLOUDBASE_SERVICE_KEY）：
//   npm run cloud:init
// 不读取 SQLite 开发库、聊天历史或本机验证绑定。
import { getCloudBaseConfig, validateCloudConfig } from '../src/config.js'
import { createCloudRpcClient } from '../src/cloud/rpc-client.js'

const missing = validateCloudConfig()
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}（不显示具体值）`)
  process.exit(1)
}
const cfg = getCloudBaseConfig()
const client = createCloudRpcClient({ base: cfg.base, serviceKey: cfg.serviceKey })

try {
  const health = await client.health()
  if (!health || health.ok !== true) throw new Error('健康检查失败')
  const result = await client.seed(cfg.demoUserId)
  const snap = await client.snapshot(cfg.demoUserId)
  console.log(JSON.stringify({
    seeded: result && result.seeded === true,
    reason: result && result.reason ? result.reason : null,
    user_id: cfg.demoUserId,
    accounts: snap.accounts?.length || 0,
    transactions: snap.transactions?.length || 0,
    cards: snap.cards?.length || 0,
    subscriptions: snap.subscriptions?.length || 0,
    credit_accounts: snap.credit_accounts?.length || 0,
    verification_bound: snap.verification?.bound === true,
  }, null, 2))
} catch (e) {
  console.error('[初始化失败]', e && e.message ? e.message : e)
  process.exit(1)
}
