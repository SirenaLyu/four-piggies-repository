-- ==========================================================================
-- USTC 校园 AI 助手扩展数据库 schema —— 第二轮
-- ==========================================================================
-- 新增 5 张表(对应 8/15 爬取的 5 类 CSV):
--   1. campus_calendar          — 校历(学期/考试/放假节点)
--   2. campus_shuttle           — 校车时刻表(每行 = 一个班次)
--   3. campus_notices           — 教务处通知
--   4. campus_library_hours     — 图书馆各分馆开放时间
--   5. campus_scholarships      — 奖助学金/资助通知
--
-- 与 0001 的 campus_pois/campus_courses/campus_substitute_pool 共存,
-- 各自带 embedding 列做 pgvector 相似度检索,供 chat route 的分类器按类路由。
--
-- 灌入策略:这些表无自然主键(CSV 不含稳定 id),灌入脚本采用 truncate-then-insert,
-- 每次重跑 feed_crawled_data.ts 会清空再灌,不保留旧行。
--
-- 在 Supabase Dashboard → SQL Editor → New query 中粘贴本文件后运行。
-- ==========================================================================

-- pgvector 扩展(0001 已启用,这里幂等)
create extension if not exists vector;

-- ==========================================================================
-- 1. campus_calendar — 校历
-- ==========================================================================
create table if not exists public.campus_calendar (
  id            bigint generated always as identity primary key,
  academic_year text,                                -- "2025-2026" 等
  semester      text,                                -- "秋季"/"春季"/"夏季"
  start_date    date,                                -- 事件开始日期
  end_date      date,                                -- 事件结束日期(单日事件与 start_date 相同)
  event_title   text not null,                       -- 事件描述,如 "开学注册"/"期中考试"
  source_url    text,                                -- 校历页面 URL
  raw           jsonb,                               -- 完整原始行
  embedding     vector(1024),                        -- bge-m3 输出 1024 维
  created_at    timestamptz not null default now()
);

create index if not exists campus_calendar_content_tsidx
  on public.campus_calendar using gin (to_tsvector('simple', coalesce(event_title,'') || ' ' || coalesce(semester,'') || ' ' || coalesce(academic_year,'')));

create index if not exists campus_calendar_embedding_hnsw
  on public.campus_calendar using hnsw (embedding vector_cosine_ops);

create index if not exists campus_calendar_semester_idx on public.campus_calendar (academic_year, semester);

-- ==========================================================================
-- 2. campus_shuttle — 校车时刻表
-- ==========================================================================
create table if not exists public.campus_shuttle (
  id            bigint generated always as identity primary key,
  route_name    text not null,                       -- "主线1:东→西→先研院→高新" 等
  direction     text,                                -- "去程"/"返程"/"点对点"
  departure     text,                                -- 出发校区
  arrival       text,                                -- 到达校区
  depart_time   text,                                -- "07:30"
  arrive_time   text,                                -- "08:20"(点对点线可能为空)
  weekday_only  text,                                -- "true"/"false"
  period        text,                                -- "2026-08-01~2026-08-29"
  note          text,                                -- 备注
  source        text,                                -- 数据来源标记
  raw           jsonb,
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create index if not exists campus_shuttle_content_tsidx
  on public.campus_shuttle using gin (to_tsvector('simple', coalesce(route_name,'') || ' ' || coalesce(departure,'') || ' ' || coalesce(arrival,'') || ' ' || coalesce(note,'')));

create index if not exists campus_shuttle_embedding_hnsw
  on public.campus_shuttle using hnsw (embedding vector_cosine_ops);

create index if not exists campus_shuttle_route_idx on public.campus_shuttle (route_name);

-- ==========================================================================
-- 3. campus_notices — 教务处通知
-- ==========================================================================
create table if not exists public.campus_notices (
  id            bigint generated always as identity primary key,
  title         text not null,
  url           text,                                -- 通知原文 URL
  publish_date  date,                                -- 发布日期
  author        text,                                -- 发布者,如 "教务处"
  category      text,                                -- "信息"/"教学" 等
  body_preview  text,                                -- 正文前 200 字
  raw           jsonb,
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create index if not exists campus_notices_content_tsidx
  on public.campus_notices using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_preview,'') || ' ' || coalesce(category,'')));

create index if not exists campus_notices_embedding_hnsw
  on public.campus_notices using hnsw (embedding vector_cosine_ops);

create index if not exists campus_notices_pubdate_idx on public.campus_notices (publish_date desc);

-- ==========================================================================
-- 4. campus_library_hours — 图书馆开放时间
-- ==========================================================================
create table if not exists public.campus_library_hours (
  id            bigint generated always as identity primary key,
  branch        text not null,                       -- "东区"/"西区"/"高新区"
  floor         text,                                -- "1楼西"/"5楼东、西"
  service       text,                                -- 业务/服务名称
  weekday_hours text,                                -- "8:00-12:00 14:00-18:00"
  weekend_hours text,                                -- 周末时间,"——" 表示不开放
  phone         text,                                -- 联系电话
  source_url    text,
  raw           jsonb,
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create index if not exists campus_library_hours_content_tsidx
  on public.campus_library_hours using gin (to_tsvector('simple', coalesce(branch,'') || ' ' || coalesce(service,'') || ' ' || coalesce(floor,'')));

create index if not exists campus_library_hours_embedding_hnsw
  on public.campus_library_hours using hnsw (embedding vector_cosine_ops);

create index if not exists campus_library_hours_branch_idx on public.campus_library_hours (branch);

-- ==========================================================================
-- 5. campus_scholarships — 奖助学金/资助通知
-- ==========================================================================
create table if not exists public.campus_scholarships (
  id            bigint generated always as identity primary key,
  title         text not null,
  url           text,                                -- 通知原文 URL
  publish_date  date,                                -- 公示/发布日期
  publisher     text,                                -- 发布者
  category      text,                                -- "公示栏"/"奖助学金"/"助学贷款"/"勤工助学"
  body_preview  text,                                -- 正文前 200 字
  raw           jsonb,
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create index if not exists campus_scholarships_content_tsidx
  on public.campus_scholarships using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_preview,'') || ' ' || coalesce(category,'')));

