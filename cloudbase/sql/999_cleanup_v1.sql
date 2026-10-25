-- 融智 Agent · CloudBase PostgreSQL 持久库 v1（清理）
-- 仅删除本项目 rongzhi_bank_* 对象；不使用 CASCADE；显式事务，任一步失败整体回滚。

BEGIN;

DROP FUNCTION IF EXISTS public.rongzhi_bank_snapshot_v1(bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_verification_secret_v1(bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_health_v1();
DROP FUNCTION IF EXISTS public.rongzhi_bank_transfer_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_card_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_sub_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_repay_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_chat_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_verification_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_task_write_v1(bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_seed_v1(bigint);

DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_reconcile_task(bigint,text,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_verification_guard(bigint,timestamptz);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_transfer_user_lock(bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_build_summary(bigint,bigint,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_run_readonly_nodes(bigint,bigint,text,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_reset_selection(bigint,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_set_node(bigint,text,text,jsonb,text,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_monthly_analytics(bigint,text);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_finalize_sub(bigint,text,text,timestamptz);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_source_usable(bigint,bigint,text);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_source_snapshot(bigint,bigint);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_finalize_card(bigint,text,text,timestamptz);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_finalize_transfer(bigint,text,text,timestamptz);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_day_start(timestamptz);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_audit(bigint,text,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_text(jsonb,text,int);
DROP FUNCTION IF EXISTS public.rongzhi_bank_internal_pos_bigint(jsonb,text);

DROP TABLE IF EXISTS public.rongzhi_bank_repayment_allocations;
DROP TABLE IF EXISTS public.rongzhi_bank_statement_payments;
DROP TABLE IF EXISTS public.rongzhi_bank_repayment_operations;
DROP TABLE IF EXISTS public.rongzhi_bank_statements;
DROP TABLE IF EXISTS public.rongzhi_bank_credit_accounts;
DROP TABLE IF EXISTS public.rongzhi_bank_agent_task_nodes;
DROP TABLE IF EXISTS public.rongzhi_bank_agent_tasks;
DROP TABLE IF EXISTS public.rongzhi_bank_chat_state;
DROP TABLE IF EXISTS public.rongzhi_bank_chat_messages;
DROP TABLE IF EXISTS public.rongzhi_bank_chat_sessions;
DROP TABLE IF EXISTS public.rongzhi_bank_verification_failures;
DROP TABLE IF EXISTS public.rongzhi_bank_totp_used_steps;
DROP TABLE IF EXISTS public.rongzhi_bank_verification_bindings;
DROP TABLE IF EXISTS public.rongzhi_bank_subscription_operations;
DROP TABLE IF EXISTS public.rongzhi_bank_card_operations;
DROP TABLE IF EXISTS public.rongzhi_bank_transfer_operations;
DROP TABLE IF EXISTS public.rongzhi_bank_transfer_recipients;
DROP TABLE IF EXISTS public.rongzhi_bank_audit_logs;
DROP TABLE IF EXISTS public.rongzhi_bank_subscriptions;
DROP TABLE IF EXISTS public.rongzhi_bank_cards;
DROP TABLE IF EXISTS public.rongzhi_bank_transactions;
DROP TABLE IF EXISTS public.rongzhi_bank_accounts;
DROP TABLE IF EXISTS public.rongzhi_bank_users;

COMMIT;
