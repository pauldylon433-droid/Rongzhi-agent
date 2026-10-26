// 本地 CloudBase RPC 测试桩（PGlite 承载真实 SQL 函数；HTTP 形状与网关一致）。
// 仅用于 npm run cloud:verify:api；不属于生产代码，默认不启动。
import http from 'node:http'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = join(HERE, '..', '..', '..', 'cloudbase', 'sql')
const read = (f) => fs.readFileSync(join(SQL_DIR, f), 'utf8')

const db = new PGlite()
await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;')
await db.exec(read('001_schema_v1.sql'))
await db.exec(read('002_functions_v1.sql'))
await db.exec('SET ROLE service_role')
await db.query('SELECT public.rongzhi_bank_seed_v1(1)')

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', async () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    const asOwner = async (fn) => {
      await db.exec('RESET ROLE')
      try { return await fn() } finally { await db.exec('SET ROLE service_role') }
    }
    try {
      if (req.url === '/__snapshot') {
        const r = await db.query('SELECT public.rongzhi_bank_snapshot_v1(1) s')
        return send(200, r.rows[0].s)
      }
      if (req.url === '/__call') {
        const allowed = new Set([
          'rongzhi_bank_task_write_v1', 'rongzhi_bank_chat_write_v1', 'rongzhi_bank_verification_write_v1',
          'rongzhi_bank_snapshot_v1', 'rongzhi_bank_verification_secret_v1',
        ])
        if (!allowed.has(body.fn)) return send(400, { code: 'TEST_FORBIDDEN', message: 'fn not allowed' })
        if (body.fn === 'rongzhi_bank_snapshot_v1' || body.fn === 'rongzhi_bank_verification_secret_v1') {
          const r = await db.query(`SELECT public.${body.fn}($1::bigint) s`, [1])
          return send(200, r.rows[0].s)
        }
        const p = body.params || {}
        const r = await db.query(`SELECT public.${body.fn}($1::bigint,$2::text,$3::jsonb) r`, [1, p.op, JSON.stringify(p.payload || {})])
        return send(200, r.rows[0].r)
      }
      if (req.url === '/__add_debt') {
        await asOwner(async () => {
          await db.exec(`
            INSERT INTO public.rongzhi_bank_transactions
              (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, posted_at, status, flow_kind)
            SELECT ca.user_id, ca.account_id, 'expense', 10000, '购物', '测试', '测试新增欠款',
                   clock_timestamp(), clock_timestamp(), 'posted', 'external'
              FROM public.rongzhi_bank_credit_accounts ca WHERE ca.user_id = 1;
            UPDATE public.rongzhi_bank_statements
               SET new_charges_cents = new_charges_cents + 10000, version = version + 1
             WHERE id = (SELECT id FROM public.rongzhi_bank_statements
                          WHERE user_id = 1 AND issued_at IS NULL ORDER BY id DESC LIMIT 1);
            UPDATE public.rongzhi_bank_credit_accounts
               SET posted_outstanding_cents = posted_outstanding_cents + 10000 WHERE user_id = 1;
          `)
        })
        return send(200, { ok: true })
      }
      if (req.url === '/__expire') {
        await asOwner(async () => {
          const table = {
            transfer: 'rongzhi_bank_transfer_operations',
            card: 'rongzhi_bank_card_operations',
            subscription: 'rongzhi_bank_subscription_operations',
            repayment: 'rongzhi_bank_repayment_operations',
          }[body.kind]
          if (!table) throw new Error('bad kind')
          await db.query(`UPDATE public.${table} SET expires_at = clock_timestamp() - interval '1 second' WHERE ref_no = $1`, [body.ref_no])
        })
        return send(200, { ok: true })
      }
      if (req.url === '/__inject_fail') {
        await asOwner(async () => {
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
          await db.query("SELECT set_config('test.fail_ref', $1, false)", [String(body.ref_no || '')])
        })
        return send(200, { ok: true })
      }
      if (req.url === '/__clear_totp') {
        await asOwner(() => db.exec('DELETE FROM public.rongzhi_bank_totp_used_steps'))
        return send(200, { ok: true })
      }
      if (req.url === '/__clear_fail') {
        await asOwner(() => db.exec(`
          DROP TRIGGER IF EXISTS __test_fail_audit ON public.rongzhi_bank_audit_logs;
          DROP FUNCTION IF EXISTS public.__test_fail_audit();
          SELECT set_config('test.fail_ref', '', false);
        `))
        return send(200, { ok: true })
      }

      const m = /^\/v1\/rdb\/rest\/rpc\/([A-Za-z0-9_]+)$/.exec(req.url || '')
      if (!m) return send(404, { code: 'PGRST202', message: 'unknown endpoint' })
      const fn = m[1]
      let rows
      if (fn === 'rongzhi_bank_health_v1') {
        rows = (await db.query(`SELECT public.${fn}() r`)).rows
      } else if (fn === 'rongzhi_bank_snapshot_v1' || fn === 'rongzhi_bank_verification_secret_v1') {
        rows = (await db.query(`SELECT public.${fn}($1::bigint) r`, [body.p_user_id])).rows
      } else if (fn === 'rongzhi_bank_audit_event_v1') {
        rows = (await db.query(`SELECT public.${fn}($1::bigint,$2::text,$3::jsonb) r`,
          [body.p_user_id, body.p_op, JSON.stringify(body.p_payload || {})])).rows
      } else if (fn === 'rongzhi_bank_seed_v1') {
        rows = (await db.query(`SELECT public.${fn}($1::bigint) r`, [body.p_user_id || 1])).rows
      } else if (/^rongzhi_bank_(transfer|card|sub|repay|chat|verification|task|audit|plan)_write_v1$/.test(fn)) {
        rows = (await db.query(`SELECT public.${fn}($1::bigint,$2::text,$3::jsonb) r`,
          [body.p_user_id, body.p_op, JSON.stringify(body.p_payload || {})])).rows
      } else {
        return send(404, { code: 'PGRST202', message: 'Could not find the function' })
      }
      send(200, rows[0].r)
    } catch (e) {
      const code = e && e.code ? String(e.code) : ''
      send(400, { code: code ? `DATABASE_${code}` : 'DATABASE_XX000', message: String(e && e.message ? e.message : e) })
    }
  })
})

server.listen(Number(process.env.STUB_PORT || 0), '127.0.0.1', () => {
  console.log(server.address().port)
})
