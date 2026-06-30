-- ============================================================
-- 第三轮改造增量：周期类型自定义 + 假期 + 打卡/验收拍照
-- 在已执行 schema.sql 和 schema_plan_patch.sql 的基础上执行。幂等。
-- ============================================================

-- ---------- 1. plan_types 自定义周期类型 ----------
create table if not exists public.plan_types (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  name       text not null,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  unique (family_id, name)
);
create index if not exists idx_plan_types_family on public.plan_types(family_id, sort);

-- 预置类型（仅对尚未预置的家庭）
insert into public.plan_types (family_id, name, sort)
select f.id, v.name, v.sort
from (values
  ('暑假', 0), ('寒假', 1), ('KET备考', 2), ('日常', 3), ('其他', 4)
) as v(name, sort)
cross join public.families f
where not exists (select 1 from public.plan_types t where t.family_id = f.id);

-- ---------- 2. day_off 假期/请假 ----------
create table if not exists public.day_off (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  plan_id    uuid not null references public.plans(id) on delete cascade,
  child_id   uuid not null references public.children(id) on delete cascade,
  date       date not null,
  reason     text,
  created_at timestamptz not null default now(),
  unique (plan_id, child_id, date)
);
create index if not exists idx_dayoff_plan_child on public.day_off(plan_id, child_id, date);

-- ---------- 3. daily_records 加 photos + skipped 状态 ----------
alter table public.daily_records add column if not exists photos text[] default '{}';
-- status 已有 check 约束，需替换以加入 skipped
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'daily_records_status_check' and conrelid = 'public.daily_records'::regclass
  ) then
    alter table public.daily_records drop constraint daily_records_status_check;
  end if;
end$$;
alter table public.daily_records
  add constraint daily_records_status_check
  check (status in ('pending','done','verified','rejected','skipped'));

-- ---------- 4. Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['plan_types','day_off'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ---------- 5. Storage 桶与策略 ----------
-- ⚠️ Storage 相关不能用本 SQL 脚本配置（storage.objects 表需 owner 权限）。
-- 请在 Supabase Dashboard → Storage 界面手动配置，步骤见 README「验收拍照配置」一节：
--   1. Storage → New bucket → Name: verify-photos → 勾选 Public → Create
--   2. 进入该桶 → Policies → Add policy → 给 SELECT/INSERT/UPDATE/DELETE 都加 "Allow access to all" （家庭自用）
-- 完成后 app 的拍照上传功能即可使用。

-- ============================================================
-- 完成。建表/字段/预置/Realtime 已就绪。Storage 桶请按上面说明在 Dashboard 配置。
-- ============================================================

