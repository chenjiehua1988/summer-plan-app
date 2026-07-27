-- ============================================================
-- 第二十轮改造增量：任务说明支持录音和图片
-- 说明（instruction）从纯文字扩展为文字+音频+图片。
-- ============================================================

-- 1. daily_records 加说明附件字段
alter table public.daily_records add column if not exists instruction_photos text[] default '{}';
alter table public.daily_records add column if not exists instruction_audios text[] default '{}';

-- ============================================================
-- 完成。instruction 仍保留文字说明；新增两个数组字段存附件URL。
-- ============================================================
