-- =============================================
-- 최선 패스 — Supabase 스키마
-- Supabase SQL Editor에 붙여넣고 실행하세요
-- =============================================

-- students 테이블
create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,          -- 4~6자리 고유 코드
  class       text not null default '',
  created_at  timestamptz not null default now()
);

-- attendances 테이블
create table if not exists public.attendances (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.students(id) on delete cascade,
  date            date not null default current_date,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  checked_in_at   timestamptz default now(),
  approved_at     timestamptz,
  word_status     text check (word_status in ('pass', 'fail')),
  oral_status     text check (oral_status in ('pass', 'fail')),
  reject_reason   text,

  -- 같은 날 동일 학생 중복 출석 차단
  unique (student_id, date)
);

-- =============================================
-- RLS (Row Level Security)
-- =============================================

alter table public.students enable row level security;
alter table public.attendances enable row level security;

-- 학생 페이지: 코드로 students 읽기 허용 (로그인 불필요)
create policy "anyone can read students by code"
  on public.students for select
  using (true);

-- 학생 페이지: attendances INSERT 허용 (코드 확인 후 서버에서 처리)
create policy "anyone can insert attendance"
  on public.attendances for insert
  with check (true);

-- 학생 페이지: 본인 출석 상태 읽기
create policy "anyone can read attendances"
  on public.attendances for select
  using (true);

-- 조교/관리자: 인증된 사용자만 UPDATE 가능
create policy "authenticated can update attendance"
  on public.attendances for update
  using (auth.role() = 'authenticated');

-- =============================================
-- Realtime 활성화 (조교 대시보드 실시간 갱신)
-- =============================================

-- Supabase Dashboard > Database > Replication에서
-- attendances 테이블을 활성화하거나 아래 실행:
alter publication supabase_realtime add table public.attendances;

-- =============================================
-- 테스트 데이터 (개발용)
-- =============================================

insert into public.students (name, code, class) values
  ('김민준', '1234', 'A반'),
  ('이서연', '5678', 'A반'),
  ('박지호', '9012', 'B반')
on conflict (code) do nothing;
