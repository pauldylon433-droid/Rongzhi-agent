// CloudBase 持久库定向回归：强验证锁定竞态、日累计风险复核、会话合并、时间步残留、样例账期。
// 单连接 PGlite 只能做受控顺序 / 交错；真实多连接并发单独标 SKIP，不冒充通过。
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL = join(HERE, '..', '..', '..', 'cloudbase', 'sql')
const read = (f) => fs.readFileSync(join(SQL, f), 'utf8')

let pass = 0, fail = 0, skip = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  [' + detail + ']' : ''}`) }
}
const skipped = (name, detail = '') => { skip++; console.log(`SKIP  ${name}${detail ? '  [' + detail + ']' : ''}`) }

const db = new PGlite()
let role = 'owner'
async function asOwner() { if (role !== 'owner') { await db.exec('RESET ROLE'); role = 'owner' } }
async function asService() { if (role !== 'service') { await db.exec('SET ROLE service_role'); role = 'service' } }
const ownerRows = async (sql, params = []) => { await asOwner(); return (await db.query(sql, params)).rows }
const ownerOne = async (sql, params = []) => (await ownerRows(sql, params))[0]
const fn = async (name, user, op, payload = {}) => {
  await asService()
  const r = await db.query(`SELECT public.${name}($1::bigint,$2::text,$3::jsonb) r`, [user, op, JSON.stringify(payload)])
  return r.rows[0].r
}
const seed = async (user) => { await asService(); return (await db.query('SELECT public.rongzhi_bank_seed_v1($1::bigint) r', [user])).rows[0].r }

