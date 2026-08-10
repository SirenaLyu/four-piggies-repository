-- ==========================================================================
-- USTC 校园 AI 助手扩展数据库 schema
-- ==========================================================================
-- 新增 3 张表:
--   1. campus_pois          — 校园 POI(建筑/食堂/宿舍/AED 等)
--   2. campus_courses       — 课程信息(替代池中的所有课程)
--   3. campus_substitute_pool — 课程替代池(替代课与原课的映射)
--
-- 与现有 campus_documents 共存,各自带 embedding 列,做 pgvector 相似度检索。
--
-- 在 Supabase Dashboard → SQL Editor → New query 中粘贴本文件后运行。
-- ==========================================================================

-- 启用 pgvector 扩展(若已启用则跳过)
create extension if not exists vector;

-- ==========================================================================
-- 1. campus_pois — 校园 POI 表
-- ==========================================================================
create table if not exists public.campus_pois (
  id            bigint primary key,                  -- 来源 map.ustc.edu.cn 的 id
  title         text not null,
  address       text,
  sortcode      text,                                -- 分类码,如 010001 = 食堂餐厅
  category      text,                                -- 中文分类名,如 "食堂餐厅"
  poitype       text,
  telephone     text,
  url           text,
  description   text,
  keyword       text,
  xiaoqu        text,                                -- 校区(东校区/西校区/南校区/中校区/高新校区)
  thumbs        text,                                -- 缩略图相对路径
  pano          text,                                -- 全景链接相对路径
  x             double precision,                    -- 地图坐标 x(像素)
  y             double precision,                    -- 地图坐标 y(像素)
  lat           double precision,
  lng           double precision,
  raw           jsonb,                               -- 完整原始记录,留作扩展
  embedding     vector(1024),                        -- bge-m3 输出 1024 维
  created_at    timestamptz not null default now()
);

-- 全文检索索引(用于向量搜索失败时的回退)
create index if not exists campus_pois_content_tsidx
  on public.campus_pois using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(address,'') || ' ' || coalesce(category,'')));

-- 向量索引(HNSW,pgvector 0.5+ 默认推荐)
create index if not exists campus_pois_embedding_hnsw
  on public.campus_pois using hnsw (embedding vector_cosine_ops);

-- 分类筛选索引
create index if not exists campus_pois_sortcode_idx on public.campus_pois (sortcode);
create index if not exists campus_pois_xiaoqu_idx   on public.campus_pois (xiaoqu);

