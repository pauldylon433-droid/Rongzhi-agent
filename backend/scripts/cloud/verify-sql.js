// CloudBase 持久库 SQL 级验证（PGlite）：安装幂等、权限、事务回滚、审计、清理。
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL = join(HERE, '..', '..', '..', 'cloudbase', 'sql')
const read = (f) => fs.readFileSync(join(SQL, f), 'utf8')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  [' + detail + ']' : ''}`) }
}
const db = new PGlite()
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await q(sql, params))[0]
const expectDenied = async (sql, name) => {
  try { await db.query(sql); check(name, false, '未拒绝') }
  catch (e) { check(name, e.code === '42501', `code=${e.code}`) }
}

try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;`)
  // 与项目无关的“慧眼”对象：验证安装脚本不会改动其它 public 对象权限。
  await db.exec(`CREATE TABLE public.hyeye_probe(id int primary key); INSERT INTO public.hyeye_probe VALUES (1);
    GRANT SELECT ON public.hyeye_probe TO anon;`)

  await db.exec(read('001_schema_v1.sql'))
  await db.exec(read('002_functions_v1.sql'))
  check('001/002 安装成功', true)

  // 幂等重跑
  await db.exec(read('001_schema_v1.sql'))
  await db.exec(read('002_functions_v1.sql'))
  check('001/002 可重复执行（结构 / 函数幂等）', true)
  await db.exec(read('010_upgrade_v1_1.sql'))
  await db.exec(read('010_upgrade_v1_1.sql'))
  const chatCols = await q(`SELECT column_name FROM information_schema.columns
    WHERE table_name='rongzhi_bank_chat_sessions' AND column_name IN ('version','last_turn_id')`)
  const msgTurn = await q(`SELECT column_name FROM information_schema.columns
    WHERE table_name='rongzhi_bank_chat_messages' AND column_name='turn_id'`)
  check('010 升级可重复执行且包含会话版本列', chatCols.length === 2 && msgTurn.length === 1)

  const dummyAcl = await one(`SELECT has_table_privilege('anon','public.hyeye_probe','SELECT') AS ok`)
  check('安装不修改无关项目对象权限（hyeye_probe 仍可 SELECT）', dummyAcl.ok === true)
  check('无关项目表仍存在', (await one(`SELECT count(*)::int n FROM public.hyeye_probe`)).n === 1)

  await db.exec('SET ROLE service_role')
  const seed1 = (await one('SELECT public.rongzhi_bank_seed_v1(1) r')).r
  const countFrom = (snap) => ({ accounts: snap.accounts.length, tx: snap.transactions.length, cards: snap.cards.length, subs: snap.subscriptions.length })
  const counts1 = countFrom((await one('SELECT public.rongzhi_bank_snapshot_v1(1) s')).s)
  const seed2 = (await one('SELECT public.rongzhi_bank_seed_v1(1) r')).r
  const counts2 = countFrom((await one('SELECT public.rongzhi_bank_snapshot_v1(1) s')).s)
  check('演示数据首次初始化', seed1.seeded === true && seed1.verification_bound === false, JSON.stringify(seed1))
  check('演示数据第二次调用不重置 / 不重复写入', seed2.seeded === false && JSON.stringify(counts1) === JSON.stringify(counts2), JSON.stringify({ counts1, counts2 }))

  // 函数安全配置
  const fns = await q(`SELECT p.oid::regprocedure::text sig, p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'rongzhi_bank_%' ORDER BY p.proname`)
  check('全部业务函数 SECURITY DEFINER', fns.filter((f) => !f.sig.includes('internal_')).every((f) => f.prosecdef === true))
  check('全部业务函数固定 search_path=pg_catalog, pg_temp',
    fns.every((f) => Array.isArray(f.proconfig) && f.proconfig.includes('search_path=pg_catalog, pg_temp')),
    JSON.stringify(fns.filter((f) => !f.proconfig || !f.proconfig.includes('search_path=pg_catalog, pg_temp')).map((f) => f.sig)))

  // 精确签名
  const required = [
    'rongzhi_bank_snapshot_v1(bigint)', 'rongzhi_bank_verification_secret_v1(bigint)',
    'rongzhi_bank_health_v1()', 'rongzhi_bank_transfer_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_card_write_v1(bigint,text,jsonb)', 'rongzhi_bank_sub_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_repay_write_v1(bigint,text,jsonb)', 'rongzhi_bank_chat_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_verification_write_v1(bigint,text,jsonb)', 'rongzhi_bank_task_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_audit_event_v1(bigint,text,jsonb)', 'rongzhi_bank_plan_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_security_write_v1(bigint,text,jsonb)', 'rongzhi_bank_audit_query_v1(bigint,text,jsonb)',
    'rongzhi_bank_seed_v1(bigint)',
  ]
  const sigs = fns.map((f) => f.sig.replace(/^public\./, ''))
  check('固定 RPC 白名单签名完整', required.every((s) => sigs.includes(s)), sigs.join(' | '))
  const extraTables = await q(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('rongzhi_bank_audit_events','rongzhi_bank_workflow_plans')`)
  check('审计 / 工作流计划表已创建', extraTables.length === 2, JSON.stringify(extraTables))

  // 权限：service_role 可执行，不能直接读写业务表；内部函数不可执行
  for (const [sig, label] of [['rongzhi_bank_snapshot_v1(bigint)', '快照'], ['rongzhi_bank_transfer_write_v1(bigint,text,jsonb)', '转账写']]) {
    const r = await one(`SELECT has_function_privilege('service_role',$1,'EXECUTE') ok`, [`public.${sig}`])
    check(`service_role 可执行：${label}`, r.ok === true)
  }
  await expectDenied(`SELECT * FROM public.rongzhi_bank_accounts LIMIT 1`, 'service_role 不能直接读取业务表')
  await expectDenied(`UPDATE public.rongzhi_bank_accounts SET balance_cents=balance_cents`, 'service_role 不能直接写业务表')
  await expectDenied(`SELECT public.rongzhi_bank_internal_pos_bigint('{}'::jsonb,'x')`, '内部辅助函数不对 service_role 开放')

  // 事务回滚：审计写入后注入异常，业务写入必须全部回滚
  await db.exec('RESET ROLE')
  const acctBefore = (await one(`SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=1`)).balance_cents
  await db.exec('SET ROLE service_role')
  const created = (await one(`SELECT public.rongzhi_bank_transfer_write_v1(1,'create',$1::jsonb) r`,
    [JSON.stringify({ recipient_id: 1, amount_cents: 50000, from_account_id: 1 })])).r
  await db.exec('RESET ROLE')
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.__test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation_ref = current_setting('test.fail_ref', true) THEN
        RAISE EXCEPTION 'injected_failure_after_writes' USING ERRCODE = 'P0002';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS __test_fail_audit ON public.rongzhi_bank_audit_logs;
    CREATE TRIGGER __test_fail_audit BEFORE INSERT ON public.rongzhi_bank_audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.__test_fail_audit();
  `)
  await db.query("SELECT set_config('test.fail_ref',$1,false)", [created.ref_no])
  await db.exec('SET ROLE service_role')
  let rollbackErr = null
  try {
    await db.query(`SELECT public.rongzhi_bank_transfer_write_v1(1,'confirm',$1::jsonb)`,
      [JSON.stringify({ ref_no: created.ref_no })])
  } catch (e) { rollbackErr = e }
  await db.exec('RESET ROLE')
  const afterRb = await one(`SELECT
    (SELECT status FROM public.rongzhi_bank_transfer_operations WHERE ref_no=$1) status,
    (SELECT balance_cents FROM public.rongzhi_bank_accounts WHERE id=1) balance,
    (SELECT count(*)::int FROM public.rongzhi_bank_transactions WHERE transfer_ref=$1) tx,
    (SELECT count(*)::int FROM public.rongzhi_bank_audit_logs WHERE operation_ref=$1 AND action='confirm') audit`,
    [created.ref_no])
  check('审计阶段异常以 P0002 失败', rollbackErr && rollbackErr.code === 'P0002', rollbackErr && rollbackErr.code)
  check('异常后操作单 / 余额 / 流水 / 审计全部回滚', afterRb.status === 'pending'
    && afterRb.balance === acctBefore && afterRb.tx === 0 && afterRb.audit === 0, JSON.stringify(afterRb))
  await db.exec('RESET ROLE')
  await db.exec(`DROP TRIGGER __test_fail_audit ON public.rongzhi_bank_audit_logs;
    DROP FUNCTION public.__test_fail_audit(); SELECT set_config('test.fail_ref','',false);`)

  // P1-09：审计查询按数据库条件过滤 / 分页，超过快照 2000 条的旧事件仍可按编号查到
  await db.exec('RESET ROLE')
  await db.query(`INSERT INTO public.rongzhi_bank_audit_events (event_id,user_id,request_id,category,action)
                  VALUES ('old-marker',1,'req-marker','test','old_event')`)
  await db.query(`INSERT INTO public.rongzhi_bank_audit_events (event_id,user_id,request_id,category,action)
                  SELECT gen_random_uuid()::text || g, 1, 'req-flood', 'test', 'flood' FROM generate_series(1,2050) g`)
  await db.exec('SET ROLE service_role')
  const aqOld = (await one(`SELECT public.rongzhi_bank_audit_query_v1(1,'query',$1::jsonb) r`,
    [JSON.stringify({ event_id: 'old-marker' })])).r
  const aqFlood = (await one(`SELECT public.rongzhi_bank_audit_query_v1(1,'query',$1::jsonb) r`,
    [JSON.stringify({ request_id: 'req-flood', limit: 5, offset: 0 })])).r
  check('审计查询：超过 2000 条后仍可按 event_id 查到旧事件',
    aqOld.total === 1 && aqOld.rows.length === 1 && aqOld.rows[0].event_id === 'old-marker', JSON.stringify(aqOld))
  check('审计查询：按 request_id 过滤且分页正确（total=2050 / 返回 5）',
    aqFlood.total === 2050 && aqFlood.rows.length === 5, JSON.stringify({ total: aqFlood.total, rows: aqFlood.rows.length }))

  // P1-05：云端可疑锁定状态原子计数 / 到期判断（独立于审计列表）
  const secRecord = async () => (await one(`SELECT public.rongzhi_bank_security_write_v1(1,'record',$1::jsonb) r`,
    [JSON.stringify({ scope_key: 'ip-sql', kind: 'anomaly_test', window_ms: 60000, threshold: 2, lock_ms: 60000 })])).r
  const s1 = await secRecord()
  const s2 = await secRecord()
  const sCheck = (await one(`SELECT public.rongzhi_bank_security_write_v1(1,'check',$1::jsonb) r`,
    [JSON.stringify({ scope_key: 'ip-sql' })])).r
  check('云端锁定：阈值内不锁定，达到阈值即锁定',
    s1.locked === false && s1.count === 1 && s2.locked === true && s2.locked_until, JSON.stringify({ s1, s2 }))
  check('云端锁定：check 在截止时间内返回禁止', sCheck.allowed === false && sCheck.locked_until, JSON.stringify(sCheck))
  await db.exec('RESET ROLE')
  await db.query(`UPDATE public.rongzhi_bank_security_scope_state SET locked_until_ms = 0, window_start_ms = 0 WHERE scope_key='ip-sql'`)
  await db.exec('SET ROLE service_role')
  const sAfter = (await one(`SELECT public.rongzhi_bank_security_write_v1(1,'check',$1::jsonb) r`,
    [JSON.stringify({ scope_key: 'ip-sql' })])).r
  check('云端锁定：到期后可恢复', sAfter.allowed === true, JSON.stringify(sAfter))

  // P1-02：计划选择 / 生命周期变更在单事务内做版本 CAS + 建单 / 取消，失败不留孤单
  {
    const planNo = 'wf-sql-test-1'
    const planJson = { plan_no: planNo, flow: 'subscription_review', status: 'waiting_selection',
      params: { month: '2026-10' }, nodes: [], op_ref: null }
    await db.exec('RESET ROLE')
    const subRow = (await one(`SELECT id FROM public.rongzhi_bank_subscriptions WHERE user_id=1 AND status='active' ORDER BY id LIMIT 1`))
    await db.exec('SET ROLE service_role')
    await one(`SELECT public.rongzhi_bank_plan_write_v1(1,'create',$1::jsonb) r`,
      [JSON.stringify({ plan_no: planNo, flow: 'subscription_review', status: 'waiting_selection', plan_json: planJson })])
    const preview = { ...planJson, status: 'waiting_confirmation', op_ref: 'wf-sql-test-1-v0-sub',
      nodes: [{ key: 'prepare_subscription', type: 'mutation', status: 'completed', depends_on: [],
        result: { ref_no: 'wf-sql-test-1-v0-sub', status: 'pending' }, error: null }] }
    const selPayload = { plan_no: planNo, base_version: 0, flow: 'subscription_review',
      status: 'waiting_confirmation', plan_json: preview,
      op_payload: { subscription_id: Number(subRow.id), action: 'pause', ref_no: 'wf-sql-test-1-v0-sub' } }
    const sel1 = (await one(`SELECT public.rongzhi_bank_plan_write_v1(1,'select',$1::jsonb) r`, [JSON.stringify(selPayload)])).r
    const sel2 = (await one(`SELECT public.rongzhi_bank_plan_write_v1(1,'select',$1::jsonb) r`, [JSON.stringify(selPayload)])).r
    await db.exec('RESET ROLE')
    const opCount = (await one(`SELECT count(*)::int n FROM public.rongzhi_bank_subscription_operations WHERE ref_no='wf-sql-test-1-v0-sub'`)).n
    await db.exec('SET ROLE service_role')
    check('云端计划：并发/重试选择由版本 CAS 拒绝，且只创建一个关联单',
      sel1.version === 1 && sel2.conflict === true && opCount === 1, JSON.stringify({ sel1: sel1.version, sel2, opCount }))

    const transPayload = { plan_no: planNo, base_version: 1, flow: 'subscription_review', status: 'paused',
      plan_json: { ...preview, status: 'paused' }, completed_at: null, cancel_ref: 'wf-sql-test-1-v0-sub' }
    const t1 = (await one(`SELECT public.rongzhi_bank_plan_write_v1(1,'transition',$1::jsonb) r`, [JSON.stringify(transPayload)])).r
    const t2 = (await one(`SELECT public.rongzhi_bank_plan_write_v1(1,'transition',$1::jsonb) r`, [JSON.stringify(transPayload)])).r
    await db.exec('RESET ROLE')
    const opStatus = (await one(`SELECT status FROM public.rongzhi_bank_subscription_operations WHERE ref_no='wf-sql-test-1-v0-sub'`)).status
    check('云端计划：生命周期变更与取消单同事务，重复请求因版本冲突被拒',
      t1.version === 2 && t1.status === 'paused' && t2.conflict === true && opStatus === 'cancelled',
      JSON.stringify({ t1: t1.version, t2, opStatus }))
  }

  // anon / authenticated 不能执行 RPC 或访问业务表
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`)
    await expectDenied(`SELECT public.rongzhi_bank_snapshot_v1(1)`, `${role} 不能执行快照 RPC`)
    await expectDenied(`SELECT public.rongzhi_bank_transfer_write_v1(1,'create','{}'::jsonb)`, `${role} 不能执行写 RPC`)
    await expectDenied(`SELECT * FROM public.rongzhi_bank_accounts`, `${role} 不能读取业务表`)
    await expectDenied(`INSERT INTO public.rongzhi_bank_accounts(user_id,account_name,balance_cents) VALUES (1,'x',0)`, `${role} 不能写入业务表`)
    await db.exec('RESET ROLE')
  }

  // 清理：只删除本项目对象
  await db.exec(read('999_cleanup_v1.sql'))
  const left = await one(`SELECT
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'rongzhi_bank_%') fns,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'rongzhi_bank_%') objs`)
  check('cleanup 删除全部本项目函数 / 表', left.fns === 0 && left.objs === 0, JSON.stringify(left))
  check('cleanup 不删除无关项目对象', (await one(`SELECT count(*)::int n FROM public.hyeye_probe`)).n === 1)
} catch (e) {
  fail++
  console.error('SQL HARNESS ERROR:', e.stack || e.message)
} finally {
  await db.close()
  console.log(`\n== CloudBase SQL 本地验证：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
