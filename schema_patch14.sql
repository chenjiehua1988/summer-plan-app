-- ============================================================
-- 第十四轮改造增量：奖惩规则配置
-- ============================================================

alter table public.families add column if not exists settle_time time default '21:00';
alter table public.families add column if not exists streak_days int default 5;
alter table public.families add column if not exists streak_bonus int default 50;
alter table public.families add column if not exists last_settle_date date;

-- 按孩子记录结算日期（防止只结算一个孩子就跳过另一个）
alter table public.children add column if not exists last_settle_date date;

-- ============================================================
-- 完成。每个孩子独立记录结算日期，防止漏结算。
-- ============================================================
