// 助手回答 Markdown 渲染验证：本地固定文本 + 安全净化。不调用收费模型、不访问网络、不修改数据库。
// 用法：node scripts/verify-markdown.mjs
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { setMarkdownPurify, renderMarkdown } from '../src/utils/markdown.js'

const window = new JSDOM('').window
setMarkdownPurify(createDOMPurify(window))

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function renderDoc(text) {
  const html = renderMarkdown(text)
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return { html, doc: dom.window.document }
}

// 1. 银行卡表格（用户示例）
const cardTable = [
  '| 卡号（掩码） | 类型 | 状态 | 单日限额 |',
  '|---|---|---|---|',
  '| 6222 **** **** 1234 | 借记卡 | 正常 | 50,000 元 |',
].join('\n')
const t1 = renderDoc(cardTable)
check('1.1 渲染为 <table>', t1.doc.querySelector('table') !== null)
check('1.2 不残留 Markdown 分隔符', !t1.html.includes('|---') && !t1.html.includes('| 卡号'))
check('1.3 外层横向滚动容器', t1.doc.querySelector('.md-table-scroll') !== null)
check('1.4 表格带 md-table class', t1.doc.querySelector('table.md-table') !== null)

const th1 = Array.from(t1.doc.querySelectorAll('th')).map((n) => n.textContent.trim())
check('1.5 表头顺序正确', JSON.stringify(th1) === JSON.stringify(['卡号（掩码）', '类型', '状态', '单日限额']), th1.join('/'))

const amountTh = th1.length === 4 ? t1.doc.querySelectorAll('th')[3] : null
const cardTh = th1.length === 4 ? t1.doc.querySelectorAll('th')[0] : null
check('1.6 金额列（单日限额）右对齐', amountTh && amountTh.classList.contains('md-align-right'))
check('1.7 卡号列不右对齐', cardTh && !cardTh.classList.contains('md-align-right'))

const tds = Array.from(t1.doc.querySelectorAll('tbody td')).map((n) => n.textContent.trim())
check('1.8 数据行内容正确', JSON.stringify(tds) === JSON.stringify(['6222 **** **** 1234', '借记卡', '正常', '50,000 元']), tds.join('/'))
const amountTd = t1.doc.querySelectorAll('tbody td')[3]
check('1.9 金额数据格右对齐', amountTd && amountTd.classList.contains('md-align-right'))

// 2. 多行表格 + 金额右对齐
const multiTable = [
  '| 卡号（掩码） | 类型 | 状态 | 单日限额 |',
  '|---|---|---|---|',
  '| 6222 **** **** 1234 | 借记卡 | 正常 | 50,000 元 |',
  '| 6222 **** **** 9999 | 贷记卡 | 正常 | 12,000 元 |',
  '| 6222 **** **** 8888 | 借记卡 | 冻结 | 8,888 元 |',
].join('\n')
const t2 = renderDoc(multiTable)
check('2.1 多行表格数据行数 = 3', t2.doc.querySelectorAll('tbody tr').length === 3)
check('2.2 金额列仍右对齐', t2.doc.querySelectorAll('th')[3].classList.contains('md-align-right'))
check('2.3 卡号/类型/状态列左对齐', !t2.doc.querySelectorAll('th')[0].classList.contains('md-align-right'))

// 3. 显式对齐（:---: 居中 / ---: 右对齐）不覆盖、转换为 class
const aligned = ['| 列 | 数值 |', '|:---:|---:|', '| a | 100 元 |'].join('\n')
const t3 = renderDoc(aligned)
check('3.1 显式居中 class', t3.doc.querySelectorAll('th')[0].classList.contains('md-align-center'))
check('3.2 显式右对齐 class', t3.doc.querySelectorAll('th')[1].classList.contains('md-align-right'))
check('3.3 不残留内联 style', !t3.html.includes('style='))

// 4. 普通文本 / 换行 / 列表 / 加粗 / 代码块
const plain = '第一行\n第二行'
const t4a = renderDoc(plain)
check('4.1 普通文本为 <p> 且单换行转 <br>', t4a.doc.querySelector('p') && t4a.doc.querySelector('p br') !== null)
check('4.2 文本内容保留', t4a.doc.querySelector('p').textContent.includes('第一行') && t4a.doc.querySelector('p').textContent.includes('第二行'))

const rich = ['- 项目一', '- 项目二', '', '**加粗** 与 `代码`', '', '```js', 'const a = 1', '```'].join('\n')
const t4b = renderDoc(rich)
check('4.3 列表渲染 <ul><li>', t4b.doc.querySelectorAll('ul li').length === 2)
check('4.4 加粗渲染 <strong>', t4b.doc.querySelector('strong') !== null)
check('4.5 行内代码渲染 <code>', t4b.doc.querySelector('code') !== null)
check('4.6 围栏代码块渲染 <pre>', t4b.doc.querySelector('pre') !== null)

// 5. 不完整 Markdown 安全回退
const broken = ['| 卡号 | 类型 |', '| 6222 **** 1234 | 借记卡'].join('\n')
const t5 = renderDoc(broken)
check('5.1 不完整表格不崩溃且回退为文本', t5.html.length > 0 && t5.doc.querySelector('table') === null)
check('5.2 回退文本保留原内容', t5.doc.body.textContent.includes('卡号'))
check('5.3 空文本回退为空', renderMarkdown('') === '' && renderMarkdown(null) === '')

// 6. 恶意 HTML / 事件属性 / 图片 / 可执行链接
check('6.1 原始 <script> 被转义', !renderDoc('<script>alert(1)</script>').html.includes('<script'))
check('6.2 原始 <img onerror> 被转义', !renderDoc('<img src=x onerror=alert(1)>').html.includes('<img'))
const imgMarkdown = renderDoc('![x](http://evil.example/x.png)')
check('6.3 图片不产生外部加载（<img> 被剥离）', !imgMarkdown.html.includes('<img'))
check('6.4 javascript: 链接被阻断', !renderDoc('[x](javascript:alert(1))').html.includes('href="javascript'))
check('6.5 data: 链接被阻断', !renderDoc('[x](data:text/html,<script>)').html.toLowerCase().includes('href="data:'))
check('6.6 事件属性不残留', !renderDoc('[x](http://a.b)').html.includes('onerror') && !renderDoc('[x](http://a.b)').html.includes('onclick'))
check('6.7 安全 http 链接保留并带 rel', (() => {
  const h = renderDoc('[官网](https://example.com)').html
  return h.includes('href="https://example.com"') && h.includes('rel="noopener noreferrer"')
})())
check('6.8 表单 / 按钮 / iframe 被转义', !renderDoc('<form><button>x</button></form><iframe src=x></iframe>').html.includes('<form') && !renderDoc('<form><button>x</button></form><iframe src=x></iframe>').html.includes('<iframe'))

console.log(failures === 0 ? '\n全部检查通过 ✅' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
