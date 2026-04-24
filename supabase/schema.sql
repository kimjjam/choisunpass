-- =============================================
-- 최선 패스 — Supabase 스키마
-- Supabase SQL Editor에 붙여넣고 실행하세요
-- =============================================

-- students 테이블
create table if not exists public.students (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  code                     text not null unique,
  class                    text not null default '',
  school                   text not null default '',
  oral_type                text not null default '',
  clinic_day               text not null default '',
  phone                    text not null default '',
  parent_push_subscription jsonb,
  created_at               timestamptz not null default now()
);

-- attendances 테이블
create table if not exists public.attendances (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students(id) on delete cascade,
  date                date not null default current_date,
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'absent')),
  visit_type          text check (visit_type in ('class_clinic', 'clinic')),
  checked_in_at       timestamptz default now(),
  checked_out_at      timestamptz,
  rechecked_in_at     timestamptz,
  approved_at         timestamptz,
  next_clinic_date    date,
  word_score          text,
  clinic_score        text,
  word_status         text check (word_status in ('pass', 'fail', 'delay')),
  oral_status         text check (oral_status in ('pass', 'fail', 'delay')),
  homework            text,
  notes               text,
  reject_reason       text,
  force_next_clinic   bool default false,
  checkout_requested  bool default false,
  unique (student_id, date)
);

-- oral_queue 테이블
create table if not exists public.oral_queue (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students(id) on delete cascade,
  date        date not null default current_date,
  type        text not null,
  status      text not null default 'waiting',
  created_at  timestamptz not null default now()
);

-- terms 테이블
create table if not exists public.terms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  start_date date not null,
  end_date   date not null,
  created_at timestamptz not null default now()
);

-- clinic_absences 테이블
create table if not exists public.clinic_absences (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students(id) on delete cascade,
  date        date not null,
  reason      text,
  created_at  timestamptz not null default now()
);

-- app_settings 테이블
create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- =============================================
-- RLS (Row Level Security)
-- =============================================

alter table public.students        enable row level security;
alter table public.attendances     enable row level security;
alter table public.oral_queue      enable row level security;
alter table public.terms           enable row level security;
alter table public.clinic_absences enable row level security;
alter table public.app_settings    enable row level security;

-- -----------------------------------------------
-- 기존 정책 전부 제거
-- -----------------------------------------------
drop policy if exists "anyone can read students by code"    on public.students;
drop policy if exists "anyone can insert attendance"         on public.attendances;
drop policy if exists "anyone can read attendances"          on public.attendances;
drop policy if exists "authenticated can update attendance"  on public.attendances;
drop policy if exists "authenticated can read students"      on public.students;
drop policy if exists "authenticated can update students"    on public.students;
drop policy if exists "authenticated can insert students"    on public.students;
drop policy if exists "authenticated can delete students"    on public.students;
drop policy if exists "authenticated can read attendances"   on public.attendances;
drop policy if exists "authenticated can insert attendance"  on public.attendances;
drop policy if exists "authenticated can update attendance"  on public.attendances;
drop policy if exists "authenticated can delete attendance"  on public.attendances;
drop policy if exists "authenticated can manage oral_queue"  on public.oral_queue;
drop policy if exists "authenticated can manage terms"       on public.terms;
drop policy if exists "authenticated can manage clinic_absences" on public.clinic_absences;
drop policy if exists "authenticated can read app_settings"      on public.app_settings;
drop policy if exists "anyone can update attendance"             on public.attendances;
drop policy if exists "anyone can delete attendance"             on public.attendances;
drop policy if exists "anyone can read oral_queue"               on public.oral_queue;
drop policy if exists "anyone can insert oral_queue"             on public.oral_queue;
drop policy if exists "authenticated can update oral_queue"      on public.oral_queue;
drop policy if exists "anyone can delete oral_queue"             on public.oral_queue;
drop policy if exists "anyone can read app_settings"             on public.app_settings;
drop policy if exists "authenticated can manage terms"           on public.terms;
drop policy if exists "authenticated can manage clinic_absences" on public.clinic_absences;

