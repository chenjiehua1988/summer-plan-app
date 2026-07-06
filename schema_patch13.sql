-- ============================================================
-- 第十三轮改造增量：verify_logs 加 instruction 操作类型
-- ============================================================

-- 修改 action 约束，加入 instruction（改说明）
alter table public.verify_logs drop constraint if exists verify_logs_action_check;
alter table public.verify_logs add constraint verify_logs_action_check
  check (action in ('pass','reject','revoke','instruction'));

-- ============================================================
-- 完成。父母改任务说明也记一条流水，统计页能看到说明变更历史。
-- ============================================================
