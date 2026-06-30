-- ============================================================
-- 第四轮改造增量：孩子模式 —— 兑换申请表
-- 在已执行 schema.sql / schema_plan_patch.sql / schema_patch3.sql 基础上执行。幂等。
-- ============================================================

-- ---------- redeem_requests 兑换申请 ----------
create table if not exists public.redeem_requests (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  child_id     uuid not null references public.children(id) on delete cascade,
  shop_id      uuid references public.reward_shop(id) on delete set null,
  name         text not null,
  cost_points  int not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_redeem_req_family on public.redeem_requests(family_id, status, created_at);
create index if not exists idx_redeem_req_child on public.redeem_requests(child_id, created_at);

-- ---------- Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['redeem_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ============================================================
-- 完成。前端登录页加「我是孩子」入口；家长登录选角色；兑换走申请审批。
-- ============================================================