create index if not exists campus_scholarships_embedding_hnsw
  on public.campus_scholarships using hnsw (embedding vector_cosine_ops);

create index if not exists campus_scholarships_pubdate_idx on public.campus_scholarships (publish_date desc);

-- ==========================================================================
-- 6. 检索函数 — 沿用 0001 的 match_xxx 命名风格
-- ==========================================================================

-- 6.1 校历向量检索
create or replace function public.match_calendar(
  query_embedding vector(1024),
  match_threshold float default 0.4,
  match_count     int   default 5
) returns table (
  id            bigint,
  academic_year text,
  semester      text,
  start_date    date,
  end_date      date,
  event_title   text,
  source_url    text,
  similarity    float
)
language sql stable
as $$
  select
    c.id,
    c.academic_year,
    c.semester,
    c.start_date,
    c.end_date,
    c.event_title,
    c.source_url,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.campus_calendar c
  where c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 6.2 校车向量检索
create or replace function public.match_shuttle(
  query_embedding vector(1024),
  match_threshold float default 0.4,
  match_count     int   default 8
) returns table (
  id            bigint,
  route_name    text,
  direction     text,
  departure     text,
  arrival       text,
  depart_time   text,
  arrive_time   text,
  weekday_only  text,
  period        text,
  note          text,
  source        text,
  similarity    float
)
language sql stable
as $$
  select
    s.id,
    s.route_name,
    s.direction,
    s.departure,
    s.arrival,
    s.depart_time,
    s.arrive_time,
    s.weekday_only,
    s.period,
    s.note,
    s.source,
    1 - (s.embedding <=> query_embedding) as similarity
  from public.campus_shuttle s
  where s.embedding is not null
    and 1 - (s.embedding <=> query_embedding) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
$$;

-- 6.3 教务通知向量检索
create or replace function public.match_notices(
  query_embedding vector(1024),
  match_threshold float default 0.4,
  match_count     int   default 5
) returns table (
  id            bigint,
  title         text,
  url           text,
  publish_date  date,
  author        text,
  category      text,
  body_preview  text,
  similarity    float
)
language sql stable
as $$
  select
    n.id,
    n.title,
    n.url,
    n.publish_date,
    n.author,
    n.category,
    n.body_preview,
    1 - (n.embedding <=> query_embedding) as similarity
  from public.campus_notices n
  where n.embedding is not null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

-- 6.4 图书馆开放时间向量检索
create or replace function public.match_library_hours(
  query_embedding vector(1024),
  match_threshold float default 0.4,
  match_count     int   default 6
) returns table (
  id            bigint,
  branch        text,
  floor         text,
  service       text,
  weekday_hours text,
  weekend_hours text,
  phone         text,
  source_url    text,
  similarity    float
)
language sql stable
as $$
  select
    l.id,
    l.branch,
    l.floor,
    l.service,
    l.weekday_hours,
    l.weekend_hours,
    l.phone,
    l.source_url,
    1 - (l.embedding <=> query_embedding) as similarity
  from public.campus_library_hours l
  where l.embedding is not null
    and 1 - (l.embedding <=> query_embedding) > match_threshold
  order by l.embedding <=> query_embedding
  limit match_count;
$$;

-- 6.5 奖助学金向量检索
create or replace function public.match_scholarships(
  query_embedding vector(1024),
  match_threshold float default 0.4,
  match_count     int   default 5
) returns table (
  id            bigint,
  title         text,
  url           text,
  publish_date  date,
  publisher     text,
  category      text,
  body_preview  text,
  similarity    float
)
language sql stable
as $$
  select
    sc.id,
    sc.title,
    sc.url,
    sc.publish_date,
    sc.publisher,
    sc.category,
    sc.body_preview,
    1 - (sc.embedding <=> query_embedding) as similarity
  from public.campus_scholarships sc
  where sc.embedding is not null
    and 1 - (sc.embedding <=> query_embedding) > match_threshold
  order by sc.embedding <=> query_embedding
  limit match_count;
$$;

-- ==========================================================================
-- 7. RLS — 公共匿名读(与 0001 一致)
-- ==========================================================================
alter table public.campus_calendar        enable row level security;
alter table public.campus_shuttle         enable row level security;
alter table public.campus_notices         enable row level security;
alter table public.campus_library_hours   enable row level security;
alter table public.campus_scholarships    enable row level security;

drop policy if exists "public read campus_calendar" on public.campus_calendar;
create policy "public read campus_calendar" on public.campus_calendar
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_shuttle" on public.campus_shuttle;
create policy "public read campus_shuttle" on public.campus_shuttle
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_notices" on public.campus_notices;
create policy "public read campus_notices" on public.campus_notices
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_library_hours" on public.campus_library_hours;
create policy "public read campus_library_hours" on public.campus_library_hours
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_scholarships" on public.campus_scholarships;
create policy "public read campus_scholarships" on public.campus_scholarships
  for select to anon, authenticated using (true);

-- ==========================================================================
-- 8. 刷新 PostgREST schema cache —— 必做!
-- 不刷新会导致 supabase.rpc('match_calendar') 报 "Could not find the function"
-- ==========================================================================
notify pgrst, 'reload schema';

-- 完成
-- 接下来运行 scripts/feed_crawled_data.ts --only=calendar,shuttle,notices,library,scholarships 灌入数据。
