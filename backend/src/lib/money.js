// 金额字符串 → 整数分（服务端精确转换，供 AI 转账工具等复用）。
// 仅接受非负金额字符串（如 "100"、"1234.56"、"0.01"）；用字符串拆分，禁止浮点乘 100。
// 拒绝负数、零、超过两位小数、科学计数法、空串、非字符串及超出安全整数范围；非法返回 null。
export function yuanToCents(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s === '' || !/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [intPart, fracPart = ''] = s.split('.')
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) return null
  return cents
}
