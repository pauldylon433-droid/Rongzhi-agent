-- v1 → v1.1 增量升级：会话保存版本 / 轮次标识。
-- 仅新增列与索引，不删除、不清空既有会话数据；可重复执行。
-- 执行顺序（已有 v1 数据库）：
--   1) 本文件
--   2) 重新执行 002_functions_v1.sql（幂等替换函数 / 权限）
--   3) 如仅需新版演示样例，使用新用户或空库执行 003_seed_v1.sql；不要对已有数据做重置。

BEGIN;

ALTER TABLE public.rongzhi_bank_chat_sessions
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE public.rongzhi_bank_chat_sessions
  ADD COLUMN IF NOT EXISTS last_turn_id text;
ALTER TABLE public.rongzhi_bank_chat_messages
  ADD COLUMN IF NOT EXISTS turn_id text;

CREATE UNIQUE INDEX IF NOT EXISTS rongzhi_bank_chat_msg_turn_uq
  ON public.rongzhi_bank_chat_messages(session_id, turn_id, role)
  WHERE turn_id IS NOT NULL;

COMMIT;
