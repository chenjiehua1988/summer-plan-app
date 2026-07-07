-- ============================================================
-- 第十四轮改造增量：奖惩规则配置
-- ============================================================

alter table public.families add column if not exists settle_time time default '21:00';
alter table public.families add column if not exists streak_days int default 5;
alter table public.families add column if not exists streak_bonus int default 50;
alter table public.families add column if not exists last_settle_date date;

-- ============================================================
-- 完成。结算时间/连续天数/奖励积分可配，last_settle_date 防重复结算。
-- ============================================================
