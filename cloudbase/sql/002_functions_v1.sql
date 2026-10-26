-- 融智 Agent · CloudBase PostgreSQL 持久库 v1（固定 RPC）
-- 所有函数 SECURITY DEFINER，search_path 固定为 pg_catalog, pg_temp；表名显式 public.rongzhi_bank_*。
-- 写操作 dispatcher 只接受白名单 p_op，不接受 SQL 文本；每次调用即一个数据库事务。
-- 权限在文件末尾同一事务内 REVOKE PUBLIC / anon / authenticated，仅授予 service_role。

BEGIN;

-- ——————————————————————————————————————————————————————————————
-- 内部校验 / 审计辅助
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_pos_bigint(p_payload jsonb, p_key text)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v text := p_payload->>p_key;
BEGIN
  IF v IS NULL OR v !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'invalid_parameters: %', p_key USING ERRCODE = '22023';
  END IF;
  RETURN v::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_text(p_payload jsonb, p_key text, p_max int DEFAULT 500)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v text := p_payload->>p_key;
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN
    RAISE EXCEPTION 'invalid_parameters: %', p_key USING ERRCODE = '22023';
  END IF;
  IF char_length(v) > p_max THEN
    RAISE EXCEPTION 'invalid_parameters_too_long: %', p_key USING ERRCODE = '22023';
  END IF;
  RETURN btrim(v);
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_audit(
  p_user_id bigint, p_type text, p_ref text, p_action text, p_result text, p_detail jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.rongzhi_bank_audit_logs
    (user_id, operation_type, operation_ref, action, result, detail)
  VALUES (p_user_id, p_type, p_ref, p_action, p_result, p_detail);
$$;

-- ——————————————————————————————————————————————————————————————
-- 只读快照 / 强验证密文读取
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_snapshot_v1(p_user_id bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'user', (SELECT to_jsonb(u) FROM public.rongzhi_bank_users u WHERE u.id = p_user_id),
    'accounts', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.rongzhi_bank_accounts a WHERE a.user_id = p_user_id), '[]'::jsonb),
    'transactions', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.rongzhi_bank_transactions t WHERE t.user_id = p_user_id), '[]'::jsonb),
    'cards', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.rongzhi_bank_cards c WHERE c.user_id = p_user_id), '[]'::jsonb),
    'subscriptions', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.rongzhi_bank_subscriptions s WHERE s.user_id = p_user_id), '[]'::jsonb),
    'transfer_recipients', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.rongzhi_bank_transfer_recipients r), '[]'::jsonb),
    'transfer_operations', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id DESC) FROM public.rongzhi_bank_transfer_operations o WHERE o.user_id = p_user_id), '[]'::jsonb),
    'card_operations', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id DESC) FROM public.rongzhi_bank_card_operations o WHERE o.user_id = p_user_id), '[]'::jsonb),
    'subscription_operations', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id DESC) FROM public.rongzhi_bank_subscription_operations o WHERE o.user_id = p_user_id), '[]'::jsonb),
    'credit_accounts', coalesce((SELECT jsonb_agg(to_jsonb(ca) ORDER BY ca.id) FROM public.rongzhi_bank_credit_accounts ca WHERE ca.user_id = p_user_id), '[]'::jsonb),
    'statements', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.statement_year, s.statement_month, s.id) FROM public.rongzhi_bank_statements s WHERE s.user_id = p_user_id), '[]'::jsonb),
    'statement_payments', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.rongzhi_bank_statement_payments p WHERE p.user_id = p_user_id), '[]'::jsonb),
    'repayment_operations', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id DESC) FROM public.rongzhi_bank_repayment_operations o WHERE o.user_id = p_user_id), '[]'::jsonb),
    'repayment_allocations', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.rongzhi_bank_repayment_allocations a JOIN public.rongzhi_bank_repayment_operations o ON o.ref_no = a.ref_no WHERE o.user_id = p_user_id), '[]'::jsonb),
    'chat_sessions', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.last_active_at DESC) FROM public.rongzhi_bank_chat_sessions s WHERE s.user_id = p_user_id), '[]'::jsonb),
    'chat_messages', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.seq, m.id) FROM public.rongzhi_bank_chat_messages m WHERE m.user_id = p_user_id), '[]'::jsonb),
    'chat_state', (SELECT to_jsonb(cs) FROM public.rongzhi_bank_chat_state cs WHERE cs.user_id = p_user_id),
    'agent_tasks', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.updated_at DESC, t.id DESC) FROM public.rongzhi_bank_agent_tasks t WHERE t.user_id = p_user_id), '[]'::jsonb),
    'agent_task_nodes', coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.task_id, n.seq) FROM public.rongzhi_bank_agent_task_nodes n JOIN public.rongzhi_bank_agent_tasks t ON t.id = n.task_id WHERE t.user_id = p_user_id), '[]'::jsonb),
    'audit_logs', coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id DESC) FROM (SELECT * FROM public.rongzhi_bank_audit_logs WHERE user_id = p_user_id ORDER BY id DESC LIMIT 500) l), '[]'::jsonb),
    'verification', jsonb_build_object(
      'bound', coalesce((SELECT b.enabled = 1 FROM public.rongzhi_bank_verification_bindings b WHERE b.user_id = p_user_id), false),
      'fail_count', coalesce((SELECT f.fail_count FROM public.rongzhi_bank_verification_failures f WHERE f.user_id = p_user_id), 0),
      'locked_until', (SELECT to_jsonb(f.locked_until) FROM public.rongzhi_bank_verification_failures f WHERE f.user_id = p_user_id)
    ),
    'snapshot_at', to_jsonb(clock_timestamp())
  );
$$;

