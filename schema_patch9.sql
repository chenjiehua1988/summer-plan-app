-- ============================================================
-- 第九轮改造增量：Web Push 推送订阅
-- 新增 push_subscriptions 表，存家长设备的推送订阅。
-- ============================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_role   text not null,           -- 妈妈/爸爸
  endpoint    text not null,           -- 推送服务地址
  p256dh      text not null,           -- 客户端公钥
  auth        text not null,           -- 客户端 auth 密钥
  created_at  timestamptz not null default now(),
  unique (endpoint)
);
create index if not exists idx_pushsubs_family on public.push_subscriptions(family_id);

-- Realtime（可选，便于管理界面实时刷新）
do $$
declare t text;
begin
  foreach t in array array['push_subscriptions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ============================================================
-- 完成。家长在 app 开启通知时写入订阅，Edge Function 据此推送。
-- ============================================================