-- =============================================
-- students: 인증된 사용자만 직접 접근
-- 비로그인 접근은 RPC 함수(security definer)로만
-- =============================================
create policy "authenticated can read students"
  on public.students for select
  using (auth.role() = 'authenticated');

create policy "authenticated can insert students"
  on public.students for insert
  with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create policy "authenticated can update students"
  on public.students for update
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create policy "authenticated can delete students"
  on public.students for delete
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin');

-- =============================================
-- attendances: anonymous 허용 (AttendPage 비로그인 동작 필요)
-- INSERT는 제외 — insert_attendance_by_code RPC 사용
-- =============================================
create policy "anyone can read attendances"
  on public.attendances for select
  using (true);

-- INSERT는 RPC만 허용 (service definer 함수가 직접 INSERT)
-- UPDATE/DELETE는 모두 RPC 함수 경유 (코드 검증 포함)
create policy "authenticated can insert attendance"
  on public.attendances for insert
  with check (auth.role() = 'authenticated');

-- =============================================
-- oral_queue: 학생 화면에서 대기 등록/취소 필요
-- =============================================
create policy "anyone can read oral_queue"
  on public.oral_queue for select
  using (true);

create policy "anyone can insert oral_queue"
  on public.oral_queue for insert
  with check (true);

create policy "authenticated can update oral_queue"
  on public.oral_queue for update
  using (auth.role() = 'authenticated');

create policy "anyone can delete oral_queue"
  on public.oral_queue for delete
  using (true);

-- =============================================
-- app_settings: 점검모드 확인은 anonymous 허용, 쓰기는 RPC만
-- =============================================
create policy "anyone can read app_settings"
  on public.app_settings for select
  using (true);

-- =============================================
-- terms, clinic_absences: 인증된 사용자만
-- =============================================
create policy "authenticated can manage terms"
  on public.terms for all
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin')
  with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create policy "authenticated can manage clinic_absences"
  on public.clinic_absences for all
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin')
  with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');

-- =============================================
-- RPC 함수: security definer (RLS 우회, 최소 정보만 반환)
-- =============================================

-- 학생 출석·부모용: 코드로 학생 조회 (id, name, class, school 반환 — push_subscription 미포함)
create or replace function public.lookup_student_by_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student record;
begin
  select id, name, class, school into v_student
  from students
  where code = p_code
  limit 1;

  if not found then
    return null;
  end if;

  return json_build_object(
    'id',     v_student.id,
    'name',   v_student.name,
    'class',  v_student.class,
    'school', v_student.school
  );
end;
$$;

-- 출석 INSERT (비로그인 허용, 코드 검증 후, 중복 체크 내장)
create or replace function public.insert_attendance_by_code(
  p_code       text,
  p_visit_type text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
  v_date       date := current_date;
  v_existing   record;
  v_new        record;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'student_not_found');
  end if;

  select id, status into v_existing
  from attendances
  where student_id = v_student_id and date = v_date;

  if found then
    return json_build_object('error', 'already_attended', 'status', v_existing.status, 'id', v_existing.id);
  end if;

  insert into attendances (student_id, date, status, visit_type, checked_in_at)
  values (v_student_id, v_date, 'pending', p_visit_type, now())
  returning id, student_id, date, status, visit_type, checked_in_at into v_new;

  return json_build_object(
    'id',            v_new.id,
    'student_id',    v_new.student_id,
    'date',          v_new.date,
    'status',        v_new.status,
    'visit_type',    v_new.visit_type,
    'checked_in_at', v_new.checked_in_at
  );
end;
$$;

