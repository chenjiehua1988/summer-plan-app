-- ============================================================
-- 第十轮改造增量：验收操作流水（通过/打回/撤销历史）
-- 新增 verify_logs 表，每次验收操作记一条，便于追溯打回原因。
-- ============================================================

create table if not exists public.verify_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  record_id   uuid references public.daily_records(id) on delete cascade,
  child_id    uuid not null references public.children(id) on delete cascade,
  title       text,                    -- 任务名快照（便于过滤/显示）
  action      text not null check (action in ('pass','reject','revoke')),
  note        text,
  operator    text not null,           -- 妈妈/爸爸
  created_at  timestamptz not null default now()
);
create index if not exists idx_verifylogs_record on public.verify_logs(record_id, created_at);
create index if not exists idx_verifylogs_child_date on public.verify_logs(child_id, created_at);

-- Realtime
do $$
declare t text;
begin
  foreach t in array array['verify_logs'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ============================================================
-- 完成。通过/打回/撤销各写一条流水，含原因和操作人。
-- ============================================================

-- 若已建表（没title字段），补加（幂等）
alter table public.verify_logs add column if not exists title text;

