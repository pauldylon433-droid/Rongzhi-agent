// 分类稳定配色：按分类名确定性取色，保证同一分类在收入/支出饼图、图例与
// 不同月份间颜色一致（颜色稳定）。已知分类复用 CategoryBadge 的色板，
// 未知分类按名称哈希落入备用色板，保证切片颜色可区分、不依赖数据顺序。
const KNOWN = {
  '收入': '#16a34a', // 收入沿用系统绿色语义
  '餐饮': '#e0533d',
  '购物': '#dc2626',
  '交通': '#2563eb',
  '住房': '#4f46e5',
  '娱乐': '#d97706',
  '订阅扣费': '#7c3aed',
  '订阅': '#7c3aed',
}

// 未知分类备用色板（彼此可区分）
const FALLBACK = [
  '#0ea5e9', '#f97316', '#14b8a6', '#e11d48', '#8b5cf6',
  '#f59e0b', '#06b6d4', '#84cc16', '#ec4899', '#64748b',
]

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export function categoryColor(category) {
  const c = String(category || '')
  if (KNOWN[c]) return KNOWN[c]
  return FALLBACK[hashStr(c) % FALLBACK.length]
}
