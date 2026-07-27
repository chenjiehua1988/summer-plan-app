-- ============================================================
-- 第十七轮改造增量：point_ledger 记录归属周期
-- 积分跨周期累积不清零，但每条流水记录属于哪个周期，便于追溯。
-- ============================================================

-- 1. point_ledger 加 plan_id（可空：兼容历史无 source_record_id 的流水）
alter table public.point_ledger add column if not exists plan_id uuid references public.plans(id) on delete set null;
create index if not exists idx_ledger_plan on public.point_ledger(plan_id);

-- 2. 回填历史数据：有 source_record_id 的流水，从对应 daily_records 取 plan_id
update public.point_ledger l
  set plan_id = r.plan_id
  from public.daily_records r
  where l.source_record_id = r.id
    and l.plan_id is null
    and r.plan_id is not null;

-- 3. 重建验收加分触发器：写入时带上 plan_id（从 daily_records 取）
create or replace function public.add_points_on_verify()
returns trigger language plpgsql security definer as $$
begin
  if (tg_op = 'UPDATE' and old.status <> 'verified' and new.status = 'verified')
     or (tg_op = 'INSERT' and new.status = 'verified') then
    -- 仅当该记录从未加过分时才加
    if not exists (
      select 1 from public.point_ledger
      where source_record_id = new.id and delta > 0
    ) then
      insert into public.point_ledger (family_id, child_id, plan_id, delta, reason, source_record_id, created_by)
      values (new.family_id, new.child_id, new.plan_id, new.points,
              '验收通过：' || new.title, new.id, new.verified_by);
    end if;
  end if;
  return new;
end$$;

-- ============================================================
-- 完成。积分余额仍按 child 全量累加（跨周期不清零），
-- 但每条流水可按 plan_id 追溯归属周期。
-- ============================================================
