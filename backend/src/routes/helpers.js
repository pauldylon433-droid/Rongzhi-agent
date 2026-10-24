// 通用 HTTP 响应与参数解析辅助函数

export function ok(res, data, meta) {
  const body = { success: true, data }
  if (meta !== undefined) body.meta = meta
  res.json(body)
}

export function badRequest(res, message) {
  res.status(400).json({ success: false, message })
}

// 解析 month=YYYY-MM；非法格式或非法月份返回 null
export function parseMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return null
  }
  const [year, month] = value.split('-').map(Number)
  return { year, month }
}

// 解析分页参数；非法返回 { error }，否则返回 { limit, offset }
export function parsePagination(query) {
  let limit = 50
  let offset = 0

  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) {
      return { error: 'limit 必须是正整数' }
    }
    const n = Number(query.limit)
    if (n < 1 || n > 100) {
      return { error: 'limit 必须在 1 到 100 之间' }
    }
    limit = n
  }

  if (query.offset !== undefined) {
    if (typeof query.offset !== 'string' || !/^\d+$/.test(query.offset)) {
      return { error: 'offset 必须是非负整数' }
    }
    offset = Number(query.offset)
  }

  return { limit, offset }
}
