-- ============================================================
-- 暑假学习生活规划 PWA —— Supabase 数据库 Schema（单一家庭密码版）
-- 在 Supabase Dashboard → SQL Editor 中整体执行
--
-- 说明：本版不再使用 Supabase Auth（无邮箱注册/确认）。
-- 一个家庭一个共同密码，爸妈共用，进 app 后切换"妈妈/爸爸"角色。
-- 密码用 bcrypt 哈希存储（pgcrypto），不明文。
-- 家庭自用：RLS 关闭，靠密码门禁 + family_id 过滤 + 项目网址不公开来保护。
-- ============================================================

-- ---------- 扩展 ----------
create extension if not exists "pgcrypto";

-- ============================================================
-- 如果之前执行过旧版 schema，先清理（会删掉已有数据；首次执行可忽略）
-- ============================================================
drop table if exists public.rewards cascade;
drop table if exists public.point_ledger cascade;
drop table if exists public.life_logs cascade;
drop table if exists public.daily_records cascade;
drop table if exists public.task_templates cascade;
drop table if exists public.children cascade;
drop table if exists public.profiles cascade;
drop table if exists public.families cascade;
drop function if exists public.add_points_on_verify() cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.touch_updated_at() cascade;
drop function if exists public.current_family_id() cascade;

-- ============================================================
-- 1. families（家庭：含密码哈希）
-- ============================================================
create table public.families (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default '我的家庭',
  password_hash text not null,   -- bcrypt: crypt(密码, gen_salt('bf'))
  created_at    timestamptz not null default now()
);

-- ============================================================
-- 2. children（孩子档案）
-- ============================================================
create table public.children (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,
  grade_target text,  -- 如 "准六年级" / "准三年级"
  created_at   timestamptz not null default now()
);

-- ============================================================
-- 3. task_templates（任务模板）
-- ============================================================
create table public.task_templates (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  child_id    uuid not null references public.children(id) on delete cascade,
  subject     text not null check (subject in ('语文','数学','英语','生活')),
  title       text not null,
  default_minutes int not null default 30,
  points      int not null default 1,
  recurrence  text not null default 'daily' check (recurrence in ('daily','weekly')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- 4. daily_records（每日打卡记录）
-- verified_by / completed_by 存角色名（"妈妈"/"爸爸"），不再关联 auth.users
-- ============================================================
create table public.daily_records (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  child_id       uuid not null references public.children(id) on delete cascade,
  task_id        uuid references public.task_templates(id) on delete set null,
  date           date not null,
  subject        text not null,
  title          text not null,
  points         int not null default 1,
  status         text not null default 'pending'
                 check (status in ('pending','done','verified','rejected')),
  completed_at   timestamptz,
  completed_by   text,
  verified_at    timestamptz,
  verified_by    text,
  note           text,
  actual_minutes int,
  updated_at     timestamptz not null default now(),
  unique (child_id, task_id, date)
);

-- ============================================================
-- 5. life_logs（生活项记录）
-- ============================================================
create table public.life_logs (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  child_id   uuid not null references public.children(id) on delete cascade,
  date       date not null,
  type       text not null check (type in ('运动','阅读','家务','屏幕时间')),
  value      text,
  note       text,
  created_by text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 6. point_ledger（积分流水）
-- ============================================================
create table public.point_ledger (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  child_id        uuid not null references public.children(id) on delete cascade,
  delta           int not null,           -- 正数加，负数扣
  reason          text not null,
  source_record_id uuid references public.daily_records(id) on delete set null,
  created_by      text,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- 7. rewards（奖励兑换）
-- ============================================================
create table public.rewards (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  child_id      uuid not null references public.children(id) on delete cascade,
  name          text not null,
  cost_points   int not null,
  redeemed_at   timestamptz not null default now(),
  redeemed_by   text
);

-- ============================================================
-- 索引
-- ============================================================
create index idx_children_family on public.children(family_id);
create index idx_templates_family on public.task_templates(family_id);
create index idx_templates_child on public.task_templates(child_id, active);
create index idx_records_child_date on public.daily_records(child_id, date);
create index idx_records_family_date on public.daily_records(family_id, date);
create index idx_life_child_date on public.life_logs(child_id, date);
create index idx_ledger_child on public.point_ledger(child_id, created_at);
create index idx_rewards_child on public.rewards(child_id, redeemed_at);

-- ============================================================
-- updated_at 自动维护
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

create trigger trg_records_touch before update on public.daily_records
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 验收通过自动加分（触发器）
-- ============================================================
create or replace function public.add_points_on_verify()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and old.status <> 'verified' and new.status = 'verified')
     or (tg_op = 'INSERT' and new.status = 'verified') then
    insert into public.point_ledger (family_id, child_id, delta, reason, source_record_id, created_by)
    values (new.family_id, new.child_id, new.points,
            '验收通过：' || new.title, new.id, new.verified_by);
  end if;
  return new;
end$$;

create trigger trg_records_points
  after insert or update of status on public.daily_records
  for each row execute function public.add_points_on_verify();

-- ============================================================
-- 不启用 RLS（家庭自用，单一共同密码门禁）
-- 靠 app 层 family_id 过滤 + 密码哈希校验 + 项目网址不公开 来保护。
-- 如需更强隔离，可在 Supabase Dashboard 为各表手动开启 RLS。
-- ============================================================

-- ============================================================
-- 密码哈希 / 校验 RPC（前端调用，避免暴露哈希）
-- ============================================================
-- 生成 bcrypt 哈希
create or replace function public.pw_hash(p_pw text)
returns text language sql security definer as $$
  select crypt(p_pw, gen_salt('bf'));
$$;

-- 校验密码：返回 family_id（匹配）或 null
create or replace function public.pw_match(p_name text, p_pw text)
returns uuid language sql security definer as $$
  select id from public.families
  where name = p_name and password_hash = crypt(p_pw, password_hash)
  limit 1;
$$;

-- ============================================================
-- Realtime：开启相关表的实时推送（爸妈多端同步）
-- ============================================================
alter publication supabase_realtime add table public.daily_records;
alter publication supabase_realtime add table public.point_ledger;
alter publication supabase_realtime add table public.life_logs;
alter publication supabase_realtime add table public.rewards;
alter publication supabase_realtime add table public.children;
alter publication supabase_realtime add table public.task_templates;

-- ============================================================
-- 完成。下一步在 app 首页「创建家庭」时会自动写入一条 family 记录
-- （含密码哈希）。之后每次输密码登录即可。
-- ============================================================
