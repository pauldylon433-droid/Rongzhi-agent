// 助手回答的 Markdown 渲染：markdown-it 解析 → 严格白名单净化（DOMPurify）。
// 仅用于渲染助手文本；用户消息仍按纯文本展示。渲染结果不生成任何业务操作入口。
// 依赖：markdown-it（解析，html:false 转义原始 HTML）+ dompurify（白名单净化，第二道防线）。
import MarkdownIt from 'markdown-it'
import createDOMPurify from 'dompurify'

// --- markdown-it 配置 ---
const md = new MarkdownIt({
  html: false, // 原始 HTML 一律转义，禁止注入
  linkify: false, // 不自动把裸 URL 变成链接
  breaks: true, // 单换行渲染为 <br>，保留多行回答
  typographer: false,
})

// markdown-it 对 :--- / :---: 生成的 style="text-align:..." 转为受控 class（避免保留内联 style）
function alignClassFor(style) {
  if (style === 'text-align:center') return 'md-align-center'
  if (style === 'text-align:right') return 'md-align-right'
  return ''
}

function stripAlignStyle(token) {
  const cls = alignClassFor(token.attrGet('style'))
  if (cls) token.attrSet('class', cls)
  token.attrs = (token.attrs || []).filter(([k]) => k !== 'style')
}

const defaultThOpen = md.renderer.rules.th_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
const defaultTdOpen = md.renderer.rules.td_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
md.renderer.rules.th_open = (tokens, idx, options, env, self) => {
  stripAlignStyle(tokens[idx])
  return defaultThOpen(tokens, idx, options, env, self)
}
md.renderer.rules.td_open = (tokens, idx, options, env, self) => {
  stripAlignStyle(tokens[idx])
  return defaultTdOpen(tokens, idx, options, env, self)
}

// 表格外层包裹可横向滚动的容器（手机宽度下在消息内部滚动，不撑宽整页）
md.renderer.rules.table_open = () => '<div class="md-table-scroll"><table class="md-table">'
md.renderer.rules.table_close = () => '</table></div>'

// 链接：强制 rel，避免 opener / referrer 泄漏
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// --- 金额列右对齐：无显式 :--- 对齐时，靠整列数据内容可靠识别 ---
const AMOUNT_RE = /^[¥￥]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:元|万元|万|块|块钱)?$/

function isAmountText(text) {
  return AMOUNT_RE.test((text || '').trim())
}

function alignTableAmountColumns(tokens, start, end) {
  const rows = []
  let cur = null
  for (let k = start + 1; k < end; k++) {
    const t = tokens[k]
    if (t.type === 'tr_open') {
      cur = []
    } else if (t.type === 'tr_close') {
      rows.push(cur)
      cur = null
    } else if ((t.type === 'th_open' || t.type === 'td_open') && cur) {
      cur.push({ open: t, inline: tokens[k + 1] })
    }
  }
  if (rows.length < 2) return // 无表头或无数据行
  const header = rows[0]
  const colCount = header.length
  for (let c = 0; c < colCount; c++) {
    const head = header[c]
    if (!head) continue
    // 已有显式对齐（:--- / :---:）时保持，不覆盖
    if (head.open.attrGet('style')) continue
    const cells = rows.slice(1).map((r) => r[c]).filter(Boolean)
    if (cells.length === 0) continue
    // 可靠识别：整列数据格均为金额/数值才右对齐，否则统一左对齐，不改动数值
    if (cells.every((cell) => isAmountText(cell.inline.content))) {
      for (const cell of [head, ...cells]) {
        cell.open.attrSet('style', 'text-align:right')
      }
    }
  }
}

md.core.ruler.after('inline', 'table_amount_align', (state) => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue
    let j = i + 1
    while (j < tokens.length && tokens[j].type !== 'table_close') j++
    if (j < tokens.length) {
      alignTableAmountColumns(tokens, i, j)
      i = j
    }
  }
})

// --- 白名单净化配置 ---
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'del', 'code', 'pre', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'a',
]

const ALLOWED_ATTR = {
  a: ['href', 'title', 'rel'],
  div: ['class'],
  table: ['class'],
  th: ['class'],
  td: ['class'],
}

const SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  // 不设自定义 ALLOWED_URI_REGEXP：DOMPurify 默认 URI 校验已阻断 javascript:/data:/vbscript: 等
  // 可执行链接，同时保留 http(s)/mailto 与 rel 属性（自定义正则反而会误删 rel）。
  FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button', 'img', 'svg', 'math', 'object', 'embed', 'video', 'audio', 'link', 'meta', 'base'],
  FORBID_ATTR: ['onerror', 'onclick', 'onload', 'style'],
}

let _purify = null
function purify() {
  if (_purify) return _purify
  if (typeof window === 'undefined') {
    throw new Error('非浏览器环境需先调用 setMarkdownPurify() 注入 DOMPurify 实例')
  }
  _purify = createDOMPurify(window)
  return _purify
}

/** 供 Node 测试环境注入 DOMPurify 实例（浏览器环境自动从 window 创建） */
export function setMarkdownPurify(instance) {
  _purify = instance
}

/**
 * 将助手回答的 Markdown 文本渲染为净化后的 HTML。
 * 空文本 / 解析异常均安全回退为空字符串，调用方按纯文本兜底。
 */
export function renderMarkdown(text) {
  const source = text == null ? '' : String(text)
  if (!source.trim()) return ''
  try {
    const raw = md.render(source)
    return purify().sanitize(raw, SANITIZE_CONFIG)
  } catch {
    return ''
  }
}