-- ==========================================================================
-- 2. campus_courses — 课程信息表
-- ==========================================================================
create table if not exists public.campus_courses (
  id            bigint primary key,                  -- 课程 id(来自 catalog.ustc.edu.cn)
  cn            text not null,                       -- 中文名
  en            text,                                -- 英文名
  code          text,                                -- 课程代码,如 022148 / MATH1012
  period        integer,                             -- 学时
  credits       double precision,                    -- 学分
  role          text,                                -- 'substitute' | 'original' | 'both'
  raw           jsonb,
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create index if not exists campus_courses_content_tsidx
  on public.campus_courses using gin (to_tsvector('simple', coalesce(cn,'') || ' ' || coalesce(en,'') || ' ' || coalesce(code,'')));

create index if not exists campus_courses_embedding_hnsw
  on public.campus_courses using hnsw (embedding vector_cosine_ops);

create index if not exists campus_courses_code_idx on public.campus_courses (code);

-- ==========================================================================
-- 3. campus_substitute_pool — 课程替代池(替代关系表)
-- ==========================================================================
create table if not exists public.campus_substitute_pool (
  id                bigint generated always as identity primary key,
  pool_id           bigint,                           -- catalog 返回的 id 字段
  substitute_course_id bigint references public.campus_courses(id) on delete cascade,
  original_course_id    bigint references public.campus_courses(id) on delete cascade,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  unique (pool_id, substitute_course_id, original_course_id)
);

create index if not exists campus_substitute_pool_pool_idx     on public.campus_substitute_pool (pool_id);
create index if not exists campus_substitute_pool_sub_idx      on public.campus_substitute_pool (substitute_course_id);
create index if not exists campus_substitute_pool_orig_idx     on public.campus_substitute_pool (original_course_id);

-- ==========================================================================
-- 4. 检索函数 — 与现有 match_documents 一致的命名风格
-- ==========================================================================

-- 4.1 POI 向量检索
create or replace function public.match_pois(
  query_embedding vector(1024),
  match_threshold float default 0.5,
  match_count     int   default 5
) returns table (
  id          bigint,
  title       text,
  address     text,
  category    text,
  xiaoqu      text,
  description text,
  telephone   text,
  url         text,
  thumbs      text,
  pano        text,
  similarity  float
)
language sql stable
as $$
  select
    p.id,
    p.title,
    p.address,
    p.category,
    p.xiaoqu,
    p.description,
    p.telephone,
    p.url,
    p.thumbs,
    p.pano,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.campus_pois p
  where p.embedding is not null
    and 1 - (p.embedding <=> query_embedding) > match_threshold
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- 4.2 课程向量检索
create or replace function public.match_courses(
  query_embedding vector(1024),
  match_threshold float default 0.5,
  match_count     int   default 5
) returns table (
  id          bigint,
  cn          text,
  en          text,
  code        text,
  period      integer,
  credits     double precision,
  role        text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.cn,
    c.en,
    c.code,
    c.period,
    c.credits,
    c.role,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.campus_courses c
  where c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 4.3 课程替代池 — 按课程 id 查替代关系
-- 给定一个课程名(中/英/代码),返回所有可替代它的课程(以及它可替代的课程)。
create or replace function public.find_substitute_courses(
  p_course_text text
) returns table (
  query_course_cn     text,
  query_course_code   text,
  substitute_cn       text,
  substitute_code     text,
  original_cn         text,
  original_code       text
)
language sql stable
as $$
  -- 在 campus_courses 中找匹配的课程
  with matched as (
    select id, cn, code
    from public.campus_courses
    where cn ilike '%' || p_course_text || '%'
       or en ilike '%' || p_course_text || '%'
       or code ilike '%' || p_course_text || '%'
    limit 20
  )
  select
    m.cn  as query_course_cn,
    m.code as query_course_code,
    sc.cn as substitute_cn,
    sc.code as substitute_code,
    oc.cn as original_cn,
    oc.code as original_code
  from matched m
  left join public.campus_substitute_pool sp on sp.substitute_course_id = m.id or sp.original_course_id = m.id
  left join public.campus_courses sc on sc.id = sp.substitute_course_id
  left join public.campus_courses oc on oc.id = sp.original_course_id
  where sc.id is not null and oc.id is not null;
$$;

-- ==========================================================================
-- 5. RLS — 暂时禁用(本应用是匿名只读查询场景,RLS 全部 enable + 公共读)
-- ==========================================================================
alter table public.campus_pois              enable row level security;
alter table public.campus_courses           enable row level security;
alter table public.campus_substitute_pool   enable row level security;

-- 公共匿名读策略
drop policy if exists "public read campus_pois" on public.campus_pois;
create policy "public read campus_pois" on public.campus_pois
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_courses" on public.campus_courses;
create policy "public read campus_courses" on public.campus_courses
  for select to anon, authenticated using (true);

drop policy if exists "public read campus_substitute_pool" on public.campus_substitute_pool;
create policy "public read campus_substitute_pool" on public.campus_substitute_pool
  for select to anon, authenticated using (true);

-- 注:写操作仅通过 service_role 密钥(服务端脚本)进行,service_role 默认绕过 RLS。

-- 完成
-- 接下来运行 scripts/feed_crawled_data.ts 把 D:\ustc-data\ 的数据灌入这些表。
