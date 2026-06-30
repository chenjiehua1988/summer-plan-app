-- ============================================================
-- 学习周期（Plan）改造 —— 增量脚本
-- 在已执行 schema.sql 的基础上执行本脚本。
-- 幂等：可重复执行（用 if not exists / do $$ 判断）。
-- ============================================================

-- ---------- 1. plans 学习周期表 ----------
create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  name        text not null,
  type        text not null default '日常',
  start_date  date,
  end_date    date,
  status      text not null default 'active' check (status in ('active','archived')),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_plans_family on public.plans(family_id, sort);

-- ---------- 2. task_templates 加 plan_id ----------
alter table public.task_templates add column if not exists plan_id uuid references public.plans(id) on delete cascade;
create index if not exists idx_templates_plan on public.task_templates(plan_id);

-- ---------- 3. tags 自定义标签表 ----------
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  name       text not null,
  color      text not null default '#4f7cff',
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  unique (family_id, name)
);
create index if not exists idx_tags_family on public.tags(family_id, sort);

-- ---------- 4. task_tags 任务↔标签 ----------
create table if not exists public.task_tags (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.task_templates(id) on delete cascade,
  tag_id      uuid not null references public.tags(id) on delete cascade,
  unique (template_id, tag_id)
);
create index if not exists idx_task_tags_template on public.task_tags(template_id);

-- ---------- 5. daily_records 加 plan_id + tags ----------
alter table public.daily_records add column if not exists plan_id uuid references public.plans(id) on delete set null;
alter table public.daily_records add column if not exists tags text[] default '{}';
create index if not exists idx_records_plan on public.daily_records(plan_id);

-- ---------- 6. reward_shop 可配置奖励目录 ----------
create table if not exists public.reward_shop (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,
  cost_points  int not null,
  icon         text not null default '🎁',
  active       boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_shop_family on public.reward_shop(family_id, active, sort);

-- ---------- 7. rewards 加 shop_id ----------
alter table public.rewards add column if not exists shop_id uuid references public.reward_shop(id) on delete set null;

-- ---------- 8. Realtime（幂等：仅添加尚未加入的表） ----------
do $$
declare t text;
begin
  foreach t in array array['plans','tags','task_tags','reward_shop','task_templates','children','daily_records','point_ledger','rewards'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ---------- 9. 为已有家庭预置标签 + 示例奖励（仅对尚未预置的家庭） ----------
-- 预置标签
insert into public.tags (family_id, name, color, sort)
select f.id, '学校', '#ff8a5b', 0
from public.families f
where not exists (select 1 from public.tags t where t.family_id = f.id and t.name = '学校');

insert into public.tags (family_id, name, color, sort)
select f.id, '自主', '#4f7cff', 1
from public.families f
where not exists (select 1 from public.tags t where t.family_id = f.id and t.name = '自主');

-- 预置示例奖励（仅对没有任何奖励项的家庭）
insert into public.reward_shop (family_id, name, cost_points, icon, active, sort)
select f.id, v.name, v.cost, v.icon, true, v.sort
from (values
  ('看一集动画', 5, '📺', 0),
  ('玩30分钟游戏', 10, '🎮', 1),
  ('1元零花钱', 10, '💰', 2),
  ('吃冰激凌', 15, '🍦', 3),
  ('买指定玩具', 200, '🧸', 4)
) as v(name, cost, icon, sort)
cross join public.families f
where not exists (select 1 from public.reward_shop s where s.family_id = f.id);

-- ============================================================
-- 完成。后续 app 首次进入会引导创建周期、给孩子配清单。
-- ============================================================
