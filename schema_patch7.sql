-- ============================================================
-- 第七轮改造增量：一个任务只加一次分
-- 改 add_points_on_verify 触发器：仅在该 record 没有任何加分流水时才加分。
-- 这样"打回→再通过"不会重复加分。
-- ============================================================

create or replace function public.add_points_on_verify()
returns trigger language plpgsql security definer as $$
begin
  if (tg_op = 'UPDATE' and old.status <> 'verified' and new.status = 'verified')
     or (tg_op = 'INSERT' and new.status = 'verified') then
    -- 仅当该记录从未加过分（point_ledger 中无对应 source_record_id 且 delta>0）时才加
    if not exists (
      select 1 from public.point_ledger
      where source_record_id = new.id and delta > 0
    ) then
      insert into public.point_ledger (family_id, child_id, delta, reason, source_record_id, created_by)
      values (new.family_id, new.child_id, new.points,
              '验收通过：' || new.title, new.id, new.verified_by);
    end if;
  end if;
  return new;
end$$;

-- ============================================================
-- 完成。多次打回重做再通过，只在首次通过时加分。
-- ============================================================
