-- ============================================================
-- 第二十一轮改造增量：背诵模块（新概念课文/单词）
-- 三个新表：背诵记录 recitations、每课词表 lesson_words、倒序复习游标 recite_state
-- 音频沿用 verify-photos 桶的 recite/ 前缀，不建新桶。
-- ============================================================

-- 1. 背诵记录（每次背诵一条）
create table if not exists public.recitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  child_id uuid not null,
  book text not null default '新概念一',      -- 新概念一 / 新概念二
  lesson_no int not null,                     -- 课号
  kind text not null default 'review',        -- new=新课 review=复习
  text_quality text,                          -- perfect=一遍过 hint=有提示 fail=没背下来 null=没背课文
  wrong_words jsonb not null default '[]'::jsonb,   -- 本课背错的单词
  words_total int not null default 0,         -- 本次带词表背诵的单词总数（0=没带词表）
  audio_urls jsonb not null default '[]'::jsonb,    -- 背诵录音
  note text,
  recite_date date not null default current_date,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_recitations_child on public.recitations (family_id, child_id, book, lesson_no);
create index if not exists idx_recitations_date on public.recitations (family_id, child_id, recite_date);

-- 2. 每课词表（粘贴保存一次，全家共用）
create table if not exists public.lesson_words (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  book text not null,
  lesson_no int not null,
  words jsonb not null default '[]'::jsonb,   -- ["mistake 错误", "deliver 递送", ...]
  updated_at timestamptz not null default now(),
  unique (family_id, book, lesson_no)
);

-- 3. 倒序复习游标（每个孩子每本书记当前倒序扫到第几课）
create table if not exists public.recite_state (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  child_id uuid not null,
  book text not null,
  cursor_lesson int,                          -- 最近一次倒序复习到的课号，null=还没开始
  updated_at timestamptz not null default now(),
  unique (family_id, child_id, book)
);

-- ============================================================
-- 完成。
-- ============================================================
