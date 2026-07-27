-- ============================================================
-- 第十九轮改造增量：rewards 记录归属周期
-- 积分页兑换记录按周期筛选+显示所属周期。
-- ============================================================

-- 1. rewards 加 plan_id（可空：历史记录无 plan_id，显示"未知周期"）
alter table public.rewards add column if not exists plan_id uuid references public.plans(id) on delete set null;
create index if not exists idx_rewards_plan on public.rewards(plan_id);

-- 2. 历史回填：rewards 无直接关联字段，按"兑换时间落在某周期起止日内"匹配
-- （近似回填，匹配不到的留空）
update public.rewards rw
  set plan_id = p.id
  from public.plans p
  where rw.family_id = p.family_id
    and rw.plan_id is null
    and p.start_date is not null and p.end_date is not null
    and rw.redeemed_at >= (p.start_date || 'T00:00:00')::timestamptz
    and rw.redeemed_at <= (p.end_date || 'T23:59:59')::timestamptz;

-- ============================================================
-- 完成。rewards 记录归属周期，积分页可按周期筛选兑换记录。
-- ============================================================