-- 仅后端强验证流程调用；返回加密后的 TOTP 密文与密码哈希，不含明文。
CREATE OR REPLACE FUNCTION public.rongzhi_bank_verification_secret_v1(p_user_id bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((
    SELECT jsonb_build_object(
      'enabled', b.enabled,
      'password_salt', b.password_salt,
      'password_hash', b.password_hash,
      'totp_secret_enc', b.totp_secret_enc,
      'fail_count', coalesce(f.fail_count, 0),
      'locked_until', to_jsonb(f.locked_until)
    )
    FROM public.rongzhi_bank_verification_bindings b
    LEFT JOIN public.rongzhi_bank_verification_failures f ON f.user_id = b.user_id
    WHERE b.user_id = p_user_id
  ), jsonb_build_object('enabled', 0, 'fail_count', 0, 'locked_until', null));
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_health_v1()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT jsonb_build_object('ok', true, 'version', 'rongzhi-bank-v1', 'server_time', to_jsonb(clock_timestamp())); $$;

-- ——————————————————————————————————————————————————————————————
-- 转账：create / confirm / cancel / verify
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_day_start(p_at timestamptz)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT date_trunc('day', p_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'; $$;

-- 同一用户的转账创建 / 确认 / 强验证完成路径共用事务级 advisory lock：
-- 取得保护后再读取上海当日累计额，避免两个并发请求都读到旧累计额后同时按黄色完成。
CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_transfer_user_lock(p_user_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('rongzhi_bank_transfer_user:' || p_user_id::text, 0));
$$;

-- 强验证锁复核：确保验证失败行存在并加行锁；若 locked_until 仍有效，返回 locked=true。
-- 行锁保持到事务结束，成功路径在同一事务内重置计数，避免晚到的 record_failure 解除有效锁定。
CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_verification_guard(p_user_id bigint, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_locked timestamptz;
BEGIN
  INSERT INTO public.rongzhi_bank_verification_failures (user_id, fail_count, locked_until)
  VALUES (p_user_id, 0, NULL)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT locked_until INTO v_locked
    FROM public.rongzhi_bank_verification_failures
   WHERE user_id = p_user_id
   FOR UPDATE;
  IF v_locked IS NOT NULL AND v_locked > p_now THEN
    RETURN jsonb_build_object('locked', true, 'locked_until', to_jsonb(v_locked));
  END IF;
  RETURN jsonb_build_object('locked', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_finalize_transfer(
  p_user_id bigint, p_ref_no text, p_expected_status text, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_op public.rongzhi_bank_transfer_operations%ROWTYPE;
  v_acct public.rongzhi_bank_accounts%ROWTYPE;
  v_tx_id bigint;
  v_changed int;
BEGIN
  SELECT * INTO v_op FROM public.rongzhi_bank_transfer_operations
   WHERE ref_no = p_ref_no AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF v_op.status <> p_expected_status THEN
    IF v_op.status = 'completed' THEN
      SELECT id INTO v_tx_id FROM public.rongzhi_bank_transactions WHERE transfer_ref = p_ref_no LIMIT 1;
      RETURN jsonb_build_object('outcome','completed','transaction_id',to_jsonb(v_tx_id));
    END IF;
    RETURN jsonb_build_object('outcome', v_op.status);
  END IF;

  SELECT * INTO v_acct FROM public.rongzhi_bank_accounts
   WHERE id = v_op.from_account_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_acct.status <> 'active' OR v_acct.account_type <> 'deposit'
     OR v_acct.balance_cents < v_op.amount_cents THEN
    UPDATE public.rongzhi_bank_transfer_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','failed');
  END IF;

  UPDATE public.rongzhi_bank_transfer_operations
     SET status = 'completed', confirmed_at = p_now
   WHERE id = v_op.id AND status = p_expected_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN
    SELECT id INTO v_tx_id FROM public.rongzhi_bank_transactions WHERE transfer_ref = p_ref_no LIMIT 1;
    RETURN jsonb_build_object('outcome','completed','transaction_id',to_jsonb(v_tx_id));
  END IF;

  UPDATE public.rongzhi_bank_accounts
     SET balance_cents = balance_cents - v_op.amount_cents
   WHERE id = v_op.from_account_id AND user_id = p_user_id AND balance_cents >= v_op.amount_cents;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RAISE EXCEPTION 'deduct_failed' USING ERRCODE = 'P0004'; END IF;

  INSERT INTO public.rongzhi_bank_transactions
    (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, transfer_ref)
  VALUES
    (p_user_id, v_op.from_account_id, 'expense', v_op.amount_cents, '转账', v_op.recipient_name,
     coalesce(nullif(v_op.remark, ''), '转账'), p_now, 'posted', p_ref_no)
  RETURNING id INTO v_tx_id;

  PERFORM public.rongzhi_bank_internal_audit(
    p_user_id, 'transfer', p_ref_no, 'confirm', 'success',
    jsonb_build_object('amount_cents', v_op.amount_cents, 'transaction_id', v_tx_id));

  IF v_op.session_id IS NOT NULL THEN
    UPDATE public.rongzhi_bank_chat_sessions
       SET pending_transfer_ref = NULL
     WHERE id = v_op.session_id AND pending_transfer_ref = p_ref_no;
  END IF;

  RETURN jsonb_build_object('outcome','completed','transaction_id',to_jsonb(v_tx_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_transfer_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_amount bigint;
  v_from_id bigint;
  v_recipient public.rongzhi_bank_transfer_recipients%ROWTYPE;
  v_acct public.rongzhi_bank_accounts%ROWTYPE;
  v_acct_found boolean := false;
  v_op public.rongzhi_bank_transfer_operations%ROWTYPE;
  v_ref text;
  v_today bigint;
  v_risk text;
  v_status text;
  v_clean_remark text;
  v_step bigint;
  v_res jsonb;
  v_guard jsonb;
  v_tx_id bigint;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'create' THEN
    v_amount := public.rongzhi_bank_internal_pos_bigint(p_payload, 'amount_cents');
    v_from_id := public.rongzhi_bank_internal_pos_bigint(p_payload, 'from_account_id');
    SELECT * INTO v_recipient FROM public.rongzhi_bank_transfer_recipients
     WHERE id = public.rongzhi_bank_internal_pos_bigint(p_payload, 'recipient_id');
    IF NOT FOUND THEN RAISE EXCEPTION '收款人不存在' USING ERRCODE = '22023'; END IF;

    -- 用户级同步：与所有转账完成路径串行，取得保护后再读取当日累计额。
    PERFORM public.rongzhi_bank_internal_transfer_user_lock(p_user_id);
    v_now := clock_timestamp();

    SELECT * INTO v_acct FROM public.rongzhi_bank_accounts
     WHERE id = v_from_id AND user_id = p_user_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION '没有可用的付款账户' USING ERRCODE = '22023'; END IF;
    IF v_acct.account_type <> 'deposit' THEN RAISE EXCEPTION '信用卡账户不可用于对外转账' USING ERRCODE = '22023'; END IF;
    IF v_acct.balance_cents < v_amount THEN RAISE EXCEPTION '账户余额不足' USING ERRCODE = '22023'; END IF;

    v_clean_remark := coalesce(btrim(p_payload->>'remark'), '');
    IF char_length(v_clean_remark) > 200 THEN RAISE EXCEPTION '备注过长（最多 200 字符）' USING ERRCODE = '22023'; END IF;

    SELECT coalesce(sum(amount_cents), 0) INTO v_today
      FROM public.rongzhi_bank_transfer_operations
     WHERE user_id = p_user_id AND status = 'completed'
       AND confirmed_at >= public.rongzhi_bank_internal_day_start(v_now)
       AND confirmed_at < public.rongzhi_bank_internal_day_start(v_now) + interval '1 day';
    v_risk := CASE WHEN v_today + v_amount > 100000 THEN 'red' ELSE 'yellow' END;
    v_status := CASE WHEN v_risk = 'red' THEN 'needs_verification' ELSE 'pending' END;
    v_ref := gen_random_uuid()::text;

    INSERT INTO public.rongzhi_bank_transfer_operations
      (ref_no, user_id, session_id, from_account_id, from_account_name, recipient_id, recipient_name,
       recipient_masked_account, amount_cents, remark, status, risk_level, created_at, expires_at)
    VALUES
      (v_ref, p_user_id, nullif(p_payload->>'session_id',''), v_acct.id, v_acct.account_name,
       v_recipient.id, v_recipient.name, v_recipient.masked_account, v_amount, v_clean_remark,
       v_status, v_risk, v_now, v_now + interval '5 minutes');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'transfer', v_ref, 'create', v_status,
      jsonb_build_object('amount_cents', v_amount, 'recipient_id', v_recipient.id));
    RETURN jsonb_build_object('outcome','created','ref_no',v_ref,'status',v_status,'risk_level',v_risk);

  ELSIF p_op = 'confirm' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    -- 所有完成路径先取用户级事务锁，再读当日累计额。
    PERFORM public.rongzhi_bank_internal_transfer_user_lock(p_user_id);
    SELECT * INTO v_op FROM public.rongzhi_bank_transfer_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;

    IF v_op.status = 'pending' THEN
      -- 锁付款账户后再读取当前时间，避免等待锁期间单据过期。
      SELECT * INTO v_acct FROM public.rongzhi_bank_accounts
       WHERE id = v_op.from_account_id AND user_id = p_user_id FOR UPDATE;
      v_acct_found := FOUND;
      v_now := clock_timestamp();
      IF v_op.expires_at < v_now THEN
        UPDATE public.rongzhi_bank_transfer_operations SET status = 'expired' WHERE id = v_op.id AND status = 'pending';
        RETURN jsonb_build_object('outcome','expired');
      END IF;
      IF NOT v_acct_found OR v_acct.status <> 'active' OR v_acct.account_type <> 'deposit'
         OR v_acct.balance_cents < v_op.amount_cents THEN
        UPDATE public.rongzhi_bank_transfer_operations SET status = 'failed' WHERE id = v_op.id AND status = 'pending';
        PERFORM public.rongzhi_bank_internal_audit(
          p_user_id, 'transfer', v_ref, 'confirm', 'failed', jsonb_build_object('reason','account_unavailable'));
        RETURN jsonb_build_object('outcome','failed');
      END IF;

      SELECT coalesce(sum(amount_cents), 0) INTO v_today
        FROM public.rongzhi_bank_transfer_operations
       WHERE user_id = p_user_id AND status = 'completed'
         AND confirmed_at >= public.rongzhi_bank_internal_day_start(v_now)
         AND confirmed_at < public.rongzhi_bank_internal_day_start(v_now) + interval '1 day';
      IF v_today + v_op.amount_cents > 100000 THEN
        UPDATE public.rongzhi_bank_transfer_operations
           SET status = 'needs_verification', risk_level = 'red'
         WHERE id = v_op.id AND status = 'pending';
        IF FOUND THEN
          PERFORM public.rongzhi_bank_internal_audit(
            p_user_id, 'transfer', v_ref, 'risk_upgrade', 'needs_verification',
            jsonb_build_object('amount_cents', v_op.amount_cents, 'today_completed_cents', v_today, 'limit_cents', 100000));
        END IF;
        RETURN jsonb_build_object('outcome','needs_verification');
      END IF;
      RETURN public.rongzhi_bank_internal_finalize_transfer(p_user_id, v_ref, 'pending', v_now);
    END IF;

    v_now := clock_timestamp();
    IF v_op.status IN ('needs_verification') AND v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_transfer_operations SET status = 'expired' WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status = 'completed' THEN
      SELECT id INTO v_tx_id FROM public.rongzhi_bank_transactions WHERE transfer_ref = v_ref LIMIT 1;
      RETURN jsonb_build_object('outcome','completed','transaction_id',to_jsonb(v_tx_id));
    END IF;
    RETURN jsonb_build_object('outcome',v_op.status);

  ELSIF p_op = 'cancel' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_transfer_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    v_now := clock_timestamp();
    IF v_op.status = 'cancelled' THEN RETURN jsonb_build_object('outcome','cancelled'); END IF;
    IF v_op.status IN ('pending','needs_verification') AND v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_transfer_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    UPDATE public.rongzhi_bank_transfer_operations SET status = 'cancelled'
     WHERE id = v_op.id AND status IN ('pending','needs_verification');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'transfer', v_ref, 'cancel', 'success', jsonb_build_object('amount_cents', v_op.amount_cents));
    RETURN jsonb_build_object('outcome','cancelled');

  ELSIF p_op = 'verify' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    v_step := public.rongzhi_bank_internal_pos_bigint(p_payload, 'matched_step');
    PERFORM public.rongzhi_bank_internal_transfer_user_lock(p_user_id);
    SELECT * INTO v_op FROM public.rongzhi_bank_transfer_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN
      RETURN jsonb_build_object('outcome',v_op.status);
    END IF;

    -- 锁付款账户 + 强验证失败行；取得锁后再读取当前时间并复核锁定 / 过期。
    SELECT * INTO v_acct FROM public.rongzhi_bank_accounts
     WHERE id = v_op.from_account_id AND user_id = p_user_id FOR UPDATE;
    v_acct_found := FOUND;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_transfer_operations SET status = 'expired'
       WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status <> 'needs_verification' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;

    v_guard := public.rongzhi_bank_internal_verification_guard(p_user_id, clock_timestamp());
    IF (v_guard->>'locked')::boolean THEN
      RETURN jsonb_build_object('outcome','locked','locked_until',v_guard->'locked_until');
    END IF;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_transfer_operations SET status = 'expired'
       WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;

    -- 消费时间步前完成账户校验；业务失败不残留时间步。
    IF NOT v_acct_found OR v_acct.status <> 'active' OR v_acct.account_type <> 'deposit'
       OR v_acct.balance_cents < v_op.amount_cents THEN
      UPDATE public.rongzhi_bank_transfer_operations SET status = 'failed'
       WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','account_unavailable'));
      RETURN jsonb_build_object('outcome','failed');
    END IF;

    BEGIN
      INSERT INTO public.rongzhi_bank_totp_used_steps (user_id, step, purpose, consumed_at)
      VALUES (p_user_id, v_step, 'transfer', v_now);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('outcome','code_reused');
    END;

    v_res := public.rongzhi_bank_internal_finalize_transfer(p_user_id, v_ref, 'needs_verification', v_now);
    IF v_res->>'outcome' = 'completed' THEN
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_success', 'success',
        jsonb_build_object('step', v_step, 'transaction_id', (v_res->>'transaction_id')::bigint));
      UPDATE public.rongzhi_bank_verification_failures
         SET fail_count = 0, locked_until = NULL WHERE user_id = p_user_id;
    END IF;
    RETURN v_res;
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 银行卡操作：create / confirm / cancel / verify
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_finalize_card(
  p_user_id bigint, p_ref_no text, p_expected_status text, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_op public.rongzhi_bank_card_operations%ROWTYPE;
  v_card public.rongzhi_bank_cards%ROWTYPE;
  v_changed int;
BEGIN
  SELECT * INTO v_op FROM public.rongzhi_bank_card_operations
   WHERE ref_no = p_ref_no AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF v_op.status <> p_expected_status THEN
    IF v_op.status = 'completed' THEN RETURN jsonb_build_object('outcome','completed'); END IF;
    RETURN jsonb_build_object('outcome',v_op.status);
  END IF;

  SELECT * INTO v_card FROM public.rongzhi_bank_cards
   WHERE id = v_op.card_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','failed');
  END IF;
  IF v_card.version <> v_op.card_version THEN
    UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','stale');
  END IF;
  IF v_card.status = v_op.to_status THEN
    UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','already');
  END IF;

  UPDATE public.rongzhi_bank_card_operations SET status = 'completed', confirmed_at = p_now
   WHERE id = v_op.id AND status = p_expected_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RETURN jsonb_build_object('outcome','completed'); END IF;

  UPDATE public.rongzhi_bank_cards
     SET status = v_op.to_status, version = version + 1
   WHERE id = v_op.card_id AND user_id = p_user_id AND version = v_op.card_version;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RAISE EXCEPTION 'card_state_changed' USING ERRCODE = 'P0003'; END IF;

  PERFORM public.rongzhi_bank_internal_audit(
    p_user_id, 'card_operation', p_ref_no, 'confirm', 'success',
    jsonb_build_object('action', v_op.action, 'card_id', v_op.card_id, 'from', v_op.from_status, 'to', v_op.to_status));
  UPDATE public.rongzhi_bank_chat_sessions SET pending_card_op_ref = NULL
   WHERE pending_card_op_ref = p_ref_no;
  RETURN jsonb_build_object('outcome','completed');
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_card_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_action text;
  v_card public.rongzhi_bank_cards%ROWTYPE;
  v_card_found boolean := false;
  v_op public.rongzhi_bank_card_operations%ROWTYPE;
  v_ref text;
  v_from text;
  v_to text;
  v_risk text;
  v_status text;
  v_step bigint;
  v_res jsonb;
  v_guard jsonb;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'create' THEN
    v_action := p_payload->>'action';
    IF v_action NOT IN ('freeze','unfreeze') THEN RAISE EXCEPTION '不支持的卡片操作（仅支持 freeze / unfreeze）' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_card FROM public.rongzhi_bank_cards
     WHERE id = public.rongzhi_bank_internal_pos_bigint(p_payload, 'card_id') AND user_id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION '未找到该银行卡' USING ERRCODE = '22023'; END IF;
    v_from := CASE WHEN v_action = 'freeze' THEN 'active' ELSE 'frozen' END;
    v_to := CASE WHEN v_action = 'freeze' THEN 'frozen' ELSE 'active' END;
    IF v_card.status = 'cancelled' THEN
      RAISE EXCEPTION '%', CASE WHEN v_action='freeze' THEN '该卡已注销，不能冻结' ELSE '该卡已注销，不能解冻' END USING ERRCODE = '22023';
    END IF;
    IF v_card.status = v_to THEN
      RAISE EXCEPTION '%', CASE WHEN v_action='freeze' THEN '该卡已处于冻结状态，无需重复冻结' ELSE '该卡已是正常状态，无需重复解冻' END USING ERRCODE = '22023';
    END IF;
    IF v_card.status <> v_from THEN RAISE EXCEPTION '该卡当前状态不支持此操作' USING ERRCODE = '22023'; END IF;
    v_risk := CASE WHEN v_action = 'freeze' THEN 'yellow' ELSE 'red' END;
    v_status := CASE WHEN v_action = 'freeze' THEN 'pending' ELSE 'needs_verification' END;
    v_now := clock_timestamp();
    v_ref := gen_random_uuid()::text;
    INSERT INTO public.rongzhi_bank_card_operations
      (ref_no, user_id, card_id, card_masked, card_type, action, from_status, to_status,
       card_version, risk_level, status, created_at, expires_at)
    VALUES
      (v_ref, p_user_id, v_card.id, v_card.masked_card_number, v_card.card_type, v_action, v_from, v_to,
       v_card.version, v_risk, v_status, v_now, v_now + interval '5 minutes');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'card_operation', v_ref, 'create', v_status,
      jsonb_build_object('action', v_action, 'card_id', v_card.id));
    RETURN jsonb_build_object('outcome','created','ref_no',v_ref,'status',v_status,'risk_level',v_risk);

  ELSIF p_op = 'confirm' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_card_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status IN ('pending','needs_verification') THEN
      SELECT * INTO v_card FROM public.rongzhi_bank_cards
       WHERE id = v_op.card_id AND user_id = p_user_id FOR UPDATE;
      v_card_found := FOUND;
      v_now := clock_timestamp();
      IF v_op.expires_at < v_now THEN
        UPDATE public.rongzhi_bank_card_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
        RETURN jsonb_build_object('outcome','expired');
      END IF;
    ELSE
      v_now := clock_timestamp();
    END IF;
    IF v_op.status = 'completed' THEN RETURN jsonb_build_object('outcome','completed'); END IF;
    IF v_op.status <> 'pending' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    IF v_op.action <> 'freeze' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    RETURN public.rongzhi_bank_internal_finalize_card(p_user_id, v_ref, 'pending', v_now);

  ELSIF p_op = 'cancel' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_card_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    v_now := clock_timestamp();
    IF v_op.status = 'cancelled' THEN RETURN jsonb_build_object('outcome','cancelled'); END IF;
    IF v_op.status IN ('pending','needs_verification') AND v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    UPDATE public.rongzhi_bank_card_operations SET status = 'cancelled'
     WHERE id = v_op.id AND status IN ('pending','needs_verification');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'card_operation', v_ref, 'cancel', 'success',
      jsonb_build_object('action', v_op.action, 'card_id', v_op.card_id));
    RETURN jsonb_build_object('outcome','cancelled');

  ELSIF p_op = 'verify' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    v_step := public.rongzhi_bank_internal_pos_bigint(p_payload, 'matched_step');
    SELECT * INTO v_op FROM public.rongzhi_bank_card_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN
      RETURN jsonb_build_object('outcome',v_op.status);
    END IF;

    SELECT * INTO v_card FROM public.rongzhi_bank_cards
     WHERE id = v_op.card_id AND user_id = p_user_id FOR UPDATE;
    v_card_found := FOUND;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status <> 'needs_verification' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    IF v_op.action <> 'unfreeze' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;

    v_guard := public.rongzhi_bank_internal_verification_guard(p_user_id, clock_timestamp());
    IF (v_guard->>'locked')::boolean THEN
      RETURN jsonb_build_object('outcome','locked','locked_until',v_guard->'locked_until');
    END IF;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'expired'
       WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;

    -- 消费时间步前完成卡片版本 / 目标状态校验；stale / already 不残留时间步。
    IF NOT v_card_found THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','card_not_found'));
      RETURN jsonb_build_object('outcome','failed');
    END IF;
    IF v_card.version <> v_op.card_version THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'stale', jsonb_build_object('reason','card_version_changed'));
      RETURN jsonb_build_object('outcome','stale');
    END IF;
    IF v_card.status = v_op.to_status THEN
      UPDATE public.rongzhi_bank_card_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'already', jsonb_build_object('reason','already_in_target_state'));
      RETURN jsonb_build_object('outcome','already');
    END IF;

    BEGIN
      INSERT INTO public.rongzhi_bank_totp_used_steps (user_id, step, purpose, consumed_at)
      VALUES (p_user_id, v_step, 'unfreeze', v_now);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('outcome','code_reused');
    END;
    v_res := public.rongzhi_bank_internal_finalize_card(p_user_id, v_ref, 'needs_verification', v_now);
    IF v_res->>'outcome' = 'completed' THEN
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_success', 'success',
        jsonb_build_object('step', v_step, 'card_id', v_op.card_id, 'action', 'unfreeze'));
      UPDATE public.rongzhi_bank_verification_failures
         SET fail_count = 0, locked_until = NULL WHERE user_id = p_user_id;
    END IF;
    RETURN v_res;
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 订阅与代扣操作：create / confirm / cancel / verify
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_source_snapshot(p_user_id bigint, p_account_id bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'account', to_jsonb(a),
    'card', (SELECT to_jsonb(c) FROM public.rongzhi_bank_cards c
              WHERE c.account_id = a.id AND c.user_id = p_user_id AND c.status <> 'cancelled'
              ORDER BY c.id LIMIT 1)
  )
  FROM public.rongzhi_bank_accounts a
  WHERE a.id = p_account_id AND a.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_source_usable(p_user_id bigint, p_account_id bigint, p_currency text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_snap jsonb;
  v_active int;
  v_total int;
BEGIN
  v_snap := public.rongzhi_bank_internal_source_snapshot(p_user_id, p_account_id);
  IF v_snap IS NULL OR v_snap->'account' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', '扣款账户不存在或不属于当前用户');
  END IF;
  IF (v_snap->'account'->>'status') <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', '该扣款账户状态不可用');
  END IF;
  IF p_currency IS NOT NULL AND (v_snap->'account'->>'currency') <> p_currency THEN
    RETURN jsonb_build_object('ok', false, 'reason', '扣款账户币种与订阅不匹配');
  END IF;
  SELECT count(*) FILTER (WHERE c.status = 'active'), count(*)
    INTO v_active, v_total
    FROM public.rongzhi_bank_cards c
   WHERE c.account_id = p_account_id AND c.user_id = p_user_id AND c.status <> 'cancelled';
  IF v_active = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason',
      CASE WHEN v_total = 0 THEN '该账户没有可用的银行卡，不能作为扣款来源'
           ELSE '该账户的银行卡已冻结或不可用，不能作为扣款来源' END);
  END IF;
  IF v_active > 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', '该账户存在多张可用银行卡，无法确定扣款卡，请先处理');
  END IF;
  SELECT jsonb_build_object('account', to_jsonb(a), 'card', to_jsonb(c))
    INTO v_snap
    FROM public.rongzhi_bank_accounts a
    JOIN public.rongzhi_bank_cards c ON c.account_id = a.id AND c.user_id = a.user_id AND c.status = 'active'
   WHERE a.id = p_account_id AND a.user_id = p_user_id
   ORDER BY c.id LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'snapshot', v_snap);
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_finalize_sub(
  p_user_id bigint, p_ref_no text, p_expected_status text, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_op public.rongzhi_bank_subscription_operations%ROWTYPE;
  v_sub public.rongzhi_bank_subscriptions%ROWTYPE;
  v_changed int;
  v_check jsonb;
  v_currency text;
BEGIN
  SELECT * INTO v_op FROM public.rongzhi_bank_subscription_operations
   WHERE ref_no = p_ref_no AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF v_op.status <> p_expected_status THEN
    IF v_op.status = 'completed' THEN RETURN jsonb_build_object('outcome','completed'); END IF;
    RETURN jsonb_build_object('outcome',v_op.status);
  END IF;
  SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
   WHERE id = v_op.subscription_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','failed');
  END IF;

  IF v_op.action = 'change_source' THEN
    IF v_sub.status = 'cancelled' THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
      RETURN jsonb_build_object('outcome','failed','reason','订阅已取消，不能更换扣款账户');
    END IF;
    IF v_sub.version <> v_op.subscription_version OR v_sub.account_id <> v_op.from_account_id THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
      RETURN jsonb_build_object('outcome','failed','reason','订阅状态或原扣款账户已变化，该操作单已失效，请重新发起');
    END IF;
    IF v_op.to_account_id = v_sub.account_id THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
      RETURN jsonb_build_object('outcome','failed','reason','新扣款账户与当前来源相同');
    END IF;
    SELECT currency INTO v_currency FROM public.rongzhi_bank_accounts WHERE id = v_op.from_account_id;
    v_check := public.rongzhi_bank_internal_source_usable(p_user_id, v_op.to_account_id, coalesce(v_currency,'CNY'));
    IF NOT (v_check->>'ok')::boolean THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
      RETURN jsonb_build_object('outcome','failed','reason',v_check->>'reason');
    END IF;

    UPDATE public.rongzhi_bank_subscription_operations SET status = 'completed', confirmed_at = p_now
     WHERE id = v_op.id AND status = p_expected_status;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RETURN jsonb_build_object('outcome','completed'); END IF;
    UPDATE public.rongzhi_bank_subscriptions
       SET account_id = v_op.to_account_id, version = version + 1
     WHERE id = v_op.subscription_id AND user_id = p_user_id AND version = v_op.subscription_version;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RAISE EXCEPTION 'subscription_changed' USING ERRCODE = 'P0003'; END IF;
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'subscription_operation', p_ref_no, 'confirm', 'success',
      jsonb_build_object('action','change_source','subscription_id',v_op.subscription_id,
                         'from_account_id',v_op.from_account_id,'to_account_id',v_op.to_account_id));
    UPDATE public.rongzhi_bank_chat_sessions SET pending_subscription_op_ref = NULL
     WHERE pending_subscription_op_ref = p_ref_no;
    RETURN jsonb_build_object('outcome','completed');
  END IF;

  IF v_sub.version <> v_op.subscription_version THEN
    UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','stale');
  END IF;
  IF v_sub.status = v_op.to_status THEN
    UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed' WHERE id = v_op.id AND status = p_expected_status;
    RETURN jsonb_build_object('outcome','already');
  END IF;
  UPDATE public.rongzhi_bank_subscription_operations SET status = 'completed', confirmed_at = p_now
   WHERE id = v_op.id AND status = p_expected_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RETURN jsonb_build_object('outcome','completed'); END IF;
  UPDATE public.rongzhi_bank_subscriptions
     SET status = v_op.to_status, version = version + 1
   WHERE id = v_op.subscription_id AND user_id = p_user_id AND version = v_op.subscription_version;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RAISE EXCEPTION 'subscription_changed' USING ERRCODE = 'P0003'; END IF;
  PERFORM public.rongzhi_bank_internal_audit(
    p_user_id, 'subscription_operation', p_ref_no, 'confirm', 'success',
    jsonb_build_object('action',v_op.action,'subscription_id',v_op.subscription_id,
                       'from',v_op.from_status,'to',v_op.to_status));
  UPDATE public.rongzhi_bank_chat_sessions SET pending_subscription_op_ref = NULL
   WHERE pending_subscription_op_ref = p_ref_no;
  RETURN jsonb_build_object('outcome','completed');
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_sub_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_action text;
  v_sub public.rongzhi_bank_subscriptions%ROWTYPE;
  v_sub_found boolean := false;
  v_op public.rongzhi_bank_subscription_operations%ROWTYPE;
  v_from_snap jsonb;
  v_to_snap jsonb;
  v_check jsonb;
  v_from_status text;
  v_to_status text;
  v_from_id bigint;
  v_to_id bigint;
  v_ref text;
  v_risk text;
  v_status text;
  v_currency text;
  v_step bigint;
  v_res jsonb;
  v_guard jsonb;
  v_reason text;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'create' THEN
    v_action := p_payload->>'action';
    IF v_action NOT IN ('pause','resume','cancel','change_source') THEN
      RAISE EXCEPTION '不支持的订阅操作' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
     WHERE id = public.rongzhi_bank_internal_pos_bigint(p_payload, 'subscription_id') AND user_id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION '未找到该订阅' USING ERRCODE = '22023'; END IF;

    v_from_snap := NULL; v_to_snap := NULL; v_from_id := NULL; v_to_id := NULL;
    IF v_action = 'change_source' THEN
      IF v_sub.status = 'cancelled' THEN RAISE EXCEPTION '该订阅已取消，不能更换扣款账户或重新开通' USING ERRCODE = '22023'; END IF;
      IF v_sub.status NOT IN ('active','paused') THEN RAISE EXCEPTION '该订阅当前状态不支持更换扣款账户' USING ERRCODE = '22023'; END IF;
      v_to_id := public.rongzhi_bank_internal_pos_bigint(p_payload, 'to_account_id');
      IF v_to_id = v_sub.account_id THEN RAISE EXCEPTION '新扣款账户与当前扣款账户相同，无需更换' USING ERRCODE = '22023'; END IF;
      v_from_snap := public.rongzhi_bank_internal_source_snapshot(p_user_id, v_sub.account_id);
      v_currency := coalesce(v_from_snap->'account'->>'currency','CNY');
      v_check := public.rongzhi_bank_internal_source_usable(p_user_id, v_to_id, v_currency);
      IF NOT (v_check->>'ok')::boolean THEN RAISE EXCEPTION '%', v_check->>'reason' USING ERRCODE = '22023'; END IF;
      v_to_snap := v_check->'snapshot';
      v_from_status := v_sub.status; v_to_status := v_sub.status;
      v_from_id := v_sub.account_id;
    ELSIF v_action = 'cancel' THEN
      IF v_sub.status = 'cancelled' THEN RAISE EXCEPTION '该订阅已取消，不能再次取消' USING ERRCODE = '22023'; END IF;
      IF v_sub.status NOT IN ('active','paused') THEN RAISE EXCEPTION '该订阅当前状态不支持取消' USING ERRCODE = '22023'; END IF;
      v_from_status := v_sub.status; v_to_status := 'cancelled';
    ELSE
      v_from_status := CASE WHEN v_action = 'pause' THEN 'active' ELSE 'paused' END;
      v_to_status := CASE WHEN v_action = 'pause' THEN 'paused' ELSE 'active' END;
      IF v_sub.status = 'cancelled' THEN
        RAISE EXCEPTION '%', CASE WHEN v_action='pause' THEN '该订阅已取消，不能暂停' ELSE '该订阅已取消，不能恢复' END USING ERRCODE = '22023';
      END IF;
      IF v_sub.status = v_to_status THEN
        RAISE EXCEPTION '%', CASE WHEN v_action='pause' THEN '该订阅已处于暂停状态，无需重复暂停' ELSE '该订阅已是生效状态，无需重复恢复' END USING ERRCODE = '22023';
      END IF;
      IF v_sub.status <> v_from_status THEN RAISE EXCEPTION '该订阅当前状态不支持此操作' USING ERRCODE = '22023'; END IF;
    END IF;

    v_risk := CASE WHEN v_action IN ('resume','change_source') THEN 'red' ELSE 'yellow' END;
    v_status := CASE WHEN v_risk = 'red' THEN 'needs_verification' ELSE 'pending' END;
    v_now := clock_timestamp();
    v_ref := gen_random_uuid()::text;
    INSERT INTO public.rongzhi_bank_subscription_operations
      (ref_no, user_id, subscription_id, merchant, amount_cents, billing_cycle, action,
       from_status, to_status, subscription_version,
       from_account_id, from_account_name, from_account_type, from_masked_card,
       to_account_id, to_account_name, to_account_type, to_masked_card,
       risk_level, status, created_at, expires_at)
    VALUES
      (v_ref, p_user_id, v_sub.id, v_sub.merchant, v_sub.amount_cents, v_sub.billing_cycle, v_action,
       v_from_status, v_to_status, v_sub.version,
       v_from_id,
       v_from_snap->'account'->>'account_name',
       v_from_snap->'account'->>'account_type',
       v_from_snap->'card'->>'masked_card_number',
       v_to_id,
       v_to_snap->'account'->>'account_name',
       v_to_snap->'account'->>'account_type',
       v_to_snap->'card'->>'masked_card_number',
       v_risk, v_status, v_now, v_now + interval '5 minutes');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'subscription_operation', v_ref, 'create', v_status,
      jsonb_build_object('action', v_action, 'subscription_id', v_sub.id,
                         'to_account_id', v_to_id));
    RETURN jsonb_build_object('outcome','created','ref_no',v_ref,'status',v_status,'risk_level',v_risk);

  ELSIF p_op = 'confirm' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_subscription_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status IN ('pending','needs_verification') THEN
      SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
       WHERE id = v_op.subscription_id AND user_id = p_user_id FOR UPDATE;
      v_sub_found := FOUND;
      v_now := clock_timestamp();
      IF v_op.expires_at < v_now THEN
        UPDATE public.rongzhi_bank_subscription_operations SET status = 'expired'
         WHERE id = v_op.id AND status = v_op.status;
        RETURN jsonb_build_object('outcome','expired');
      END IF;
    ELSE
      v_now := clock_timestamp();
    END IF;
    IF v_op.status = 'completed' THEN RETURN jsonb_build_object('outcome','completed'); END IF;
    IF v_op.status <> 'pending' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    IF v_op.action NOT IN ('pause','cancel') THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    RETURN public.rongzhi_bank_internal_finalize_sub(p_user_id, v_ref, 'pending', v_now);

  ELSIF p_op = 'cancel' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_subscription_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    v_now := clock_timestamp();
    IF v_op.status = 'cancelled' THEN RETURN jsonb_build_object('outcome','cancelled'); END IF;
    IF v_op.status IN ('pending','needs_verification') AND v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    UPDATE public.rongzhi_bank_subscription_operations SET status = 'cancelled'
     WHERE id = v_op.id AND status IN ('pending','needs_verification');
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'subscription_operation', v_ref, 'cancel', 'success',
      jsonb_build_object('action', v_op.action, 'subscription_id', v_op.subscription_id));
    RETURN jsonb_build_object('outcome','cancelled');

  ELSIF p_op = 'verify' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    v_step := public.rongzhi_bank_internal_pos_bigint(p_payload, 'matched_step');
    SELECT * INTO v_op FROM public.rongzhi_bank_subscription_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status NOT IN ('pending','needs_verification') THEN
      RETURN jsonb_build_object('outcome',v_op.status);
    END IF;

    SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
     WHERE id = v_op.subscription_id AND user_id = p_user_id FOR UPDATE;
    v_sub_found := FOUND;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'expired' WHERE id = v_op.id AND status = v_op.status;
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status <> 'needs_verification' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    IF v_op.action NOT IN ('resume','change_source') THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;

    v_guard := public.rongzhi_bank_internal_verification_guard(p_user_id, clock_timestamp());
    IF (v_guard->>'locked')::boolean THEN
      RETURN jsonb_build_object('outcome','locked','locked_until',v_guard->'locked_until');
    END IF;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'expired'
       WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;

    -- 消费时间步前完成订阅版本 / 状态 / 新来源可用性校验；失效单不残留时间步。
    IF NOT v_sub_found THEN
      v_reason := '订阅不存在';
    ELSIF v_op.action = 'change_source' THEN
      IF v_sub.status = 'cancelled' THEN
        v_reason := '订阅已取消，不能更换扣款账户';
      ELSIF v_sub.version <> v_op.subscription_version OR v_sub.account_id <> v_op.from_account_id THEN
        v_reason := '订阅状态或原扣款账户已变化，该操作单已失效，请重新发起';
      ELSIF v_op.to_account_id = v_sub.account_id THEN
        v_reason := '新扣款账户与当前来源相同';
      ELSE
        SELECT currency INTO v_currency FROM public.rongzhi_bank_accounts WHERE id = v_op.from_account_id;
        v_check := public.rongzhi_bank_internal_source_usable(p_user_id, v_op.to_account_id, coalesce(v_currency,'CNY'));
        IF NOT (v_check->>'ok')::boolean THEN v_reason := v_check->>'reason'; END IF;
      END IF;
    ELSE
      IF v_sub.version <> v_op.subscription_version THEN
        UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed'
         WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(
          p_user_id, 'verification', v_ref, 'verify_failed', 'stale', jsonb_build_object('reason','subscription_version_changed'));
        RETURN jsonb_build_object('outcome','stale');
      ELSIF v_sub.status = v_op.to_status THEN
        UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed'
         WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(
          p_user_id, 'verification', v_ref, 'verify_failed', 'already', jsonb_build_object('reason','already_in_target_state'));
        RETURN jsonb_build_object('outcome','already');
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      UPDATE public.rongzhi_bank_subscription_operations SET status = 'failed'
       WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason', v_reason));
      RETURN jsonb_build_object('outcome','failed','reason',v_reason);
    END IF;

    BEGIN
      INSERT INTO public.rongzhi_bank_totp_used_steps (user_id, step, purpose, consumed_at)
      VALUES (p_user_id, v_step, 'resume', v_now);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('outcome','code_reused');
    END;
    v_res := public.rongzhi_bank_internal_finalize_sub(p_user_id, v_ref, 'needs_verification', v_now);
    IF v_res->>'outcome' = 'completed' THEN
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_success', 'success',
        jsonb_build_object('step', v_step, 'subscription_id', v_op.subscription_id, 'action', v_op.action));
      UPDATE public.rongzhi_bank_verification_failures
         SET fail_count = 0, locked_until = NULL WHERE user_id = p_user_id;
    END IF;
    RETURN v_res;
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 信用卡还款：create / cancel / verify（还款恒为红色强验证）
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_repay_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_scope text;
  v_from public.rongzhi_bank_accounts%ROWTYPE;
  v_ca public.rongzhi_bank_credit_accounts%ROWTYPE;
  v_stmt public.rongzhi_bank_statements%ROWTYPE;
  v_alloc record;
  v_op public.rongzhi_bank_repayment_operations%ROWTYPE;
  v_total bigint := 0;
  v_remaining bigint;
  v_ref text;
  v_statement_month text;
  v_primary public.rongzhi_bank_statements%ROWTYPE;
  v_count int := 0;
  v_changed int;
  v_step bigint;
  v_res jsonb;
  v_guard jsonb;
  v_tx_id bigint;
  v_from_id bigint;
  v_credit_id bigint;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'create' THEN
    v_scope := coalesce(p_payload->>'scope','statement');
    IF v_scope NOT IN ('statement','all_posted') THEN RAISE EXCEPTION '还款模式不合法' USING ERRCODE = '22023'; END IF;
    v_from_id := public.rongzhi_bank_internal_pos_bigint(p_payload, 'from_account_id');
    SELECT * INTO v_from FROM public.rongzhi_bank_accounts
     WHERE id = v_from_id AND user_id = p_user_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION '付款账户不存在或不可用' USING ERRCODE = '22023'; END IF;
    IF v_from.account_type <> 'deposit' THEN RAISE EXCEPTION '还款账户须为活期账户' USING ERRCODE = '22023'; END IF;

    IF v_scope = 'statement' THEN
      SELECT * INTO v_stmt FROM public.rongzhi_bank_statements
       WHERE id = public.rongzhi_bank_internal_pos_bigint(p_payload, 'statement_id') AND user_id = p_user_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION '未找到该账单' USING ERRCODE = '22023'; END IF;
      IF v_stmt.issued_at IS NULL THEN RAISE EXCEPTION '该账单尚未出账，暂不能还款' USING ERRCODE = '22023'; END IF;
      v_remaining := v_stmt.new_charges_cents - v_stmt.paid_cents;
      IF v_remaining <= 0 THEN RAISE EXCEPTION '该账单已结清，无需还款' USING ERRCODE = '22023'; END IF;
      SELECT * INTO v_ca FROM public.rongzhi_bank_credit_accounts
       WHERE id = v_stmt.credit_account_id AND user_id = p_user_id;
      IF NOT FOUND THEN RAISE EXCEPTION '信用账户不存在' USING ERRCODE = '22023'; END IF;
      v_total := v_remaining;
      v_primary := v_stmt;
    ELSE
      IF (p_payload ? 'credit_account_id') AND p_payload->>'credit_account_id' IS NOT NULL THEN
        v_credit_id := public.rongzhi_bank_internal_pos_bigint(p_payload, 'credit_account_id');
        SELECT * INTO v_ca FROM public.rongzhi_bank_credit_accounts
         WHERE id = v_credit_id AND user_id = p_user_id;
        IF NOT FOUND THEN RAISE EXCEPTION '信用账户不存在' USING ERRCODE = '22023'; END IF;
      ELSE
        SELECT * INTO v_ca FROM public.rongzhi_bank_credit_accounts
         WHERE user_id = p_user_id ORDER BY id LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION '未找到信用账户' USING ERRCODE = '22023'; END IF;
        IF (SELECT count(*) FROM public.rongzhi_bank_credit_accounts WHERE user_id = p_user_id) > 1 THEN
          RAISE EXCEPTION '存在多个信用账户，请先指定信用卡' USING ERRCODE = '22023';
        END IF;
      END IF;
      SELECT * INTO v_primary FROM public.rongzhi_bank_statements
       WHERE user_id = p_user_id AND credit_account_id = v_ca.id AND (new_charges_cents - paid_cents) > 0
       ORDER BY CASE WHEN issued_at IS NULL THEN 1 ELSE 0 END, statement_year, statement_month, id
       LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION '暂无可还款项（无已入账欠款）' USING ERRCODE = '22023'; END IF;
      SELECT coalesce(sum(new_charges_cents - paid_cents),0), count(*) INTO v_total, v_count
        FROM public.rongzhi_bank_statements
       WHERE user_id = p_user_id AND credit_account_id = v_ca.id AND (new_charges_cents - paid_cents) > 0;
      IF v_total <= 0 THEN RAISE EXCEPTION '暂无可还款项（无已入账欠款）' USING ERRCODE = '22023'; END IF;
    END IF;

    IF v_from.balance_cents < v_total THEN RAISE EXCEPTION '付款账户余额不足' USING ERRCODE = '22023'; END IF;
    v_now := clock_timestamp();
    v_ref := gen_random_uuid()::text;
    v_statement_month := to_char(make_date(v_primary.statement_year, v_primary.statement_month, 1), 'YYYY-MM');
    INSERT INTO public.rongzhi_bank_repayment_operations
      (ref_no, user_id, session_id, scope, from_account_id, from_account_name,
       credit_account_id, credit_account_name, statement_id, statement_month,
       amount_cents, statement_version, risk_level, status, created_at, expires_at)
    SELECT v_ref, p_user_id, nullif(p_payload->>'session_id',''), v_scope, v_from.id, v_from.account_name,
           v_ca.id, a.account_name, v_primary.id, v_statement_month,
           v_total, v_primary.version, 'red', 'needs_verification', v_now, v_now + interval '5 minutes'
      FROM public.rongzhi_bank_accounts a WHERE a.id = v_ca.account_id;
    INSERT INTO public.rongzhi_bank_repayment_allocations (ref_no, statement_id, amount_cents, statement_version)
    SELECT v_ref, s.id, s.new_charges_cents - s.paid_cents, s.version
      FROM public.rongzhi_bank_statements s
     WHERE s.user_id = p_user_id AND s.credit_account_id = v_ca.id AND (s.new_charges_cents - s.paid_cents) > 0
       AND (v_scope = 'all_posted' OR s.id = v_primary.id)
     ORDER BY CASE WHEN s.issued_at IS NULL THEN 1 ELSE 0 END, s.statement_year, s.statement_month, s.id;
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'repayment', v_ref, 'create', 'needs_verification',
      jsonb_build_object('scope', v_scope, 'amount_cents', v_total, 'allocations', (SELECT count(*) FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref)));
    RETURN jsonb_build_object('outcome','created','ref_no',v_ref,'status','needs_verification');

  ELSIF p_op = 'cancel' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    SELECT * INTO v_op FROM public.rongzhi_bank_repayment_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    v_now := clock_timestamp();
    IF v_op.status = 'cancelled' THEN RETURN jsonb_build_object('outcome','cancelled'); END IF;
    IF v_op.status = 'needs_verification' AND v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_repayment_operations SET status = 'expired' WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    IF v_op.status <> 'needs_verification' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    UPDATE public.rongzhi_bank_repayment_operations SET status = 'cancelled' WHERE id = v_op.id AND status = 'needs_verification';
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'repayment', v_ref, 'cancel', 'success', jsonb_build_object('statement_id', v_op.statement_id));
    RETURN jsonb_build_object('outcome','cancelled');

  ELSIF p_op = 'verify' THEN
    v_ref := public.rongzhi_bank_internal_text(p_payload, 'ref_no', 100);
    v_step := public.rongzhi_bank_internal_pos_bigint(p_payload, 'matched_step');
    SELECT * INTO v_op FROM public.rongzhi_bank_repayment_operations
     WHERE ref_no = v_ref AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_op.status <> 'needs_verification' THEN RETURN jsonb_build_object('outcome',v_op.status); END IF;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_repayment_operations SET status = 'expired' WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    v_guard := public.rongzhi_bank_internal_verification_guard(p_user_id, clock_timestamp());
    IF (v_guard->>'locked')::boolean THEN
      RETURN jsonb_build_object('outcome','locked','locked_until',v_guard->'locked_until');
    END IF;
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_repayment_operations SET status = 'expired' WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;

    v_total := v_op.amount_cents;
    IF v_op.scope = 'statement' THEN
      SELECT * INTO v_stmt FROM public.rongzhi_bank_statements
       WHERE id = v_op.statement_id AND user_id = p_user_id FOR UPDATE;
      IF NOT FOUND OR v_stmt.issued_at IS NULL THEN
        UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','statement_missing_or_unissued'));
        RETURN jsonb_build_object('outcome','failed','reason','目标账单不存在或尚未出账');
      END IF;
      v_remaining := v_stmt.new_charges_cents - v_stmt.paid_cents;
      IF v_stmt.version <> v_op.statement_version OR v_remaining <> v_op.amount_cents OR v_remaining <= 0 THEN
        UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'stale', jsonb_build_object('reason','statement_changed'));
        RETURN jsonb_build_object('outcome','stale','reason','账单金额已变化，请重新发起还款');
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref) THEN
        UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','allocations_missing'));
        RETURN jsonb_build_object('outcome','failed','reason','还款分配明细缺失');
      END IF;
      IF (SELECT coalesce(sum(amount_cents),0) FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref) <> v_total THEN
        UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
        PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'stale', jsonb_build_object('reason','allocation_total_changed'));
        RETURN jsonb_build_object('outcome','stale','reason','还款金额已变化，请重新发起还款');
      END IF;
      FOR v_alloc IN SELECT * FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref ORDER BY id LOOP
        SELECT * INTO v_stmt FROM public.rongzhi_bank_statements
         WHERE id = v_alloc.statement_id AND user_id = p_user_id FOR UPDATE;
        IF NOT FOUND THEN
          UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
          PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','allocation_statement_missing'));
          RETURN jsonb_build_object('outcome','failed','reason','目标账单不存在');
        END IF;
        v_remaining := v_stmt.new_charges_cents - v_stmt.paid_cents;
        IF v_stmt.version <> v_alloc.statement_version OR v_remaining <> v_alloc.amount_cents OR v_remaining <= 0 THEN
          UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
          PERFORM public.rongzhi_bank_internal_audit(p_user_id, 'verification', v_ref, 'verify_failed', 'stale', jsonb_build_object('reason','allocation_statement_changed'));
          RETURN jsonb_build_object('outcome','stale','reason','账单金额已变化，请重新发起还款');
        END IF;
      END LOOP;
    END IF;

    SELECT * INTO v_from FROM public.rongzhi_bank_accounts
     WHERE id = v_op.from_account_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND OR v_from.status <> 'active' OR v_from.account_type <> 'deposit' OR v_from.balance_cents < v_total THEN
      UPDATE public.rongzhi_bank_repayment_operations SET status = 'failed' WHERE id = v_op.id AND status = 'needs_verification';
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', v_ref, 'verify_failed', 'failed', jsonb_build_object('reason','from_account_unavailable'));
      RETURN jsonb_build_object('outcome','failed','reason','付款账户不可用或余额不足');
    END IF;

    -- 必要校验与锁定完成后才消费时间步；后续异常整体回滚。
    v_now := clock_timestamp();
    IF v_op.expires_at < v_now THEN
      UPDATE public.rongzhi_bank_repayment_operations SET status = 'expired' WHERE id = v_op.id AND status = 'needs_verification';
      RETURN jsonb_build_object('outcome','expired');
    END IF;
    BEGIN
      INSERT INTO public.rongzhi_bank_totp_used_steps (user_id, step, purpose, consumed_at)
      VALUES (p_user_id, v_step, 'repayment', v_now);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('outcome','code_reused');
    END;

    UPDATE public.rongzhi_bank_repayment_operations SET status = 'completed', confirmed_at = v_now
     WHERE id = v_op.id AND status = 'needs_verification';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RETURN jsonb_build_object('outcome','completed'); END IF;

    UPDATE public.rongzhi_bank_accounts SET balance_cents = balance_cents - v_total
     WHERE id = v_op.from_account_id AND user_id = p_user_id AND balance_cents >= v_total;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RAISE EXCEPTION 'deduct_failed' USING ERRCODE = 'P0004'; END IF;

    INSERT INTO public.rongzhi_bank_transactions
      (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind, repayment_ref)
    VALUES
      (p_user_id, v_op.from_account_id, 'expense', v_total, '还款', NULL, '信用卡还款', v_now, 'posted', 'repayment', v_ref)
    RETURNING id INTO v_tx_id;

    FOR v_alloc IN SELECT * FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref ORDER BY id LOOP
      INSERT INTO public.rongzhi_bank_statement_payments (user_id, statement_id, repayment_ref, amount_cents, paid_at)
      VALUES (p_user_id, v_alloc.statement_id, v_ref, v_alloc.amount_cents, v_now);
      UPDATE public.rongzhi_bank_statements
         SET paid_cents = paid_cents + v_alloc.amount_cents, version = version + 1
       WHERE id = v_alloc.statement_id;
    END LOOP;
    UPDATE public.rongzhi_bank_credit_accounts
       SET posted_outstanding_cents = posted_outstanding_cents - v_total
     WHERE id = v_op.credit_account_id AND posted_outstanding_cents >= v_total;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RAISE EXCEPTION 'outstanding_mismatch' USING ERRCODE = 'P0004'; END IF;

    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'repayment', v_ref, 'confirm', 'success',
      jsonb_build_object('scope', v_op.scope, 'amount_cents', v_total,
                         'allocations', (SELECT count(*) FROM public.rongzhi_bank_repayment_allocations WHERE ref_no = v_ref)));
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'verification', v_ref, 'verify_success', 'success',
      jsonb_build_object('step', v_step, 'repayment_ref', v_ref));
    UPDATE public.rongzhi_bank_verification_failures
       SET fail_count = 0, locked_until = NULL WHERE user_id = p_user_id;
    IF v_op.session_id IS NOT NULL THEN
      UPDATE public.rongzhi_bank_chat_sessions SET pending_repayment_ref = NULL
       WHERE id = v_op.session_id AND pending_repayment_ref = v_ref;
    END IF;
    RETURN jsonb_build_object('outcome','completed','transaction_id',to_jsonb(v_tx_id));
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 会话持久化：select / new / save_turn
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_chat_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session_id text;
  v_messages jsonb;
  v_base_seq int;
  v_count int;
  v_excess int;
  v_pointer text;
  v_turn_id text;
  v_base_version bigint;
  v_new_messages jsonb;
  v_context jsonb;
  v_session_version bigint;
  v_last_turn_id text;
  v_outcome text;
  v_created bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'select' THEN
    v_session_id := public.rongzhi_bank_internal_text(p_payload, 'session_id', 100);
    IF NOT EXISTS (SELECT 1 FROM public.rongzhi_bank_chat_sessions WHERE id = v_session_id AND user_id = p_user_id) THEN
      RETURN jsonb_build_object('outcome','not_found');
    END IF;
    INSERT INTO public.rongzhi_bank_chat_state (user_id, current_session_id)
    VALUES (p_user_id, v_session_id)
    ON CONFLICT (user_id) DO UPDATE SET current_session_id = excluded.current_session_id;
    RETURN jsonb_build_object('outcome','selected','session_id',v_session_id);

  ELSIF p_op = 'new' THEN
    DELETE FROM public.rongzhi_bank_chat_state WHERE user_id = p_user_id;
    RETURN jsonb_build_object('outcome','new');

  ELSIF p_op = 'save_turn' THEN
    v_session_id := public.rongzhi_bank_internal_text(p_payload, 'session_id', 100);
    IF EXISTS (SELECT 1 FROM public.rongzhi_bank_chat_sessions WHERE id = v_session_id AND user_id <> p_user_id) THEN
      RAISE EXCEPTION 'session_not_owned' USING ERRCODE = '42501';
    END IF;
    v_turn_id := public.rongzhi_bank_internal_text(p_payload, 'turn_id', 100);
    v_base_version := coalesce((p_payload->>'base_version')::bigint, 0);
    v_messages := coalesce(p_payload->'messages', '[]'::jsonb);
    v_new_messages := coalesce(p_payload->'new_messages', '[]'::jsonb);
    IF jsonb_typeof(v_messages) <> 'array' OR jsonb_typeof(v_new_messages) <> 'array' THEN
      RAISE EXCEPTION 'invalid_parameters: messages' USING ERRCODE = '22023';
    END IF;
    v_pointer := p_payload->>'pointer_at_start';

    -- 先确保行存在，再以行锁串行化同一会话的保存；版本检查 + 合并避免旧上下文覆盖已完成轮次。
    INSERT INTO public.rongzhi_bank_chat_sessions
      (id, user_id, messages_json, pending_transfer_ref, pending_card_op_ref,
       pending_subscription_op_ref, pending_repayment_ref, created_at, last_active_at, version, last_turn_id)
    VALUES
      (v_session_id, p_user_id, '[]'::jsonb,
       nullif(p_payload->>'pending_transfer_ref',''),
       nullif(p_payload->>'pending_card_op_ref',''),
       nullif(p_payload->>'pending_subscription_op_ref',''),
       nullif(p_payload->>'pending_repayment_ref',''),
       coalesce((p_payload->>'created_at')::bigint, v_created), v_created, 0, NULL)
    ON CONFLICT (id) DO NOTHING;

    SELECT messages_json, version, last_turn_id
      INTO v_context, v_session_version, v_last_turn_id
      FROM public.rongzhi_bank_chat_sessions
     WHERE id = v_session_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0002'; END IF;

    IF v_last_turn_id IS NOT DISTINCT FROM v_turn_id THEN
      RETURN jsonb_build_object('outcome','duplicate','session_id',v_session_id,
                                'session_version',v_session_version,'messages',v_context);
    END IF;

    IF v_session_version = v_base_version THEN
      v_context := v_messages;
      v_outcome := 'saved';
    ELSE
      -- 过期写入：保留数据库中的已完成轮次，只追加本轮新增消息，不静默覆盖。
      v_context := coalesce(v_context, '[]'::jsonb) || v_new_messages;
      v_outcome := 'merged';
    END IF;

    UPDATE public.rongzhi_bank_chat_sessions
       SET messages_json = v_context,
           pending_transfer_ref = nullif(p_payload->>'pending_transfer_ref',''),
           pending_card_op_ref = nullif(p_payload->>'pending_card_op_ref',''),
           pending_subscription_op_ref = nullif(p_payload->>'pending_subscription_op_ref',''),
           pending_repayment_ref = nullif(p_payload->>'pending_repayment_ref',''),
           last_active_at = v_created,
           version = v_session_version + 1,
           last_turn_id = v_turn_id
     WHERE id = v_session_id AND user_id = p_user_id;

    SELECT coalesce(max(seq),0) INTO v_base_seq
      FROM public.rongzhi_bank_chat_messages WHERE session_id = v_session_id;
    INSERT INTO public.rongzhi_bank_chat_messages
      (session_id, user_id, seq, role, text, tool_records_json, incomplete, error, created_at, turn_id)
    VALUES (v_session_id, p_user_id, v_base_seq + 1, 'user', p_payload->>'user_text', NULL, 0, NULL, v_created, v_turn_id)
    ON CONFLICT (session_id, turn_id, role) WHERE turn_id IS NOT NULL DO NOTHING;
    INSERT INTO public.rongzhi_bank_chat_messages
      (session_id, user_id, seq, role, text, tool_records_json, incomplete, error, created_at, turn_id)
    VALUES (v_session_id, p_user_id, v_base_seq + 2, 'assistant', p_payload->>'reply',
            p_payload->'tool_records',
            CASE WHEN (p_payload->>'incomplete')::boolean THEN 1 ELSE 0 END, NULL, v_created, v_turn_id)
    ON CONFLICT (session_id, turn_id, role) WHERE turn_id IS NOT NULL DO NOTHING;
    SELECT count(*) INTO v_count FROM public.rongzhi_bank_chat_messages WHERE session_id = v_session_id;
    v_excess := v_count - 200;
    IF v_excess > 0 THEN
      DELETE FROM public.rongzhi_bank_chat_messages
       WHERE id IN (SELECT id FROM public.rongzhi_bank_chat_messages
                     WHERE session_id = v_session_id ORDER BY seq, id LIMIT v_excess);
    END IF;
    IF (SELECT current_session_id FROM public.rongzhi_bank_chat_state WHERE user_id = p_user_id) IS NOT DISTINCT FROM v_pointer THEN
      INSERT INTO public.rongzhi_bank_chat_state (user_id, current_session_id)
      VALUES (p_user_id, v_session_id)
      ON CONFLICT (user_id) DO UPDATE SET current_session_id = excluded.current_session_id;
    END IF;
    RETURN jsonb_build_object('outcome',v_outcome,'session_id',v_session_id,
                              'session_version',v_session_version + 1,'messages',v_context);
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 强验证：失败计数 / 重置 / 一次性绑定（绑定仅供后端 CLI 调用）
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_verification_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count int;
  v_locked timestamptz;
  v_remaining int;
  v_step bigint;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'record_failure' THEN
    v_now := clock_timestamp();
    INSERT INTO public.rongzhi_bank_verification_failures (user_id, fail_count, locked_until)
    VALUES (p_user_id, 0, NULL)
    ON CONFLICT (user_id) DO NOTHING;
    SELECT fail_count, locked_until INTO v_count, v_locked
      FROM public.rongzhi_bank_verification_failures
     WHERE user_id = p_user_id
     FOR UPDATE;
    -- 晚到的失败请求不得解除仍然有效的锁定，也不得改写失败计数。
    IF v_locked IS NOT NULL AND v_locked > v_now THEN
      RETURN jsonb_build_object('locked', true, 'remaining', 0, 'locked_until', to_jsonb(v_locked), 'late', true);
    END IF;
    v_count := coalesce(v_count, 0) + 1;
    IF v_count >= 5 THEN
      v_locked := v_now + interval '15 minutes';
      UPDATE public.rongzhi_bank_verification_failures
         SET fail_count = 0, locked_until = v_locked
       WHERE user_id = p_user_id;
      PERFORM public.rongzhi_bank_internal_audit(
        p_user_id, 'verification', NULL, 'locked', 'locked', jsonb_build_object('locked_until', v_locked));
      RETURN jsonb_build_object('locked', true, 'remaining', 0, 'locked_until', to_jsonb(v_locked));
    END IF;
    UPDATE public.rongzhi_bank_verification_failures
       SET fail_count = v_count, locked_until = NULL
     WHERE user_id = p_user_id;
    v_remaining := 5 - v_count;
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'verification', NULL, 'verify_failed', 'failed', jsonb_build_object('fail_count', v_count));
    RETURN jsonb_build_object('locked', false, 'remaining', v_remaining);

  ELSIF p_op = 'reset' THEN
    UPDATE public.rongzhi_bank_verification_failures
       SET fail_count = 0, locked_until = NULL WHERE user_id = p_user_id;
    RETURN jsonb_build_object('outcome','reset');

  ELSIF p_op = 'bind' THEN
    IF EXISTS (SELECT 1 FROM public.rongzhi_bank_verification_bindings WHERE user_id = p_user_id AND enabled = 1) THEN
      RETURN jsonb_build_object('outcome','already_bound');
    END IF;
    v_step := coalesce((p_payload->>'matched_step')::bigint, 0);
    IF v_step < 0 THEN RAISE EXCEPTION 'invalid_parameters: matched_step' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.rongzhi_bank_verification_bindings
      (user_id, password_salt, password_hash, totp_secret_enc, enabled, bound_at)
    VALUES
      (p_user_id, public.rongzhi_bank_internal_text(p_payload,'password_salt',200),
       public.rongzhi_bank_internal_text(p_payload,'password_hash',500),
       coalesce(p_payload->'totp_secret_enc','{}'::jsonb), 1, v_now)
    ON CONFLICT (user_id) DO UPDATE SET
      password_salt = excluded.password_salt, password_hash = excluded.password_hash,
      totp_secret_enc = excluded.totp_secret_enc, enabled = 1, bound_at = excluded.bound_at;
    INSERT INTO public.rongzhi_bank_totp_used_steps (user_id, step, purpose, consumed_at)
    VALUES (p_user_id, v_step, 'bind', v_now)
    ON CONFLICT (user_id, step) DO NOTHING;
    PERFORM public.rongzhi_bank_internal_audit(
      p_user_id, 'verification', NULL, 'bind', 'success', jsonb_build_object('step', v_step));
    RETURN jsonb_build_object('outcome','bound');
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 独立演示数据（幂等：已有账户即不写入；不在启动时自动调用）
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_seed_v1(p_user_id bigint DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user bigint;
  v_acct1 bigint; v_acct2 bigint; v_credit_acct bigint;
  v_card1 bigint; v_card2 bigint; v_card3 bigint;
  v_ca bigint; v_stmt1 bigint; v_stmt2 bigint; v_stmt3 bigint;
  v_month_start timestamptz; v_prev1 timestamptz; v_prev2 timestamptz;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_user FROM public.rongzhi_bank_users WHERE id = p_user_id;
  IF NOT FOUND THEN
    INSERT INTO public.rongzhi_bank_users (id, name) VALUES (p_user_id, '张三');
    v_user := p_user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.rongzhi_bank_accounts WHERE user_id = v_user) THEN
    RETURN jsonb_build_object('seeded', false, 'reason', 'already_initialized');
  END IF;

  v_month_start := date_trunc('month', v_now AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_prev1 := v_month_start - interval '1 month';
  v_prev2 := v_month_start - interval '2 months';

  INSERT INTO public.rongzhi_bank_accounts
    (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
  VALUES (v_user, '日常活期账户', 500000, 1000000, 'CNY', 'deposit', 'active', '2024-01-15')
  RETURNING id INTO v_acct1;
  INSERT INTO public.rongzhi_bank_accounts
    (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
  VALUES (v_user, '储蓄活期账户', 100000, 250000, 'CNY', 'deposit', 'active', '2024-06-01')
  RETURNING id INTO v_acct2;
  INSERT INTO public.rongzhi_bank_accounts
    (user_id, account_name, opening_balance_cents, balance_cents, currency, account_type, status, opened_on)
  VALUES (v_user, '信用卡账户', 0, 0, 'CNY', 'credit', 'active', '2024-09-01')
  RETURNING id INTO v_credit_acct;

  INSERT INTO public.rongzhi_bank_cards
    (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
  VALUES (v_user, v_acct1, '6222 **** **** 1001', '借记卡', 'active', 500000, '2024-01-15')
  RETURNING id INTO v_card1;
  INSERT INTO public.rongzhi_bank_cards
    (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
  VALUES (v_user, v_acct2, '6222 **** **** 1002', '借记卡', 'active', 300000, '2024-06-01')
  RETURNING id INTO v_card2;
  INSERT INTO public.rongzhi_bank_cards
    (user_id, account_id, masked_card_number, card_type, status, daily_limit_cents, issued_on)
  VALUES (v_user, v_credit_acct, '6225 **** **** 3001', '信用卡', 'active', 200000, '2024-09-01')
  RETURNING id INTO v_card3;

  INSERT INTO public.rongzhi_bank_subscriptions
    (user_id, account_id, merchant, amount_cents, billing_cycle, next_billing_date, status)
  VALUES
    (v_user, v_acct1, '云音乐会员', 1500, 'monthly', to_char((v_now AT TIME ZONE 'Asia/Shanghai')::date + 5, 'YYYY-MM-DD'), 'active'),
    (v_user, v_acct1, '视频平台会员', 2500, 'monthly', to_char((v_now AT TIME ZONE 'Asia/Shanghai')::date + 9, 'YYYY-MM-DD'), 'active'),
    (v_user, v_acct1, '云存储', 900, 'monthly', to_char((v_now AT TIME ZONE 'Asia/Shanghai')::date + 12, 'YYYY-MM-DD'), 'active'),
    (v_user, v_acct2, '健身会员', 19900, 'monthly', to_char((v_now AT TIME ZONE 'Asia/Shanghai')::date + 14, 'YYYY-MM-DD'), 'active'),
    (v_user, v_acct2, '新闻订阅', 2800, 'yearly', to_char((v_now AT TIME ZONE 'Asia/Shanghai')::date + 60, 'YYYY-MM-DD'), 'paused'),
    (v_user, v_acct1, '旧会员服务', 1200, 'monthly', NULL, 'cancelled');

  INSERT INTO public.rongzhi_bank_transfer_recipients (name, masked_account)
  VALUES ('李雷', '**** **** **** 2001'), ('韩梅梅', '**** **** **** 2002'), ('王五', '**** **** **** 2003');

  INSERT INTO public.rongzhi_bank_transactions
    (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, status, flow_kind)
  VALUES
    (v_user, v_acct1, 'income',  1280000, '收入', '薪资发放', '月度工资', v_month_start + interval '4 days 1 hour', 'posted', 'external'),
    (v_user, v_acct1, 'expense',  500000, '餐饮', '家庭餐饮', '日常餐饮', v_month_start + interval '10 days 3 hours', 'posted', 'external'),
    (v_user, v_acct1, 'expense',  180000, '购物', '电商平台', '生活用品', v_month_start + interval '15 days 6 hours', 'posted', 'external'),
    (v_user, v_acct1, 'expense',  100000, '交通', '出行服务', '交通出行', v_month_start + interval '18 days 2 hours', 'posted', 'external'),
    (v_user, v_acct2, 'income',   300000, '收入', '理财收益', '稳健理财收益', v_month_start + interval '6 days 4 hours', 'posted', 'external'),
    (v_user, v_acct2, 'expense',  150000, '娱乐', '影院', '休闲娱乐', v_month_start + interval '16 days 7 hours', 'posted', 'external');
  INSERT INTO public.rongzhi_bank_transactions
    (user_id, account_id, direction, amount_cents, category, merchant, description, transaction_at, posted_at, status, flow_kind)
  VALUES
    (v_user, v_credit_acct, 'expense', 50000, '购物', '线上商城', '信用卡消费（已结清账期）', v_prev2 + interval '9 days 3 hours', v_prev2 + interval '9 days 3 hours', 'posted', 'external'),
    (v_user, v_credit_acct, 'expense', 120000, '购物', '线上商城', '信用卡消费（已出账未还）', v_prev1 + interval '9 days 3 hours', v_prev1 + interval '9 days 3 hours', 'posted', 'external'),
    (v_user, v_credit_acct, 'expense', 30000, '餐饮', '餐厅', '信用卡消费（未出账已入账）', v_month_start + interval '9 days 5 hours', v_month_start + interval '9 days 5 hours', 'posted', 'external'),
    (v_user, v_credit_acct, 'expense', 30000, '餐饮', '餐厅', '信用卡消费（待入账占用）', v_month_start + interval '19 days 5 hours', NULL, 'pending', 'external');

  INSERT INTO public.rongzhi_bank_credit_accounts
    (user_id, account_id, credit_limit_cents, posted_outstanding_cents, pending_occupied_cents)
  VALUES (v_user, v_credit_acct, 500000, 150000, 30000)
  RETURNING id INTO v_ca;

  -- 已结清账期（上月账单，已还款）
  INSERT INTO public.rongzhi_bank_statements
    (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents)
  SELECT v_user, v_ca,
         extract(year FROM (v_prev2 AT TIME ZONE 'Asia/Shanghai'))::int,
         extract(month FROM (v_prev2 AT TIME ZONE 'Asia/Shanghai'))::int,
         v_prev2, v_prev1, v_prev1, v_prev1, v_prev1 + interval '24 days', 50000, 50000
  RETURNING id INTO v_stmt1;

  -- 已出账未还（本月 1 日出账；消费发生在上一账期内）
  INSERT INTO public.rongzhi_bank_statements
    (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents)
  SELECT v_user, v_ca,
         extract(year FROM (v_prev1 AT TIME ZONE 'Asia/Shanghai'))::int,
         extract(month FROM (v_prev1 AT TIME ZONE 'Asia/Shanghai'))::int,
         v_prev1, v_month_start, v_month_start, v_month_start, v_month_start + interval '24 days', 120000, 0
  RETURNING id INTO v_stmt2;

  -- 未出账（本月消费已入账，下月 1 日才出账）
  INSERT INTO public.rongzhi_bank_statements
    (user_id, credit_account_id, statement_year, statement_month, period_start, period_end, issued_on, issued_at, due_on, new_charges_cents, paid_cents)
  SELECT v_user, v_ca,
         extract(year FROM (v_month_start AT TIME ZONE 'Asia/Shanghai'))::int,
         extract(month FROM (v_month_start AT TIME ZONE 'Asia/Shanghai'))::int,
         v_month_start, v_month_start + interval '1 month', v_month_start + interval '1 month', NULL,
         (v_month_start + interval '1 month') + interval '24 days', 30000, 0
  RETURNING id INTO v_stmt3;

  INSERT INTO public.rongzhi_bank_statement_payments (user_id, statement_id, repayment_ref, amount_cents, paid_at)
  VALUES (v_user, v_stmt1, 'seed-settled-repayment', 50000, v_prev1);

  PERFORM setval(pg_get_serial_sequence('public.rongzhi_bank_users','id'),
                 (SELECT max(id) FROM public.rongzhi_bank_users));
  RETURN jsonb_build_object('seeded', true, 'user_id', v_user,
    'accounts', 3, 'cards', 3, 'subscriptions', 6, 'transactions', 10,
    'credit_accounts', 1, 'statements', 3, 'verification_bound', false);
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 跨场景任务（唯一模板：subscription_review）
-- ——————————————————————————————————————————————————————————————

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_monthly_analytics(p_user_id bigint, p_month text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_income bigint := 0;
  v_expense bigint := 0;
  v_repayment bigint := 0;
  v_posted int := 0;
  v_pending int := 0;
  v_pending_amount bigint := 0;
  v_income_cats jsonb;
  v_expense_cats jsonb;
BEGIN
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION '月份格式应为 YYYY-MM（月份 01-12）' USING ERRCODE = '22023';
  END IF;
  v_start := (to_date(p_month || '-01','YYYY-MM-DD')::timestamp) AT TIME ZONE 'Asia/Shanghai';
  v_end := v_start + interval '1 month';

  SELECT coalesce(sum(amount_cents) FILTER (WHERE direction='income'),0),
         coalesce(sum(amount_cents) FILTER (WHERE direction='expense'),0),
         count(*) FILTER (WHERE direction='income' OR direction='expense')
    INTO v_income, v_expense, v_posted
    FROM public.rongzhi_bank_transactions
   WHERE user_id = p_user_id AND transaction_at >= v_start AND transaction_at < v_end
     AND status = 'posted' AND flow_kind <> 'repayment' AND transaction_at <= clock_timestamp();
  SELECT coalesce(sum(amount_cents),0) INTO v_repayment
    FROM public.rongzhi_bank_transactions
   WHERE user_id = p_user_id AND transaction_at >= v_start AND transaction_at < v_end AND flow_kind = 'repayment';
  SELECT count(*), coalesce(sum(amount_cents),0) INTO v_pending, v_pending_amount
    FROM public.rongzhi_bank_transactions
   WHERE user_id = p_user_id AND transaction_at >= v_start AND transaction_at < v_end AND status = 'pending';
  SELECT coalesce(jsonb_agg(jsonb_build_object('category',category,'amount_cents',amt,'count',cnt) ORDER BY amt DESC), '[]'::jsonb)
    INTO v_income_cats
    FROM (SELECT category, sum(amount_cents) amt, count(*) cnt FROM public.rongzhi_bank_transactions
           WHERE user_id=p_user_id AND transaction_at>=v_start AND transaction_at<v_end
             AND status='posted' AND flow_kind<>'repayment' AND direction='income' AND transaction_at<=clock_timestamp()
           GROUP BY category) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('category',category,'amount_cents',amt,'count',cnt) ORDER BY amt DESC), '[]'::jsonb)
    INTO v_expense_cats
    FROM (SELECT category, sum(amount_cents) amt, count(*) cnt FROM public.rongzhi_bank_transactions
           WHERE user_id=p_user_id AND transaction_at>=v_start AND transaction_at<v_end
             AND status='posted' AND flow_kind<>'repayment' AND direction='expense' AND transaction_at<=clock_timestamp()
           GROUP BY category) x;

  RETURN jsonb_build_object(
    'month', p_month, 'timezone', 'Asia/Shanghai',
    'as_of', to_jsonb(clock_timestamp()),
    'income_cents', v_income, 'expense_cents', v_expense, 'repayment_cents', v_repayment,
    'net_cents', v_income - v_expense, 'posted_count', v_posted,
    'pending', jsonb_build_object('count', v_pending, 'amount_cents', v_pending_amount),
    'income_by_category', v_income_cats, 'expense_by_category', v_expense_cats
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_set_node(
  p_task_id bigint, p_key text, p_status text, p_result jsonb DEFAULT NULL,
  p_error text DEFAULT NULL, p_now_ms bigint DEFAULT NULL
) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.rongzhi_bank_agent_task_nodes
     SET status = p_status, result_json = p_result, error = p_error,
         completed_at = CASE WHEN p_status = 'completed' THEN p_now_ms ELSE NULL END
   WHERE task_id = p_task_id AND node_key = p_key;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_reset_selection(p_task_id bigint, p_now_ms bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.rongzhi_bank_agent_task_nodes
     SET status='pending', result_json=NULL, error=NULL, completed_at=NULL
   WHERE task_id = p_task_id
     AND node_key IN ('await_selection','prepare_pause','await_confirmation','verify_result','summary');
  UPDATE public.rongzhi_bank_agent_tasks
     SET status='waiting_selection', selected_subscription_id=NULL, op_ref=NULL,
         failure_reason=NULL, completed_at=NULL, updated_at=p_now_ms
   WHERE id = p_task_id;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_run_readonly_nodes(p_user_id bigint, p_task_id bigint, p_month text, p_now_ms bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_node public.rongzhi_bank_agent_task_nodes%ROWTYPE;
  v_monthly jsonb;
  v_subs jsonb;
BEGIN
  SELECT * INTO v_node FROM public.rongzhi_bank_agent_task_nodes
   WHERE task_id=p_task_id AND node_key='monthly_analysis';
  IF FOUND AND v_node.status='pending' THEN
    v_monthly := public.rongzhi_bank_internal_monthly_analytics(p_user_id, p_month);
    PERFORM public.rongzhi_bank_internal_set_node(p_task_id,'monthly_analysis','completed',v_monthly,NULL,p_now_ms);
  END IF;
  SELECT * INTO v_node FROM public.rongzhi_bank_agent_task_nodes
   WHERE task_id=p_task_id AND node_key='subscription_query';
  IF FOUND AND v_node.status='pending' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) INTO v_subs
      FROM public.rongzhi_bank_subscriptions s
     WHERE s.user_id=p_user_id AND s.status='active';
    PERFORM public.rongzhi_bank_internal_set_node(
      p_task_id,'subscription_query','completed',
      jsonb_build_object('month',p_month,'as_of',to_jsonb(clock_timestamp()),
                         'active_subscriptions',v_subs,'count',jsonb_array_length(v_subs)),NULL,p_now_ms);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_build_summary(p_user_id bigint, p_task_id bigint, p_now_ms bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH t AS (SELECT * FROM public.rongzhi_bank_agent_tasks WHERE id=p_task_id AND user_id=p_user_id),
       m AS (SELECT result_json FROM public.rongzhi_bank_agent_task_nodes
              WHERE task_id=p_task_id AND node_key='monthly_analysis'),
       s AS (SELECT x.* FROM public.rongzhi_bank_subscriptions x JOIN t ON t.selected_subscription_id=x.id),
       o AS (SELECT x.* FROM public.rongzhi_bank_subscription_operations x JOIN t ON t.op_ref=x.ref_no)
  SELECT jsonb_build_object(
    'month', (SELECT month FROM t),
    'expense_cents', (SELECT (result_json->>'expense_cents')::bigint FROM m),
    'posted_count', (SELECT (result_json->>'posted_count')::int FROM m),
    'analyzed_as_of', (SELECT result_json->>'as_of' FROM m),
    'action', 'pause',
    'merchant', (SELECT merchant FROM s),
    'amount_cents', (SELECT amount_cents FROM s),
    'billing_cycle', (SELECT billing_cycle FROM s),
    'subscription_status', (SELECT status FROM s),
    'op_ref', (SELECT op_ref FROM t),
    'op_status', (SELECT status FROM o),
    'confirmed_at', (SELECT to_jsonb(confirmed_at) FROM o),
    'note', '暂停成功不等于已退款或已实现某金额的节省；不同扣费周期不能直接相加成月度费用。',
    'as_of', to_jsonb(to_timestamp(p_now_ms / 1000.0))
  );
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_internal_reconcile_task(p_user_id bigint, p_task_no text, p_now_ms bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_task public.rongzhi_bank_agent_tasks%ROWTYPE;
  v_op public.rongzhi_bank_subscription_operations%ROWTYPE;
  v_sub public.rongzhi_bank_subscriptions%ROWTYPE;
  v_op_status text;
  v_summary jsonb;
BEGIN
  SELECT * INTO v_task FROM public.rongzhi_bank_agent_tasks
   WHERE task_no=p_task_no AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_task.status IN ('completed','cancelled','manual','paused','failed') THEN RETURN; END IF;

  IF v_task.status='waiting_selection' THEN
    PERFORM public.rongzhi_bank_internal_run_readonly_nodes(p_user_id, v_task.id, v_task.month, p_now_ms);
    RETURN;
  END IF;

  IF v_task.status='waiting_confirmation' THEN
    SELECT * INTO v_op FROM public.rongzhi_bank_subscription_operations
     WHERE ref_no=v_task.op_ref AND user_id=p_user_id;
    IF NOT FOUND THEN
      PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'verify_result','failed',NULL,'操作单不存在',p_now_ms);
      UPDATE public.rongzhi_bank_agent_tasks SET status='failed', failure_reason='关联操作单不存在，任务终止', updated_at=p_now_ms WHERE id=v_task.id;
      RETURN;
    END IF;
    v_op_status := CASE
      WHEN v_op.status IN ('pending','needs_verification') AND v_op.expires_at < clock_timestamp() THEN 'expired'
      ELSE v_op.status END;
    IF v_op_status='completed' THEN
      SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
       WHERE id=v_task.selected_subscription_id AND user_id=p_user_id;
      IF NOT FOUND OR v_sub.status<>'paused' THEN
        PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'verify_result','failed',NULL,'订阅状态与操作单不一致',p_now_ms);
        UPDATE public.rongzhi_bank_agent_tasks SET status='failed', failure_reason='订阅状态与操作单不一致，任务终止', updated_at=p_now_ms WHERE id=v_task.id;
        RETURN;
      END IF;
      PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'await_confirmation','completed',
        jsonb_build_object('ref_no',v_op.ref_no,'status',v_op_status),NULL,p_now_ms);
      PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'verify_result','completed',
        jsonb_build_object('ref_no',v_op.ref_no,'subscription_status',v_sub.status),NULL,p_now_ms);
      v_summary := public.rongzhi_bank_internal_build_summary(p_user_id, v_task.id, p_now_ms);
      PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'summary','completed',v_summary,NULL,p_now_ms);
      UPDATE public.rongzhi_bank_agent_tasks
         SET status='completed', result_summary=v_summary, failure_reason=NULL,
             completed_at=p_now_ms, updated_at=p_now_ms WHERE id=v_task.id;
      RETURN;
    END IF;
    IF v_op_status IN ('cancelled','expired') THEN
      PERFORM public.rongzhi_bank_internal_reset_selection(v_task.id, p_now_ms);
      RETURN;
    END IF;
    IF v_op_status='failed' THEN
      PERFORM public.rongzhi_bank_internal_set_node(v_task.id,'verify_result','failed',NULL,
        '操作单失效（订阅状态已变化或已处于目标状态）',p_now_ms);
      UPDATE public.rongzhi_bank_agent_tasks
         SET status='failed', failure_reason='暂停操作单失效：订阅状态已变化或已处于目标状态，未执行', updated_at=p_now_ms
       WHERE id=v_task.id;
      RETURN;
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rongzhi_bank_task_write_v1(
  p_user_id bigint, p_op text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_task public.rongzhi_bank_agent_task_nodes%ROWTYPE;
  v_task_row public.rongzhi_bank_agent_tasks%ROWTYPE;
  v_task_no text;
  v_month text;
  v_sub_id bigint;
  v_sub public.rongzhi_bank_subscriptions%ROWTYPE;
  v_op_res jsonb;
  v_ref text;
  v_summary jsonb;
  v_monthly jsonb;
  v_subs jsonb;
  v_node_keys text[] := ARRAY['monthly_analysis','subscription_query','await_selection','prepare_pause','await_confirmation','verify_result','summary'];
  v_deps jsonb[] := ARRAY['[]'::jsonb,'[]'::jsonb,'["monthly_analysis","subscription_query"]'::jsonb,'["await_selection"]'::jsonb,
                          '["prepare_pause"]'::jsonb,'["await_confirmation"]'::jsonb,'["verify_result"]'::jsonb];
  i int;
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN RAISE EXCEPTION 'invalid_parameters: user' USING ERRCODE = '22023'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  IF p_op = 'create' THEN
    v_month := p_payload->>'month';
    IF v_month IS NULL OR v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION '月份格式应为 YYYY-MM（月份 01-12）' USING ERRCODE = '22023';
    END IF;
    v_task_no := 'task-' || gen_random_uuid()::text;
    INSERT INTO public.rongzhi_bank_agent_tasks
      (task_no, user_id, kind, status, month, session_id, created_at, updated_at)
    VALUES (v_task_no, p_user_id, 'subscription_review', 'waiting_selection', v_month,
            nullif(p_payload->>'session_id',''), v_now_ms, v_now_ms)
    RETURNING * INTO v_task_row;
    FOR i IN 1..7 LOOP
      INSERT INTO public.rongzhi_bank_agent_task_nodes
        (task_id, node_key, seq, status, depends_on)
      VALUES (v_task_row.id, v_node_keys[i], i-1, 'pending', v_deps[i]);
    END LOOP;
    PERFORM public.rongzhi_bank_internal_run_readonly_nodes(p_user_id, v_task_row.id, v_month, v_now_ms);
    RETURN jsonb_build_object('outcome','created','task_no',v_task_no);

  ELSIF p_op = 'reconcile' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    PERFORM public.rongzhi_bank_internal_reconcile_task(p_user_id, v_task_no, v_now_ms);
    RETURN jsonb_build_object('outcome','reconciled','task_no',v_task_no);

  ELSIF p_op = 'reconcile_all' THEN
    FOR v_task_row IN SELECT * FROM public.rongzhi_bank_agent_tasks WHERE user_id=p_user_id LOOP
      PERFORM public.rongzhi_bank_internal_reconcile_task(p_user_id, v_task_row.task_no, v_now_ms);
    END LOOP;
    RETURN jsonb_build_object('outcome','reconciled');

  ELSIF p_op = 'select' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    v_sub_id := public.rongzhi_bank_internal_pos_bigint(p_payload, 'subscription_id');
    SELECT * INTO v_task_row FROM public.rongzhi_bank_agent_tasks
     WHERE task_no=v_task_no AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_task_row.status<>'waiting_selection' THEN RETURN jsonb_build_object('outcome','bad_state'); END IF;
    SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
     WHERE id=v_sub_id AND user_id=p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION '未找到该订阅' USING ERRCODE = '22023'; END IF;
    IF v_sub.status<>'active' THEN RAISE EXCEPTION '该订阅当前不是生效状态，不能暂停' USING ERRCODE = '22023'; END IF;
    BEGIN
      v_op_res := public.rongzhi_bank_sub_write_v1(p_user_id,'create',
        jsonb_build_object('subscription_id',v_sub.id,'action','pause'));
    EXCEPTION WHEN SQLSTATE '22023' THEN
      PERFORM public.rongzhi_bank_internal_set_node(v_task_row.id,'prepare_pause','failed',NULL,SQLERRM,v_now_ms);
      UPDATE public.rongzhi_bank_agent_tasks
         SET status='failed', failure_reason='准备暂停单失败：'||SQLERRM, updated_at=v_now_ms WHERE id=v_task_row.id;
      RETURN jsonb_build_object('outcome','failed');
    END;
    v_ref := v_op_res->>'ref_no';
    PERFORM public.rongzhi_bank_internal_set_node(v_task_row.id,'await_selection','completed',
      jsonb_build_object('subscription_id',v_sub.id,'merchant',v_sub.merchant),NULL,v_now_ms);
    PERFORM public.rongzhi_bank_internal_set_node(v_task_row.id,'prepare_pause','completed',
      jsonb_build_object('ref_no',v_ref),NULL,v_now_ms);
    UPDATE public.rongzhi_bank_agent_tasks
       SET status='waiting_confirmation', selected_subscription_id=v_sub.id, op_ref=v_ref,
           failure_reason=NULL, updated_at=v_now_ms WHERE id=v_task_row.id;
    RETURN jsonb_build_object('outcome','selected','task_no',v_task_no,'op_ref',v_ref);

  ELSIF p_op = 'pause' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    SELECT * INTO v_task_row FROM public.rongzhi_bank_agent_tasks
     WHERE task_no=v_task_no AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_task_row.status IN ('completed','cancelled','manual') THEN RETURN jsonb_build_object('outcome',v_task_row.status); END IF;
    IF v_task_row.op_ref IS NOT NULL THEN
      v_op_res := public.rongzhi_bank_sub_write_v1(p_user_id,'cancel',jsonb_build_object('ref_no',v_task_row.op_ref));
      IF v_op_res->>'outcome'='completed' THEN
        PERFORM public.rongzhi_bank_internal_reconcile_task(p_user_id, v_task_no, v_now_ms);
        RETURN jsonb_build_object('outcome','completed');
      END IF;
    END IF;
    UPDATE public.rongzhi_bank_agent_tasks SET status='paused', updated_at=v_now_ms WHERE id=v_task_row.id;
    RETURN jsonb_build_object('outcome','paused');

  ELSIF p_op = 'resume' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    SELECT * INTO v_task_row FROM public.rongzhi_bank_agent_tasks
     WHERE task_no=v_task_no AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_task_row.status IN ('completed','cancelled','manual') THEN RETURN jsonb_build_object('outcome',v_task_row.status); END IF;
    IF v_task_row.status='failed' THEN
      PERFORM public.rongzhi_bank_internal_reset_selection(v_task_row.id, v_now_ms);
      RETURN jsonb_build_object('outcome','waiting_selection');
    END IF;
    IF v_task_row.status IN ('waiting_selection','waiting_confirmation') THEN
      PERFORM public.rongzhi_bank_internal_reconcile_task(p_user_id, v_task_no, v_now_ms);
      RETURN jsonb_build_object('outcome',
        (SELECT status FROM public.rongzhi_bank_agent_tasks WHERE id=v_task_row.id));
    END IF;
    IF v_task_row.status='paused' THEN
      IF v_task_row.selected_subscription_id IS NOT NULL THEN
        SELECT * INTO v_sub FROM public.rongzhi_bank_subscriptions
         WHERE id=v_task_row.selected_subscription_id AND user_id=p_user_id;
        IF NOT FOUND OR v_sub.status<>'active' THEN
          PERFORM public.rongzhi_bank_internal_reset_selection(v_task_row.id, v_now_ms);
          RETURN jsonb_build_object('outcome','waiting_selection');
        END IF;
        BEGIN
          v_op_res := public.rongzhi_bank_sub_write_v1(p_user_id,'create',
            jsonb_build_object('subscription_id',v_sub.id,'action','pause'));
        EXCEPTION WHEN SQLSTATE '22023' THEN
          PERFORM public.rongzhi_bank_internal_reset_selection(v_task_row.id, v_now_ms);
          RETURN jsonb_build_object('outcome','waiting_selection');
        END;
        v_ref := v_op_res->>'ref_no';
        PERFORM public.rongzhi_bank_internal_set_node(v_task_row.id,'prepare_pause','completed',
          jsonb_build_object('ref_no',v_ref),NULL,v_now_ms);
        UPDATE public.rongzhi_bank_agent_tasks
           SET status='waiting_confirmation', op_ref=v_ref, failure_reason=NULL, updated_at=v_now_ms
         WHERE id=v_task_row.id;
        RETURN jsonb_build_object('outcome','waiting_confirmation');
      END IF;
      UPDATE public.rongzhi_bank_agent_tasks SET status='waiting_selection', updated_at=v_now_ms WHERE id=v_task_row.id;
      RETURN jsonb_build_object('outcome','waiting_selection');
    END IF;
    RETURN jsonb_build_object('outcome',v_task_row.status);

  ELSIF p_op = 'cancel' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    SELECT * INTO v_task_row FROM public.rongzhi_bank_agent_tasks
     WHERE task_no=v_task_no AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_task_row.status IN ('completed','cancelled','manual') THEN RETURN jsonb_build_object('outcome',v_task_row.status); END IF;
    IF v_task_row.op_ref IS NOT NULL THEN
      v_op_res := public.rongzhi_bank_sub_write_v1(p_user_id,'cancel',jsonb_build_object('ref_no',v_task_row.op_ref));
      IF v_op_res->>'outcome'='completed' THEN
        PERFORM public.rongzhi_bank_internal_reconcile_task(p_user_id, v_task_no, v_now_ms);
        RETURN jsonb_build_object('outcome','completed');
      END IF;
    END IF;
    UPDATE public.rongzhi_bank_agent_tasks SET status='cancelled', updated_at=v_now_ms WHERE id=v_task_row.id;
    RETURN jsonb_build_object('outcome','cancelled');

  ELSIF p_op = 'manual' THEN
    v_task_no := public.rongzhi_bank_internal_text(p_payload, 'task_no', 100);
    SELECT * INTO v_task_row FROM public.rongzhi_bank_agent_tasks
     WHERE task_no=v_task_no AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF v_task_row.status IN ('completed','cancelled','manual') THEN RETURN jsonb_build_object('outcome',v_task_row.status); END IF;
    IF v_task_row.op_ref IS NOT NULL THEN
      PERFORM public.rongzhi_bank_sub_write_v1(p_user_id,'cancel',jsonb_build_object('ref_no',v_task_row.op_ref));
    END IF;
    UPDATE public.rongzhi_bank_agent_tasks SET status='manual', updated_at=v_now_ms WHERE id=v_task_row.id;
    RETURN jsonb_build_object('outcome','manual');
  END IF;

  RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = '22023';
END;
$$;

-- ——————————————————————————————————————————————————————————————
-- 权限：仅 service_role；不允 anon / authenticated 直接访问业务表或执行 RPC
-- ——————————————————————————————————————————————————————————————

DO $$
DECLARE
  v_fn text;
  v_names text[] := ARRAY[
    'rongzhi_bank_snapshot_v1(bigint)',
    'rongzhi_bank_verification_secret_v1(bigint)',
    'rongzhi_bank_health_v1()',
    'rongzhi_bank_transfer_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_card_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_sub_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_repay_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_chat_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_verification_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_task_write_v1(bigint,text,jsonb)',
    'rongzhi_bank_seed_v1(bigint)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_names LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', v_fn);
  END LOOP;
END $$;

-- 内部辅助函数不授予 service_role。
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname LIKE 'rongzhi_bank_internal_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- 只精确回收本项目的 rongzhi_bank_* 表 / 序列，不触碰 public 下其它项目对象。
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS reg FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname LIKE 'rongzhi_bank_%' AND c.relkind='r' LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', r.reg);
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS reg FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname LIKE 'rongzhi_bank_%' AND c.relkind='S' LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', r.reg);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO service_role;

COMMIT;