-- 부모용: 코드로 해당 학생 출석 기록만 조회 (approved + absent)
create or replace function public.get_attendance_by_student_code(
  p_code       text,
  p_date_from  date default null,
  p_date_to    date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
  v_result     json;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'student_not_found');
  end if;

  select json_agg(
    json_build_object(
      'id',               a.id,
      'date',             a.date,
      'status',           a.status,
      'visit_type',       a.visit_type,
      'checked_in_at',    a.checked_in_at,
      'checked_out_at',   a.checked_out_at,
      'rechecked_in_at',  a.rechecked_in_at,
      'approved_at',      a.approved_at,
      'word_score',       a.word_score,
      'clinic_score',     a.clinic_score,
      'word_status',      a.word_status,
      'oral_status',      a.oral_status,
      'homework',         a.homework,
      'notes',            a.notes,
      'next_clinic_date', a.next_clinic_date
    ) order by a.date desc
  ) into v_result
  from attendances a
  where a.student_id = v_student_id
    and a.status in ('approved', 'absent')
    and (p_date_from is null or a.date >= p_date_from)
    and (p_date_to   is null or a.date <= p_date_to);

  return json_build_object(
    'student_id', v_student_id,
    'records',    coalesce(v_result, '[]'::json)
  );
end;
$$;

-- 학생 하원 처리 (코드로 소유자 검증, attendances 직접 UPDATE 대신 사용)
create or replace function public.checkout_attendance(
  p_attendance_id uuid,
  p_code          text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
  v_row        attendances;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'invalid_code');
  end if;

  update attendances
  set checked_out_at = now()
  where id = p_attendance_id and student_id = v_student_id
  returning * into v_row;

  if not found then
    return json_build_object('error', 'not_found');
  end if;

  return row_to_json(v_row);
end;
$$;

-- 출석 취소 (코드로 소유자 검증 후 DELETE)
create or replace function public.cancel_attendance(
  p_attendance_id uuid,
  p_code          text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'invalid_code');
  end if;

  delete from attendances
  where id = p_attendance_id and student_id = v_student_id;

  return json_build_object('ok', true);
end;
$$;

-- 재등원 처리 (코드로 소유자 검증)
create or replace function public.recheckin_attendance(
  p_attendance_id uuid,
  p_code          text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
  v_row        attendances;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'invalid_code');
  end if;

  update attendances
  set checked_out_at = null, rechecked_in_at = now()
  where id = p_attendance_id and student_id = v_student_id
  returning * into v_row;

  if not found then
    return json_build_object('error', 'not_found');
  end if;

  return row_to_json(v_row);
end;
$$;

-- 다음 클리닉 날짜 설정 (코드로 소유자 검증)
create or replace function public.set_next_clinic(
  p_attendance_id      uuid,
  p_code               text,
  p_next_date          date,
  p_checkout_requested bool default false,
  p_force_next_clinic  bool default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid;
  v_row        attendances;
begin
  select id into v_student_id from students where code = p_code limit 1;
  if not found then
    return json_build_object('error', 'invalid_code');
  end if;

  update attendances
  set next_clinic_date   = p_next_date,
      checkout_requested = p_checkout_requested,
      force_next_clinic  = p_force_next_clinic
  where id = p_attendance_id and student_id = v_student_id
  returning * into v_row;

  if not found then
    return json_build_object('error', 'not_found');
  end if;

  return row_to_json(v_row);
end;
$$;

-- 부모용: push subscription 저장 (students 테이블 직접 접근 대신 RPC 경유)
create or replace function public.update_parent_push_subscription(
  p_student_id   uuid,
  p_subscription jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update students
  set parent_push_subscription = p_subscription
  where id = p_student_id;
end;
$$;

-- =============================================
-- Realtime 활성화 (조교 대시보드 실시간 갱신)
-- =============================================
alter publication supabase_realtime add table public.attendances;

-- =============================================
-- 테스트 데이터 (개발용)
-- =============================================
insert into public.students (name, code, class) values
  ('김민준', '1234', 'A반'),
  ('이서연', '5678', 'A반'),
  ('박지호', '9012', 'B반')
on conflict (code) do nothing;
