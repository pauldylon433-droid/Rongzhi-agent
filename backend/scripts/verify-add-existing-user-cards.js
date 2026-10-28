// 验证：为「现有用户」增量接入第二张借记卡 + 信用卡，在独立种子库上证明：
//   1) 原账户余额 / 历史交易 / 会话 / 操作单 / 验证绑定逐条保留（只 INSERT，不 UPDATE/DELETE 已有数据）；
//   2) 基础加卡与样例消费分离（加卡不灌消费/欠款）；
//   3) 重复执行幂等（不重复创建账户 / 卡片 / 消费 / 账单）。
//
// 使用独立临时种子库（initDatabase seed:true），不依赖开发库当前是否已加过多卡；
// 全部写操作发生在临时库上，不修改开发库、不调用收费模型。
// 用法：node scripts/verify-add-existing-user-cards.js
import { initDatabase } from '../src/db/index.js'
import { applyBaseCards, applyConsumption, resolveUser, snapshot, buildPlan, MARKER } from './add-existing-user-cards.js'
import { rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = join(tmpdir(), 'rongzhi-add-cards-drill')
const COPY = join(WORK, 'seed.db')

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}
function wipe(p) { for (const x of [p, p + '-wal', p + '-shm']) { try { rmSync(x, { force: true }) } catch {} } }

// 1. 独立临时种子库（1 用户 / 1 活期账户 / 1 借记卡）
mkdirSync(WORK, { recursive: true })
for (const p of [COPY, COPY + '-wal', COPY + '-shm']) wipe(p)
const { db } = initDatabase({ dbPath: COPY, seed: true })
check('独立种子库已生成', true, COPY)

// 2. 按 id 核验目标用户
const userId = 1
const user = resolveUser(db, userId)
check('按 id 核验目标用户', user.id === userId && user.name === '张三', `id=${user.id} name=${user.name}`)

// 3. 迁移后、加卡前快照
const before = snapshot(db, userId)
const beforeAccounts = before.accounts.map((a) => `${a.id}:${a.account_name}:${a.balance_cents}`).join('|')
check('副本旧账户存在（迁移未破坏）', before.accounts.length >= 1, `${before.accounts.length} 账户`)
const beforePlan = buildPlan(db, userId)
check('加卡前目标卡片/消费均不存在', !beforePlan.hasDebitCard && !beforePlan.hasCreditCard && !beforePlan.hasConsumption)

// 4. 基础加卡（--apply，不加消费）
const res1 = applyBaseCards(db, userId)
check('新增第二借记卡 + 账户', res1.addedDebit === true, `account_id=${res1.debitAccountId}`)
check('新增信用卡 + 信用账户', res1.addedCredit === true, `credit_account_id=${res1.creditCaId}`)

const mid = snapshot(db, userId)
check('基础加卡后：账户 +2、卡片 +2', mid.accounts.length === before.accounts.length + 2 && mid.cards.length === before.cards.length + 2, `${before.accounts.length}→${mid.accounts.length} 账户`)
check('基础加卡后：流水数不变（未灌消费）', mid.tx.c === before.tx.c, `流水 ${before.tx.c}→${mid.tx.c}`)
check('原账户余额逐条保留（加卡不改旧余额）', before.accounts.every((a) => mid.accounts.some((m) => m.id === a.id && m.account_name === a.account_name && m.balance_cents === a.balance_cents)), before.accounts.map((a) => a.balance_cents).join(','))
check('新借记账户余额 = 初始余额', mid.accounts.some((m) => m.account_name === MARKER.debitAccountName && m.balance_cents === MARKER.debitOpeningCents), `${MARKER.debitOpeningCents}`)
check('新信用账户 balance 恒为 0', mid.accounts.some((m) => m.account_name === MARKER.creditAccountName && m.balance_cents === 0))
const newDebitCard = mid.cards.find((c) => c.masked_card_number === MARKER.debitCardMasked)
const newCreditCard = mid.cards.find((c) => c.masked_card_number === MARKER.creditCardMasked)
check('新借记卡已建（明确标识）', !!newDebitCard && newDebitCard.card_type === '借记卡')
check('新信用卡已建（明确标识）', !!newCreditCard && newCreditCard.card_type === '信用卡')

// 5. 重复加卡 → 幂等
const res2 = applyBaseCards(db, userId)
const mid2 = snapshot(db, userId)
check('重复加卡返回「未新增」（幂等）', res2.addedDebit === false && res2.addedCredit === false)
check('重复加卡后账户/卡片数不变', mid2.accounts.length === mid.accounts.length && mid2.cards.length === mid.cards.length, `${mid2.accounts.length} 账户 / ${mid2.cards.length} 卡`)

// 6. 会话 / 操作单 / 验证绑定不受加卡影响
const convCounts = before.counts
const convMid = mid2.counts
check('加卡不改会话/操作单/验证绑定', JSON.stringify(convCounts) === JSON.stringify(convMid), JSON.stringify(convMid))

// 7. 样例消费（分离，仅 --with-consumption）
const cons1 = applyConsumption(db, userId, res1.creditCaId)
check('样例消费已新增', cons1.added === true, `${cons1.count} 笔`)
const afterCons = snapshot(db, userId)
check('样例消费后：流水 +4', afterCons.tx.c === before.tx.c + 4, `流水 ${before.tx.c}→${afterCons.tx.c}`)
const creditAcctId = db.prepare('SELECT account_id FROM credit_accounts WHERE id = ?').get(res1.creditCaId).account_id
const stmts = db.prepare('SELECT COUNT(*) c FROM statements WHERE credit_account_id = ?').get(res1.creditCaId).c
const outstanding = db.prepare('SELECT posted_outstanding_cents o, pending_occupied_cents p FROM credit_accounts WHERE id = ?').get(res1.creditCaId)
check('样例消费生成账单（出账 + 未出账）', stmts >= 2, `${stmts} 张账单`)
check('样例消费产生已入账未还 + 待入账占额', outstanding.o > 0 && outstanding.p > 0, `outstanding=${outstanding.o} pending=${outstanding.p}`)
check('样例消费不改变旧账户余额', before.accounts.every((a) => afterCons.accounts.some((m) => m.id === a.id && m.balance_cents === a.balance_cents)))

// 8. 重复消费 → 幂等
const cons2 = applyConsumption(db, userId, res1.creditCaId)
const afterCons2 = snapshot(db, userId)
check('重复样例消费跳过（幂等）', cons2.added === false)
check('重复消费后流水数不变', afterCons2.tx.c === afterCons.tx.c, `${afterCons2.tx.c} 笔`)

// 9. 完整性 + 外键
const ic = db.pragma('integrity_check')
const fk = db.pragma('foreign_key_check')
check('副本 integrity_check = ok', Array.isArray(ic) && ic.length === 1 && ic[0].integrity_check === 'ok', JSON.stringify(ic))
check('副本 foreign_key_check 无违例', Array.isArray(fk) && fk.length === 0, `${fk.length} 处违例`)

db.close()
// 清理临时副本
for (const p of [COPY, COPY + '-wal', COPY + '-shm']) wipe(p)

console.log(failures === 0 ? '\n增量加卡副本验证全部通过 ✅（开发库未改动）' : `\n存在 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
