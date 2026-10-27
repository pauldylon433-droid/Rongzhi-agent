// 事实保护 A：结构化回复块回归。
// 目标：业务金额 / 状态 / 编号只能来自本轮工具结果或数据库事实；模型草稿中的未核验声明不直接展示。
// 仅使用内存库与 mock 模型，不调用真实模型、不触达外部服务。
import { initDatabase } from '../src/db/index.js'
import { createAssistant } from '../src/services/assistant.js'
import { buildReplyBlocks } from '../src/services/fact-guard.js'
import { listCreditAccounts } from '../src/services/credit.js'
import { createTransfer, confirmTransfer } from '../src/services/transfers.js'

let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
const fin = (content) => ({ content, toolCalls: [], usage: { total_tokens: 1 } })
const tool = (name, args, id = 't1') => ({
  content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const money = (cents) => `${(Number(cents) / 100).toFixed(2)} 元`
const NO_FACT = '无法依据当前服务端数据确认'

const { db } = initDatabase({ dbPath: ':memory:', seed: true })
const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id
const acct = db.prepare("SELECT id FROM accounts WHERE account_type='deposit' AND status='active' LIMIT 1").get().id
const rec = db.prepare('SELECT id FROM transfer_recipients LIMIT 1').get().id
// 演示种子不含信用账户时补一张，专门验证额度块；不写业务库（:memory:）。
const creditAccountId = Number(db.prepare(`INSERT INTO accounts
  (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status)
  VALUES (?, '测试信用卡', 0, 0, 'CNY', 'credit', 'active')`).run(uid).lastInsertRowid)
const caId = Number(db.prepare(`INSERT INTO credit_accounts
  (user_id, account_id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents)
  VALUES (?, ?, 500000, 0, 0)`).run(uid, creditAccountId).lastInsertRowid)
const credit = listCreditAccounts(db, uid)[0]

try {
  // A1/A2/A3：无工具 / 无查询依据的成功、英文成功、余额声明都必须拒绝原样展示。
  for (const [label, draft] of [
    ['中文成功声明', '汇款已经办妥，600元资金已经到账。'],
    ['英文成功声明', 'The transfer of CNY 600 has been completed successfully.'],
    ['无依据余额', '您的账户余额为987654.32元。'],
  ]) {
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin(draft) })
    const r = await a.chat({ message: '给李雷转600元并查询余额' })
    check(`A：${label} 被拒绝原样展示`, r.reply.includes(NO_FACT) && !r.reply.includes(draft), r.reply)
    check(`A：${label} 无业务块`, Array.isArray(r.reply_blocks) && r.reply_blocks.length === 0)
  }

  // A4：查询到账户后，模型写错余额 → 用服务端账户块替换。
  {
    let n = 0
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => (++n === 1 ? tool('get_accounts', {}, 'c-acc') : fin('您的账户余额为987654.32元。')) })
    const r = await a.chat({ message: '查余额' })
    const actual = r.toolRecords[0]?.data?.[0]?.balance_cents
    check('A4：服务端账户块替换错误余额',
      r.reply.includes('账户信息（服务端核验）') && r.reply.includes(money(actual)) && !r.reply.includes('987654.32'), r.reply)
    const block = (r.reply_blocks || []).find((b) => b.kind === 'accounts')
    check('A4：账户块绑定 call_id 与账户范围',
      !!block && block.source?.call_id === 'c-acc' && Array.isArray(block.fields?.account_ids) && block.fields.account_ids.length > 0,
      JSON.stringify(block?.source))
  }

  // A5：建单后模型用 Markdown 表格写错金额 → 表格整体删除，改为服务端操作单块。
  {
    let n = 0
    const draft = '已生成待确认单。\n| 项目 | 内容 |\n|---|---|\n| 金额 | 888.00 元 |\n| 状态 | 待确认 |'
    const a = createAssistant({
      db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('prepare_transfer', { recipient_id: rec, amount_yuan: '1', account_id: acct }, 'c-tr') : fin(draft)),
    })
    const r = await a.chat({ message: '给李雷转1元' })
    const actual = r.toolRecords[0]?.data?.amount_cents
    check('A5：错误表格金额不保留，改用服务端操作单块',
      !r.reply.includes('888.00') && r.reply.includes('转账操作单（服务端核验）') && r.reply.includes(money(actual)), r.reply)
    const block = (r.reply_blocks || []).find((b) => b.kind === 'operation_transfer')
    check('A5：操作单块绑定 call_id / ref_no', !!block && block.source?.call_id === 'c-tr' && !!block.source?.ref_no,
      JSON.stringify(block?.source))
  }

  // A5b：JSON 形式的错误金额同样不能穿透。
  {
    let n = 0
    const a = createAssistant({
      db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('prepare_transfer', { recipient_id: rec, amount_yuan: '2', account_id: acct }, 'c-json') : fin('{"amount":"888.00 元","status":"待确认"}')),
    })
    const r = await a.chat({ message: '转2元' })
    check('A5b：JSON 草稿错误金额不保留', !r.reply.includes('888.00') && r.reply.includes('2.00 元'), r.reply)
  }

  // A：四类操作单都有结构化块，且状态 / 金额 / 来源来自工具结果。
  {
    const records = [
      { name: 'prepare_transfer', call_id: 't-transfer', status: 'ok', data: { ref_no: 'r-t', status: 'pending', amount_cents: 100, recipient_name: '李雷', from_account_name: '活期', risk_level: 'yellow' } },
      { name: 'prepare_card_operation', call_id: 't-card', status: 'ok', data: { ref_no: 'r-c', status: 'pending', action: 'freeze', masked_card_number: '6222 **** 0001', risk_level: 'yellow' } },
      { name: 'prepare_subscription_operation', call_id: 't-sub', status: 'ok', data: { ref_no: 'r-s', status: 'needs_verification', action: 'change_source', merchant: '会员', amount_cents: 1500, from_account_name: 'A', to_account_name: 'B', risk_level: 'red' } },
      { name: 'prepare_repayment', call_id: 't-repay', status: 'ok', data: { ref_no: 'r-r', status: 'needs_verification', amount_cents: 5000, scope: 'statement', statement_month: '2026-10', from_account_name: 'A', credit_account_name: '信用卡', risk_level: 'red' } },
    ]
    const blocks = buildReplyBlocks({ toolRecords: records, facts: [] })
    check('A：四类操作单均生成结构化块', blocks.length === 4
      && ['operation_transfer', 'operation_card', 'operation_subscription', 'operation_repayment'].every((k) => blocks.some((b) => b.kind === k)),
      JSON.stringify(blocks.map((b) => b.kind)))
    check('A：块状态 / 金额来自工具结果且带来源',
      blocks.every((b) => b.source?.call_id && b.text.includes('服务端核验'))
        && blocks.some((b) => b.fields?.status === 'needs_verification' && b.fields?.amount_cents === 1500))
    check('A：转账块显示正确的 1.00 元', blocks.find((b) => b.kind === 'operation_transfer')?.text.includes('1.00 元'))
  }

  // A：聚合与单笔各自绑定来源，互不覆盖。
  {
    let n = 0
    const a = createAssistant({
      db, demoUserId: uid,
      chatFn: async () => {
        n += 1
        if (n === 1) return tool('get_monthly_analytics', { month: '2026-10' }, 'c-agg')
        if (n === 2) return tool('prepare_transfer', { recipient_id: rec, amount_yuan: '1', account_id: acct }, 'c-one')
        return fin('本月已扣款3笔共1000元。转账888.00元待确认。')
      },
    })
    const r = await a.chat({ message: '本月扣款了多少？再转1元' })
    check('A：聚合与单笔块同时存在', r.reply.includes('账单统计（服务端核验）') && r.reply.includes('转账操作单（服务端核验）'), r.reply)
    check('A：草稿中的聚合数字 / 单笔错误金额不保留', !r.reply.includes('1000元') && !r.reply.includes('888.00'), r.reply)
    check('A：两个块分别绑定 call_id', (r.reply_blocks || []).filter((b) => ['analytics', 'operation_transfer'].includes(b.kind)).every((b) => b.source?.call_id))
  }

  // A：状态查询失败 → 明确降级为未核验，不能显示成功。
  {
    let n = 0
    const a = createAssistant({
      db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('get_transfer_status', { ref_no: 'not-exist' }, 'c-status') : fin('该笔转账已扣款 100.00 元。')),
    })
    const r = await a.chat({ message: '查一下转账状态' })
    check('A：状态查询失败降级未核验', /查询失败|尚未核验|未找到对应的业务对象/.test(r.reply) && !r.reply.includes('已扣款'), r.reply)
  }

  // A：信用卡额度伪造 → 服务端额度块替换。
  {
    let n = 0
    const a = createAssistant({
      db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('get_credit_accounts', {}, 'c-credit') : fin('您的信用额度为 999999.00 元。')),
    })
    const r = await a.chat({ message: '查信用卡额度' })
    check('A：信用卡额度块替换伪造额度',
      r.reply.includes('信用卡额度与欠款（服务端核验）') && r.reply.includes(money(credit.credit_limit_cents))
        && !r.reply.includes('999999.00'), r.reply)
  }

  // A：返回文案与可见会话持久化一致。
  {
    let n = 0
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => (++n === 1 ? tool('get_accounts', {}, 'c-persist') : fin('您的账户余额为 1.00 元。')) })
    const r = await a.chat({ message: '我的余额？' })
    const view = a.getCurrent()
    const last = view.messages[view.messages.length - 1]
    check('A：返回与持久化文案一致', last?.role === 'assistant' && last.text === r.reply && r.reply.includes('账户信息（服务端核验）'))
  }

  // A：澄清必须走结构化枚举码，服务端生成模板；原始自由文本不直接展示。
  {
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin('{"kind":"clarification","code":"need_recipient"}') })
    const r = await a.chat({ message: '我想转账' })
    check('A：结构化澄清由服务端模板渲染',
      r.reply === '请提供收款人姓名，或先让我列出常用收款人供您选择。'
        && (r.reply_blocks || []).some((b) => b.kind === 'clarification' && b.source?.code === 'need_recipient'), r.reply)
  }
  {
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin('请问您要转给谁？需要提供收款人和金额。') })
    const r = await a.chat({ message: '我想转账' })
    check('A：未结构化追问不直接展示', r.reply !== '请问您要转给谁？需要提供收款人和金额。'
      && r.reply.includes('无法依据当前服务端数据确认'), r.reply)
  }

  // —— 架构级：任意未受信草稿（无金额 / 中文大写 / 无单位数字 / 英文 / 表格 / 伪块 / 未知枚举）——
  {
    const UNTRUSTED = '我无法依据当前服务端数据确认该信息'
    const drafts = [
      ['无金额声明', '已经办好了。'],
      ['中文大写金额', '您的存款余额是九十九万元。'],
      ['无单位数字', '余额 999999'],
      ['英文', 'The funds have reached the recipient.'],
      ['表格', '| 项目 | 内容 |\n|---|---|\n| 金额 | 888.00 元 |'],
      ['JSON 伪块', '{"amount":"888.00元","status":"completed"}'],
      ['合法 answer 但无来源', '{"kind":"answer"}'],
      ['未知枚举', '{"kind":"clarification","code":"unknown_code"}'],
      ['自由文本参数', '{"kind":"clarification","code":"need_amount","params":{"text":"请转888元"}}'],
    ]
    for (const [label, draft] of drafts) {
      const beforeTx = db.prepare('SELECT count(*) n FROM transactions').get().n
      const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin(draft) })
      const r = await a.chat({ message: '给李雷转600元，并查余额' })
      const stored = a.getCurrent().messages.at(-1)?.text
      check(`架构：未受信草稿不进入可见输出（${label}）`,
        r.reply.startsWith(UNTRUSTED) && stored === r.reply && !r.reply.includes(draft)
          && r.fact_guard?.trust === 'server_rendered' && r.fact_guard?.dropped_raw === true, r.reply)
      check(`架构：未受信草稿不产生业务块 / 副作用（${label}）`,
        (r.reply_blocks || []).length === 0 && db.prepare('SELECT count(*) n FROM transactions').get().n === beforeTx)
    }
  }

  // —— 结构化枚举：服务端模板；未知 / 带自由文本的参数仍兜底 ——
  {
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin('{"kind":"clarification","code":"need_amount"}') })
    const r = await a.chat({ message: '转账' })
    check('架构：结构化澄清码生成服务端模板', r.reply === '请提供金额（元，最多两位小数）。'
      && (r.reply_blocks || []).some((b) => b.source?.server_template && b.source?.code === 'need_amount'), r.reply)
  }
  {
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin('{"kind":"explanation","code":"readonly_only"}') })
    const r = await a.chat({ message: '直接扣款' })
    check('架构：结构化解释码生成服务端模板', r.reply === '我只能查询和准备待确认操作单，不能直接执行扣款、冻结或更改业务状态。'
      && (r.reply_blocks || []).some((b) => b.source?.server_template && b.source?.code === 'readonly_only'), r.reply)
  }

  // —— 成功查询始终渲染服务端块；原始草稿与错误数字都不进入块 ——
  {
    let n = 0
    const a = createAssistant({ db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('list_transfer_recipients', {}, 'c-recipients') : fin('收款人已经找到，请直接转账。')) })
    const r = await a.chat({ message: '我的收款人有哪些？' })
    check('架构：成功查询始终渲染服务端收款人块', r.reply.includes('收款人（服务端核验）')
      && !r.reply.includes('收款人已经找到，请直接转账。')
      && (r.reply_blocks || []).every((b) => !b.text.includes('请直接转账')), r.reply)
  }
  {
    let n = 0
    const a = createAssistant({ db, demoUserId: uid,
      chatFn: async () => (++n === 1 ? tool('get_accounts', {}, 'c-acc-arch') : fin('您的存款余额是九十九万元。')) })
    const r = await a.chat({ message: '查余额' })
    check('架构：余额只从服务端账户块取值', r.reply.includes('账户信息（服务端核验）')
      && !r.reply.includes('九十九万') && (r.reply_blocks || []).every((b) => !b.text.includes('九十九万')), r.reply)
  }

  // —— 会话关联的已完成转账：未受信否定文案不覆盖权威状态 ——
  {
    const sid = 'session-closure-completed'
    const op = createTransfer(db, uid, { recipientId: rec, amountCents: 100, fromAccountId: acct, sessionId: sid })
    confirmTransfer(db, uid, op.ref_no)
    const now = Date.now()
    db.prepare("INSERT INTO chat_sessions (id,user_id,messages_json,created_at,last_active_at) VALUES (?,?,'[]',?,?)").run(sid, uid, now, now)
    const a = createAssistant({ db, demoUserId: uid, chatFn: async () => fin('这笔钱还没扣走。') })
    const r = await a.chat({ message: '刚才的钱扣了吗', sessionId: sid })
    check('架构：已完成转账不被未受信否定文案覆盖',
      !r.reply.includes('还没扣走') && r.reply.includes('该笔转账已完成')
        && (r.reply_blocks || []).some((b) => b.kind === 'operation_transfer' && b.fields?.status === 'completed'), r.reply)
  }

  // —— 返回 / 可见历史 / 续聊最终消息一致 ——
  {
    const calls = []
    let n = 0
    const a = createAssistant({ db, demoUserId: uid, chatFn: async (args) => {
      calls.push(JSON.parse(JSON.stringify(args.messages)))
      n += 1
      if (n === 1) return tool('get_accounts', {}, 'c-consistency')
      return fin('{"kind":"explanation","code":"general_ack"}')
    } })
    const r1 = await a.chat({ message: '查余额' })
    const view = a.getCurrent()
    check('架构：返回与可见历史一致', view.messages.at(-1)?.text === r1.reply && r1.reply.includes('账户信息（服务端核验）'))
    await a.chat({ message: '再说一次', sessionId: r1.sessionId })
    const priorAssistant = (calls[2] || []).filter((m) => m.role === 'assistant').at(-1)
    check('架构：续聊最终 assistant 消息使用同一受信文本', priorAssistant?.content === r1.reply,
      JSON.stringify(priorAssistant?.content)?.slice(0, 120))
  }

  // —— 候选对象只来自已验证工具结果；非法 id 不回显 ——
  {
    const count = db.prepare('SELECT count(*) n FROM transfer_recipients').get().n
    if (count < 2) db.prepare("INSERT INTO transfer_recipients (name, masked_account) VALUES ('李雷','6222 **** 9999')").run()
    let n = 0
    const a = createAssistant({ db, demoUserId: uid,
      chatFn: async () => (++n === 1
        ? tool('list_transfer_recipients', {}, 'c-candidates')
        : fin('{"kind":"clarification","code":"ambiguous_recipient","params":{"ids":[999999]}}')) })
    const r = await a.chat({ message: '收款人选哪个？' })
    check('架构：候选澄清使用工具结果且不回显非法 id',
      r.reply.includes('找到多个匹配的收款人') && !r.reply.includes('999999')
        && (r.reply_blocks || []).some((b) => b.kind === 'recipients'), r.reply)
  }
} catch (e) {
  failures += 1
  console.error('FACT BLOCK TEST ERROR:', e.stack || e.message)
} finally {
  db.close()
  console.log(`\n== 事实保护结构化块验证：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
  process.exit(failures ? 1 : 0)
}
