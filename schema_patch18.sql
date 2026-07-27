-- ============================================================
-- 第十八轮改造增量：verify_logs 记录归属周期
-- 统计页明细查询只看当前周期，需按 plan_id 过滤验收操作流水。
-- ============================================================

-- 1. verify_logs 加 plan_id（可空，兼容历史）
alter table public.verify_logs add column if not exists plan_id uuid references public.plans(id) on delete set null;
create index if not exists idx_verifylogs_plan on public.verify_logs(plan_id);

-- 2. 回填历史数据：从 record_id 关联 daily_records 取 plan_id
update public.verify_logs v
  set plan_id = r.plan_id
  from public.daily_records r
  where v.record_id = r.id
    and v.plan_id is null
    and r.plan_id is not null;

-- ============================================================
-- 完成。verify_logs 每条记录归属周期，统计明细按 plan_id 过滤。
-- ============================================================
