-- ============================================================
-- 第十五轮改造增量：一次性任务(recurrence=once)
-- ============================================================

-- daily_records 加 recurrence 快照
alter table public.daily_records add column if not exists recurrence text default 'daily';

-- task_templates 放宽 recurrence 约束，加 once
alter table public.task_templates drop constraint if exists task_templates_recurrence_check;
alter table public.task_templates add constraint task_templates_recurrence_check
  check (recurrence in ('daily','weekly','once'));

-- ============================================================
-- 完成。一次性任务(recurrence=once)验收通过后不再生成，不参与结算扣分。
-- ============================================================
