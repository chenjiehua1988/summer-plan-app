-- ============================================================
-- 第八轮改造增量：打卡流水（任务与打卡 1对多）
-- 新增 checkins 表，存每次打卡/补传的明细（时间/备注/照片/录音）。
-- daily_records 保留为任务当天状态记录（status/验收/积分），1任务1天1条不变。
-- ============================================================

create table if not exists public.checkins (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  record_id   uuid references public.daily_records(id) on delete cascade,
  child_id    uuid not null references public.children(id) on delete cascade,
  plan_id     uuid references public.plans(id) on delete set null,
  task_id     uuid references public.task_templates(id) on delete set null,
  date        date not null,
  title       text,
  note        text,
  photos      text[] default '{}',
  audios      text[] default '{}',
  created_at  timestamptz not null default now(),
  created_by  text
);
create index if not exists idx_checkins_record on public.checkins(record_id, created_at);
create index if not exists idx_checkins_child_date on public.checkins(child_id, date);
create index if not exists idx_checkins_family_date on public.checkins(family_id, date);

-- ---------- Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['checkins'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ============================================================
-- 完成。每次打卡/补传插一条 checkins；查看历史按 record_id 或 date 拉。
-- ============================================================
