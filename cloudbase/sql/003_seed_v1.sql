-- 融智 Agent · CloudBase 独立演示数据（v1）
-- 幂等：已有账户时直接返回 already_initialized，不重置、不清空、不覆盖。
-- 只写入独立演示用户与模拟数据；不读取 SQLite 开发库、聊天历史或本机验证绑定。
BEGIN;
SELECT public.rongzhi_bank_seed_v1(1);
COMMIT;
