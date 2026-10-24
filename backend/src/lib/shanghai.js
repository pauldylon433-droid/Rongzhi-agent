// Asia/Shanghai（UTC+8，无夏令时）时间工具。
// 数据库中的时间以 UTC ISO 8601 字符串存储；本模块用于把上海自然月换算成 UTC 边界。

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function shanghaiMonthStartUtcIso(year, month) {
  // month 为 1-12，返回该上海月份 1 日 00:00 对应的 UTC ISO 字符串
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - SHANGHAI_OFFSET_MS).toISOString()
}

// 返回某上海月份的 [月初, 下月月初) 左闭右开边界（UTC ISO 字符串）
export function shanghaiMonthRange(year, month) {
  const start = shanghaiMonthStartUtcIso(year, month)
  let nextYear = year
  let nextMonth = month + 1
  if (nextMonth > 12) {
    nextMonth = 1
    nextYear += 1
  }
  const end = shanghaiMonthStartUtcIso(nextYear, nextMonth)
  return { start, end }
}

// 当前（或指定时刻）Asia/Shanghai 的年/月/日
export function shanghaiNowParts(ms = Date.now()) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// 返回某上海自然日的 [当日 00:00, 次日 00:00) 左闭右开边界（UTC ISO 字符串）
export function shanghaiDayRange(year, month, day) {
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - SHANGHAI_OFFSET_MS).toISOString()
  const end = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - SHANGHAI_OFFSET_MS).toISOString()
  return { start, end }
}
