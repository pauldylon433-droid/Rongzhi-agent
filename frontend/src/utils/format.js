// 金额与日期格式化工具（前端展示层）。
//
// 约定：
// - 后端金额均为整数「分」（字段以 _cents 结尾），这里统一转换为「元」，
//   使用千位分隔符并保留两位小数；正负号由调用方根据收支方向自行添加。
// - 时间字段为 UTC ISO 8601 字符串（带 Z），展示时按 Asia/Shanghai（UTC+8，
//   无夏令时）转换。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function pad(n) {
  return String(n).padStart(2, '0')
}

// 整数分 → "42,331.09"（仅处理非负金额）
// 分 → 元字符串（两位小数）。非法值（null / undefined / NaN / Infinity / 字符串）返回「—」；
// 合法 0 仍显示 0.00。调用方对「不可用」的语义可自行替换为「暂无法获取」。
export function formatCentsToYuan(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—'
  const abs = Math.abs(Math.round(cents))
  const yuan = Math.floor(abs / 100)
  const fen = String(abs % 100).padStart(2, '0')
  const yuanWithComma = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${yuanWithComma}.${fen}`
}

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }

export function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || `${code} `
}

// 整数分 + 币种 → "¥42,331.09"
export function formatMoney(cents, currency) {
  return `${currencySymbol(currency || 'CNY')}${formatCentsToYuan(cents)}`
}

// UTC ISO 字符串 → 承载上海本地时间的 Date（内部用 UTC 分量读取上海年月日时分）
function toShanghaiDate(iso) {
  return new Date(new Date(iso).getTime() + SHANGHAI_OFFSET_MS)
}

// → "2026-10-30 14:42"
export function formatShanghaiDateTime(iso) {
  if (!iso) return '—'
  const d = toShanghaiDate(iso)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// → "2026-11-15"
export function formatShanghaiDate(iso) {
  if (!iso) return '—'
  const d = toShanghaiDate(iso)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// 当前上海年月（month 为 1-12）
export function currentShanghaiYearMonth() {
  const d = new Date(Date.now() + SHANGHAI_OFFSET_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

// 元字符串 → 整数分。用字符串拆分避免浮点乘 100 的精度误差。
// 仅接受非负金额（如 "100"、"1234.56"）；非法输入返回 null。
export function yuanToCents(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s === '' || !/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [intPart, fracPart = ''] = s.split('.')
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}