try {
  await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;')
  await db.exec(read('001_schema_v1.sql'))
  await db.exec(read('002_functions_v1.sql'))
  await seed(1)

  // —— 1. 强验证锁定竞态 ——
  await fn('rongzhi_bank_verification_write_v1', 1, 'reset')
  let lockState
  for (let i = 0; i < 5; i++) {
    lockState = await fn('rongzhi_bank_verification_write_v1', 1, 'record_failure')
  }
  const lockedAt = (await ownerOne('SELECT locked_until FROM public.rongzhi_bank_verification_failures WHERE user_id=1')).locked_until
  check('锁定竞态：连续 5 次失败后进入锁定', lockState.locked === true && lockedAt != null)
  const late = await fn('rongzhi_bank_verification_write_v1', 1, 'record_failure')
  const afterLate = await ownerOne('SELECT fail_count, locked_until FROM public.rongzhi_bank_verification_failures WHERE user_id=1')
  check('锁定竞态：晚到失败不清除锁定', late.locked === true
    && new Date(afterLate.locked_until).getTime() === new Date(lockedAt).getTime(), JSON.stringify({ late, afterLate }))
  check('锁定竞态：晚到失败不重置 / 增加计数', Number(afterLate.fail_count) === 0, JSON.stringify(afterLate))

  // 锁定前通过凭据检查、锁定后才提交（受控顺序模拟；真实多连接另标 SKIP）
  const redCreate = await fn('rongzhi_bank_transfer_write_v1', 1, 'create',
    { recipient_id: 1, amount_cents: 120000, from_account_id: 1 })
  const redRef = redCreate.ref_no
  const balanceBeforeBlocked = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=1')).balance_cents)
  const stepsBefore = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=1')).n)
  const blocked = await fn('rongzhi_bank_transfer_write_v1', 1, 'verify', { ref_no: redRef, matched_step: 9001 })
  const redOp = await ownerOne('SELECT status FROM public.rongzhi_bank_transfer_operations WHERE ref_no=$1', [redRef])
  const stepsAfter = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=1')).n)
  const balanceAfterBlocked = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=1')).balance_cents)
  check('锁定竞态：锁定后已通过凭据检查的提交被阻断（outcome=locked）', blocked.outcome === 'locked', JSON.stringify(blocked))
  check('锁定竞态：被阻断单不扣款、不消费时间步', redOp.status === 'needs_verification'
    && stepsAfter === stepsBefore && balanceAfterBlocked === balanceBeforeBlocked, JSON.stringify({ redOp, stepsBefore, stepsAfter, balanceBeforeBlocked, balanceAfterBlocked }))

  // 失败计数原子性（单连接顺序；真实并发标 SKIP）
  await ownerRows('DELETE FROM public.rongzhi_bank_verification_failures WHERE user_id=2')
  await seed(2)
  let seq
  for (let i = 0; i < 4; i++) seq = await fn('rongzhi_bank_verification_write_v1', 2, 'record_failure')
  const four = Number((await ownerOne('SELECT fail_count FROM public.rongzhi_bank_verification_failures WHERE user_id=2')).fail_count)
  check('失败计数：4 次顺序失败计数为 4（单连接）', four === 4 && seq.remaining === 1, JSON.stringify({ four, seq }))
  const failureSrc = (await ownerOne("SELECT prosrc FROM pg_proc WHERE proname='rongzhi_bank_verification_write_v1'")).prosrc
  const guardSrc = (await ownerOne("SELECT prosrc FROM pg_proc WHERE proname='rongzhi_bank_internal_verification_guard'")).prosrc
  check('失败计数 / 锁定复核使用行锁（静态检查）', /FOR UPDATE/.test(failureSrc) && /FOR UPDATE/.test(guardSrc))
  skipped('真实多连接并发失败计数：未执行（PGlite 单连接）')

  // —— 2. 日累计：受控顺序复核（非真实多连接） ——
  await seed(10)
  const expiryAccount = (await ownerRows('SELECT id FROM public.rongzhi_bank_accounts WHERE user_id=10 ORDER BY id'))[0].id
  const expire1 = await fn('rongzhi_bank_transfer_write_v1', 10, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: expiryAccount })
  await ownerRows("UPDATE public.rongzhi_bank_transfer_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE ref_no=$1", [expire1.ref_no])
  const expire2 = await fn('rongzhi_bank_transfer_write_v1', 10, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: expiryAccount })
  check('600 元旧单过期但尚未落库 expired：第二笔仍为黄色', expire2.status === 'pending' && expire2.risk_level === 'yellow')
  const expiredResult = await fn('rongzhi_bank_transfer_write_v1', 10, 'confirm', { ref_no: expire1.ref_no })
  const cancelledResult = await fn('rongzhi_bank_transfer_write_v1', 10, 'cancel', { ref_no: expire2.ref_no })
  const expire3 = await fn('rongzhi_bank_transfer_write_v1', 10, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: expiryAccount })
  check('已过期与已取消单都不占累计额度，新 600 元单仍为黄色', expiredResult.outcome === 'expired' && cancelledResult.outcome === 'cancelled' && expire3.risk_level === 'yellow')
  const oldTx = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_transactions WHERE transfer_ref=ANY($1::text[])', [[expire1.ref_no, expire2.ref_no]])).n)
  const oldBalance = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=$1', [expiryAccount])).balance_cents)
  check('过期、取消和仅建单：余额仍 10000 元，旧单无转账流水', oldTx === 0 && oldBalance === 1000000)
  const completeNew = await fn('rongzhi_bank_transfer_write_v1', 10, 'confirm', { ref_no: expire3.ref_no })
  const afterNew = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=$1', [expiryAccount])).balance_cents)
  check('新 600 元单可普通确认，只有本次完成后余额变为 9400 元', completeNew.outcome === 'completed' && afterNew === 940000)
  await seed(3)
  const acct = (await ownerRows('SELECT id FROM public.rongzhi_bank_accounts WHERE user_id=3 ORDER BY id'))[0].id
  const t1 = await fn('rongzhi_bank_transfer_write_v1', 3, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: acct })
  const t2 = await fn('rongzhi_bank_transfer_write_v1', 3, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: acct })
  check('日累计（同账户）：两单建单时均为黄色', t1.status === 'pending' && t2.status === 'pending')
  const c1 = await fn('rongzhi_bank_transfer_write_v1', 3, 'confirm', { ref_no: t1.ref_no })
  const c2 = await fn('rongzhi_bank_transfer_write_v1', 3, 'confirm', { ref_no: t2.ref_no })
  const acctAfter = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=$1', [acct])).balance_cents)
  check('日累计（同账户）：第二单完成后复核升级为强验证', c1.outcome === 'completed' && c2.outcome === 'needs_verification', JSON.stringify({ c1, c2 }))
  const t2Status = (await ownerOne('SELECT status FROM public.rongzhi_bank_transfer_operations WHERE ref_no=$1', [t2.ref_no])).status
  const t2Tx = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_transactions WHERE transfer_ref=$1', [t2.ref_no])).n)
  check('日累计（同账户）：只扣第一单，第二单无流水', acctAfter === 1000000 - 60000 && t2Status === 'needs_verification' && t2Tx === 0,
    JSON.stringify({ acctAfter, t2Status, t2Tx }))

  await seed(4)
  const dep = await ownerRows('SELECT id FROM public.rongzhi_bank_accounts WHERE user_id=4 AND account_type=\'deposit\' ORDER BY id')
  const t3 = await fn('rongzhi_bank_transfer_write_v1', 4, 'create', { recipient_id: 1, amount_cents: 60000, from_account_id: dep[0].id })
  const t4 = await fn('rongzhi_bank_transfer_write_v1', 4, 'create', { recipient_id: 2, amount_cents: 60000, from_account_id: dep[1].id })
  const c3 = await fn('rongzhi_bank_transfer_write_v1', 4, 'confirm', { ref_no: t3.ref_no })
  const c4 = await fn('rongzhi_bank_transfer_write_v1', 4, 'confirm', { ref_no: t4.ref_no })
  const dep2After = Number((await ownerOne('SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=$1', [dep[1].id])).balance_cents)
  const t4Status = (await ownerOne('SELECT status FROM public.rongzhi_bank_transfer_operations WHERE ref_no=$1', [t4.ref_no])).status
  const t4Tx = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_transactions WHERE transfer_ref=$1', [t4.ref_no])).n)
  check('日累计（不同付款账户）：第二单升级为强验证且未扣款 / 无流水',
    c3.outcome === 'completed' && c4.outcome === 'needs_verification'
    && dep2After === 250000 && t4Status === 'needs_verification' && t4Tx === 0,
    JSON.stringify({ c3, c4, dep2After, t4Status, t4Tx }))
  skipped('真实多连接两单竞争（同账户 / 不同账户）：未执行，不能由单连接 PGlite 冒充')
  const lockCalls = Number((await ownerOne(`SELECT (length(prosrc) - length(replace(prosrc,'rongzhi_bank_internal_transfer_user_lock',''))) / length('rongzhi_bank_internal_transfer_user_lock') n
    FROM pg_proc WHERE proname='rongzhi_bank_transfer_write_v1'`)).n)
  check('日累计：创建 / 确认 / 验证路径均接入用户级 advisory lock（静态检查）', lockCalls >= 3, String(lockCalls))

  // —— 3. 会话保存：版本合并 + 重复提交 ——
  await seed(5)
  const u = (text) => ({ role: 'user', content: text })
  const a = (text) => ({ role: 'assistant', content: text })
  const sid = 'race-chat-1'
  const s1 = await fn('rongzhi_bank_chat_write_v1', 5, 'save_turn', {
    session_id: sid, turn_id: 't1', base_version: 0,
    messages: [u('第一轮'), a('回复一')], new_messages: [u('第一轮'), a('回复一')],
    user_text: '第一轮', reply: '回复一', tool_records: [], incomplete: false, pointer_at_start: null,
  })
  const s2 = await fn('rongzhi_bank_chat_write_v1', 5, 'save_turn', {
    session_id: sid, turn_id: 't2', base_version: s1.session_version,
    messages: [u('第一轮'), a('回复一'), u('第二轮'), a('回复二')], new_messages: [u('第二轮'), a('回复二')],
    user_text: '第二轮', reply: '回复二', tool_records: [], incomplete: false, pointer_at_start: sid,
  })
  const stale = await fn('rongzhi_bank_chat_write_v1', 5, 'save_turn', {
    session_id: sid, turn_id: 't3', base_version: 1,
    messages: [u('第一轮'), a('回复一'), u('第三轮旧上下文'), a('回复三')], new_messages: [u('第三轮旧上下文'), a('回复三')],
    user_text: '第三轮旧上下文', reply: '回复三', tool_records: [], incomplete: false, pointer_at_start: sid,
  })
  const savedRow = await ownerOne('SELECT messages_json, version FROM public.rongzhi_bank_chat_sessions WHERE id=$1', [sid])
  const context = JSON.stringify(savedRow.messages_json)
  check('会话保存：旧版本写入不覆盖已完成轮次（返回 merged + 合并上下文）', stale.outcome === 'merged'
    && Array.isArray(stale.messages) && stale.messages.length === 6, JSON.stringify(stale))
  check('会话保存：模型上下文保留第一 / 第二 / 第三轮', context.includes('第一轮') && context.includes('第二轮') && context.includes('第三轮旧上下文')
    && Number(savedRow.version) === 3, context)
  const duplicate = await fn('rongzhi_bank_chat_write_v1', 5, 'save_turn', {
    session_id: sid, turn_id: 't3', base_version: 1,
    messages: [u('第一轮'), a('回复一'), u('第三轮旧上下文'), a('回复三')], new_messages: [u('第三轮旧上下文'), a('回复三')],
    user_text: '第三轮旧上下文', reply: '回复三', tool_records: [], incomplete: false, pointer_at_start: sid,
  })
  const visible = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_chat_messages WHERE session_id=$1', [sid])).n)
  check('会话保存：重复 turn_id 不重复写可见消息', duplicate.outcome === 'duplicate' && visible === 6
    && Array.isArray(duplicate.messages) && duplicate.messages.length === 6, JSON.stringify({ duplicate, visible }))
  const delayedDuplicate = await fn('rongzhi_bank_chat_write_v1', 5, 'save_turn', {
    session_id: sid, turn_id: 't2', base_version: 1,
    messages: [u('第一轮'), a('回复一'), u('第二轮'), a('回复二')],
    new_messages: [u('第二轮'), a('回复二')],
    user_text: '第二轮', reply: '回复二', tool_records: [], incomplete: false, pointer_at_start: sid,
  })
  check('会话保存：较早轮次重试不重复合并模型上下文', delayedDuplicate.outcome === 'duplicate'
    && delayedDuplicate.messages.length === 6 && Number(delayedDuplicate.session_version) === 3,
    JSON.stringify(delayedDuplicate))
  const repaySrc = (await ownerOne("SELECT prosrc FROM pg_proc WHERE proname='rongzhi_bank_repay_write_v1'")).prosrc
  const verifyPart = repaySrc.split("ELSIF p_op = 'verify' THEN")[1]
  check('还款与转账付款账户 / 验证行锁顺序一致（静态检查）',
    verifyPart.indexOf('SELECT * INTO v_from') < verifyPart.indexOf('rongzhi_bank_internal_verification_guard'))
  const state = await ownerOne('SELECT current_session_id FROM public.rongzhi_bank_chat_state WHERE user_id=5')
  check('会话保存：当前会话指针保持一致', state && state.current_session_id === sid)
  skipped('真实并发会话保存（两个同时在途请求）：未执行（单连接受控交错）')

  // —— 4. 业务失效不残留时间步（卡 / 转账 / 订阅 / 还款） ——
  await seed(6)
  const card = await ownerOne('SELECT id, version FROM public.rongzhi_bank_cards WHERE user_id=6 AND card_type=\'借记卡\' ORDER BY id LIMIT 1')
  const freeze = await fn('rongzhi_bank_card_write_v1', 6, 'create', { card_id: card.id, action: 'freeze' })
  await fn('rongzhi_bank_card_write_v1', 6, 'confirm', { ref_no: freeze.ref_no })
  const unfreeze1 = await fn('rongzhi_bank_card_write_v1', 6, 'create', { card_id: card.id, action: 'unfreeze' })
  const unfreeze2 = await fn('rongzhi_bank_card_write_v1', 6, 'create', { card_id: card.id, action: 'unfreeze' })
  const okUnfreeze = await fn('rongzhi_bank_card_write_v1', 6, 'verify', { ref_no: unfreeze1.ref_no, matched_step: 7001 })
  const staleUnfreeze = await fn('rongzhi_bank_card_write_v1', 6, 'verify', { ref_no: unfreeze2.ref_no, matched_step: 7002 })
  const step7002 = await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=6 AND step=7002')
  const audit7002 = await ownerOne("SELECT result FROM public.rongzhi_bank_audit_logs WHERE operation_ref=$1 AND action='verify_failed'", [unfreeze2.ref_no])
  check('卡操作 stale：第一张成功、第二张 stale', okUnfreeze.outcome === 'completed' && staleUnfreeze.outcome === 'stale', JSON.stringify({ okUnfreeze, staleUnfreeze }))
  check('卡操作 stale：失败单不残留验证码时间步', Number(step7002.n) === 0)
  check('卡操作 stale：保留失效审计', audit7002 && audit7002.result === 'stale')

  await seed(7)
  const tRed = await fn('rongzhi_bank_transfer_write_v1', 7, 'create', { recipient_id: 1, amount_cents: 120000, from_account_id: (await ownerOne('SELECT id FROM public.rongzhi_bank_accounts WHERE user_id=7 AND account_type=\'deposit\' LIMIT 1')).id })
  await ownerRows('UPDATE public.rongzhi_bank_transfer_operations SET expires_at=clock_timestamp()-interval \'1 second\' WHERE ref_no=$1', [tRed.ref_no])
  const tExpired = await fn('rongzhi_bank_transfer_write_v1', 7, 'verify', { ref_no: tRed.ref_no, matched_step: 7101 })
  const step7101 = await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=7 AND step=7101')
  check('转账 expired：验证返回 expired 且不消费时间步', tExpired.outcome === 'expired' && Number(step7101.n) === 0, JSON.stringify(tExpired))

  await seed(8)
  const pausedSub = await ownerOne("SELECT id, version FROM public.rongzhi_bank_subscriptions WHERE user_id=8 AND status='paused' LIMIT 1")
  const resume = await fn('rongzhi_bank_sub_write_v1', 8, 'create', { subscription_id: pausedSub.id, action: 'resume' })
  await ownerRows('UPDATE public.rongzhi_bank_subscriptions SET version=version+1 WHERE id=$1', [pausedSub.id])
  const staleResume = await fn('rongzhi_bank_sub_write_v1', 8, 'verify', { ref_no: resume.ref_no, matched_step: 7201 })
  const step7201 = await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=8 AND step=7201')
  check('订阅 stale：验证返回 stale 且不消费时间步', staleResume.outcome === 'stale' && Number(step7201.n) === 0, JSON.stringify(staleResume))

  await seed(9)
  const dep9 = await ownerOne('SELECT id FROM public.rongzhi_bank_accounts WHERE user_id=9 AND account_type=\'deposit\' LIMIT 1')
  const repay = await fn('rongzhi_bank_repay_write_v1', 9, 'create', { scope: 'all_posted', from_account_id: dep9.id })
  const stmt9 = await ownerOne('SELECT id FROM public.rongzhi_bank_statements WHERE user_id=9 ORDER BY id DESC LIMIT 1')
  await ownerRows('UPDATE public.rongzhi_bank_statements SET version=version+1 WHERE id=$1', [stmt9.id])
  const staleRepay = await fn('rongzhi_bank_repay_write_v1', 9, 'verify', { ref_no: repay.ref_no, matched_step: 7301 })
  const step7301 = await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_totp_used_steps WHERE user_id=9 AND step=7301')
  check('还款 stale：验证返回 stale 且不消费时间步', staleRepay.outcome === 'stale' && Number(step7301.n) === 0, JSON.stringify(staleRepay))

  // —— 5. 样例账期 ——
  const stmts = await ownerRows('SELECT * FROM public.rongzhi_bank_statements WHERE user_id=1 ORDER BY statement_year, statement_month')
  check('样例账期：三张账单（已结清 / 已出账未还 / 未出账）', stmts.length === 3
    && stmts.filter((x) => x.issued_at != null).length === 2 && stmts.filter((x) => x.issued_at == null).length === 1)
  const [aug, sep, oct] = stmts
  const creditTx = await ownerRows("SELECT * FROM public.rongzhi_bank_transactions WHERE user_id=1 AND account_id=(SELECT account_id FROM public.rongzhi_bank_credit_accounts WHERE user_id=1) ORDER BY posted_at")
  const augTx = creditTx.find((t) => t.amount_cents === 50000)
  const sepTx = creditTx.find((t) => t.amount_cents === 120000)
  const octTx = creditTx.find((t) => t.amount_cents === 30000 && t.status === 'posted')
  const inPeriod = (t, s) => t && Date.parse(t.posted_at) >= Date.parse(s.period_start) && Date.parse(t.posted_at) < Date.parse(s.period_end)
  check('样例账期：已结清账单金额 / 已还 / 入账归属一致',
    Number(aug.new_charges_cents) === 50000 && Number(aug.paid_cents) === 50000 && inPeriod(augTx, aug)
    && Date.parse(augTx.posted_at) < Date.parse(aug.issued_on))
  check('样例账期：已出账未还账单金额 / 未还 / 消费早于出账',
    Number(sep.new_charges_cents) === 120000 && Number(sep.paid_cents) === 0 && inPeriod(sepTx, sep)
    && Date.parse(sepTx.posted_at) < Date.parse(sep.issued_at))
  check('样例账期：未出账账单金额 / issued_at 为空 / 消费在账期内',
    Number(oct.new_charges_cents) === 30000 && oct.issued_at == null && inPeriod(octTx, oct)
    && Date.parse(octTx.posted_at) < Date.parse(oct.issued_on))
  const ca = await ownerOne('SELECT posted_outstanding_cents, pending_occupied_cents FROM public.rongzhi_bank_credit_accounts WHERE user_id=1')
  check('样例账期：信用账户欠款 / 待入账与账单一致',
    Number(ca.posted_outstanding_cents) === 150000 && Number(ca.pending_occupied_cents) === 30000, JSON.stringify(ca))
  const seedAgain = await seed(1)
  const countAgain = Number((await ownerOne('SELECT count(*) n FROM public.rongzhi_bank_statements WHERE user_id=1')).n)
  check('样例账期：重复 seed 幂等且不重置', seedAgain.seeded === false && countAgain === 3, JSON.stringify(seedAgain))
} catch (e) {
  fail++
  console.error('RACE HARNESS ERROR:', e.stack || e.message)
} finally {
  await db.close()
  console.log(`\n== CloudBase 定向回归：PASS ${pass} / FAIL ${fail} / SKIP ${skip} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
