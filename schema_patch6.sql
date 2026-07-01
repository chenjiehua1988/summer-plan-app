-- ============================================================
-- 第六轮改造增量：任务起止日期 + 按周几重复
-- 幂等。task_templates 加 start_date / end_date / weekdays。
-- ============================================================

alter table public.task_templates add column if not exists start_date date;
alter table public.task_templates add column if not exists end_date date;
alter table public.task_templates add column if not exists weekdays int[] default '{}';

-- ============================================================
-- 完成。
-- start_date/end_date 为空 = 整个周期；weekdays 为空 = 每天。
-- weekdays: 0=周日 1=周一 ... 6=周六（与 JS getDay() 一致）
-- ============================================================
