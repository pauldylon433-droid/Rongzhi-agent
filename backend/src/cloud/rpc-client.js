// CloudBase PostgreSQL 固定 RPC 客户端。
// 只调用白名单函数；服务端 API Key 仅存在于后端进程内存，不写日志、不返回前端。
// 所有调用等待完成；非 2xx 或业务 SQLSTATE 原样抛给上层，绝不吞错后返回成功。

export class CloudRpcError extends Error {
  constructor(message, { rawCode = '', sqlState = '', status = 0, body = null } = {}) {
    super(message)
    this.name = 'CloudRpcError'
    this.rawCode = rawCode
    this.sqlState = sqlState
    this.status = status
    this.body = body
  }
}

// CloudBase 可能返回裸 SQLSTATE 或 DATABASE_<SQLSTATE>；只接受完整五位。
export function extractSqlState(body) {
  const raw = body && typeof body === 'object'
    ? (body.code ?? body.error_code ?? body.error?.code ?? body.data?.code)
    : null
  const code = raw == null ? '' : String(raw).toUpperCase()
  const m = /^(?:DATABASE_)?([0-9A-Z]{5})$/.exec(code)
  return { rawCode: code, sqlState: m ? m[1] : '' }
}

function errorMessage(body) {
  if (!body || typeof body !== 'object') return ''
  return String(body.message ?? body.error_description ?? body.error?.message ?? '')
}

function validateBase(value) {
  let u
  try { u = new URL(String(value)) } catch { throw new Error('CLOUDBASE_RPC_BASE 不是合法 URL') }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('CLOUDBASE_RPC_BASE 只接受站点根地址，且不得包含凭据 / 查询串 / 片段')
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  const cloud = u.protocol === 'https:' && /(^|\.)api\.tcloudbasegateway\.com$/i.test(u.hostname)
  if (!local && !cloud) throw new Error('CLOUDBASE_RPC_BASE 仅允许 CloudBase 网关或本地测试桩')
  return `${u.protocol}//${u.host}`
}

export function createCloudRpcClient({ base, serviceKey, fetchImpl = fetch }) {
  if (!base) throw new Error('缺少 CLOUDBASE_RPC_BASE')
  if (!serviceKey) throw new Error('缺少 CLOUDBASE_SERVICE_KEY')
  const root = validateBase(base)

  async function call(fn, params = {}) {
    let res
    try {
      res = await fetchImpl(`${root}/v1/rdb/rest/rpc/${encodeURIComponent(fn)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(params),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      })
    } catch (e) {
      throw new CloudRpcError('CloudBase RPC 请求失败（网络 / 超时）', {
        status: 0,
        body: { message: String(e && e.message ? e.message : e) },
      })
    }
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (!res.ok) {
      const { rawCode, sqlState } = extractSqlState(body)
      throw new CloudRpcError(errorMessage(body) || `CloudBase RPC 失败（HTTP ${res.status}）`, {
        rawCode, sqlState, status: res.status, body,
      })
    }
    return body
  }

  return {
    base: root,
    call,
    health: () => call('rongzhi_bank_health_v1'),
    snapshot: (userId) => call('rongzhi_bank_snapshot_v1', { p_user_id: userId }),
    verificationSecret: (userId) => call('rongzhi_bank_verification_secret_v1', { p_user_id: userId }),
    write: (domain, op, payload, userId) => {
      const fn = {
        transfer: 'rongzhi_bank_transfer_write_v1',
        card: 'rongzhi_bank_card_write_v1',
        subscription: 'rongzhi_bank_sub_write_v1',
        repayment: 'rongzhi_bank_repay_write_v1',
        chat: 'rongzhi_bank_chat_write_v1',
        verification: 'rongzhi_bank_verification_write_v1',
        task: 'rongzhi_bank_task_write_v1',
      }[domain]
      if (!fn) throw new Error('不支持的云写入域')
      return call(fn, { p_user_id: userId, p_op: op, p_payload: payload || {} })
    },
    seed: (userId) => call('rongzhi_bank_seed_v1', { p_user_id: userId }),
  }
}
