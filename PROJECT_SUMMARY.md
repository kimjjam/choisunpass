# PROJECT_SUMMARY.md — 최선패스

> Claude Code 세션 간 컨텍스트 유지용 단일 소스. 코드 변경 작업 완료 시 "최근 변경 이력" 업데이트.
> 500줄 초과 시 오래된 이력을 `ARCHIVE.md`로 이동.

**최종 업데이트: 2026-04-22**

---

## 서비스 개요

최선패스는 학원(최선어학원) 출결·학습 관리 PWA.

- **학생**: 코드 입력 출석 → 대기열 등록
- **조교**: 승인/거절, 점수·미션 입력, 하원 처리, 부모 알림
- **관리자**: 학생/주간/통계/결석 관리
- **부모**: 당일 결과 확인 + 지난 기록 조회

핵심 흐름: `학생 출석 → 조교 승인 → 수업/하원 처리 → 부모 확인`

---

## 기술 스택

| 항목 | 내용 |
|------|------|
| 프레임워크 | React 19 + TypeScript + Vite 6 |
| 스타일 | Tailwind CSS v3 |
| 백엔드/DB | Supabase (PostgreSQL + Realtime + Edge Functions) |
| 배포 | Vercel (프론트) + Supabase (DB/Functions) |
| PWA | vite-plugin-pwa (injectManifest), 페이지별 manifest |
| 알림 | Web Push (VAPID) + Discord Webhook |
| 차트/엑셀 | Recharts, xlsx |

---

## 프로젝트 구조

```
최선패스/
├── index.html              # 대시보드/어드민 진입점
├── attend.html             # 학생 출석 진입점
├── parents.html            # 부모 조회 진입점
├── bomb.html               # 점검 모드 진입점
├── vercel.json             # Vercel 라우팅 + cron 설정
├── vite.config.ts          # 멀티 페이지 빌드 (input 4개)
├── src/
│   ├── main.tsx            # 대시보드 React 루트
│   ├── bomb-main.tsx       # 폭탄 페이지 React 루트
│   ├── App.tsx             # 라우터 (/dashboard, /admin, /login)
│   ├── lib/
│   │   ├── supabase.ts     # Supabase 클라이언트 (sessionStorage auth)
│   │   └── database.types.ts  # 공유 타입 정의
│   ├── pages/
│   │   ├── AttendPage.tsx      # 학생 출석
│   │   ├── DashboardPage.tsx   # 조교 대시보드
│   │   ├── ParentsPage.tsx     # 부모 알림장
│   │   ├── BombPage.tsx        # 점검 모드 토글
│   │   ├── AdminPage.tsx       # 학생/통계 관리
│   │   └── LoginPage.tsx       # 조교 로그인
│   └── components/
│       ├── ProtectedRoute.tsx
│       ├── EditStudentModal.tsx
│       └── StudentHistoryModal.tsx
├── api/
│   ├── push.ts                 # Vercel Function: Web Push 발송
│   └── cron/
│       └── daily-report.ts     # Vercel Cron: 22:00 KST 부모 알림
└── supabase/
    ├── schema.sql
    └── functions/
        └── auto-checkout/
            └── index.ts        # Edge Function: 23:00 KST 자동 하원
```

**⚠ 새 페이지 추가 시 `vite.config.ts` + `vercel.json` 양쪽 등록 필수**

---

## 라우팅

| URL | HTML | 비고 |
|-----|------|------|
| `/` | `index.html` | 대시보드 (로그인 필요) |
| `/attend` | `attend.html` | 학생 출석 |
| `/parents` | `parents.html` | 부모 조회 |
| `/bomb` | `bomb.html` | 점검모드 (12자리 PIN) |

`/dashboard`, `/admin` → `ProtectedRoute` 인증 필요

---

## DB 주요 테이블

### `students`
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| name | text | 학생 이름 |
| code | text | 4~6자리 고유 출석 코드 |
| class | text | 반 이름 |
| parent_push_subscription | jsonb | 부모 Web Push 구독 객체 |

### `attendances`
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| student_id | uuid | FK → students |
| date | date | 출석 날짜 (KST), unique(student_id, date) |
| status | text | `pending` / `approved` / `rejected` |
| visit_type | text | `class_clinic` / `clinic` |
| checked_in_at | timestamptz | 등원 시각 |
| checked_out_at | timestamptz | 하원 시각 (null = 미하원) |
| rechecked_in_at | timestamptz | 재등원 시각 |
| approved_at | timestamptz | 승인 시각 |
| next_clinic_date | date | 다음 클리닉 예정일 (자동 하원 시 +7일) |
| word_score | text | 단어 점수 |
| clinic_score | text | 클리닉 점수 |
| word_status | text | `pass` / `fail` / `delay` |
| oral_status | text | `pass` / `fail` / `delay` |
| homework | text | 숙제 상태 |
| notes | text | 메모 |
| reject_reason | text | 거절 사유 |
| force_next_clinic | bool | 다음 클리닉 강제 지정 플래그 |
| checkout_requested | bool | 클리닉 하원 요청 플래그 |

### `app_settings`
| key | value | 설명 |
|-----|-------|------|
| `maintenance_mode` | `'true'` / `'false'` | 점검 모드 (string, boolean 아님) |

### 기타 테이블
- `oral_queue` — 구두/숙제 검사 대기열
- `terms` — 학기 정보
- `clinic_absences` — 결석 사유

---

## 환경 변수

### Vercel (빌드 + Serverless)
| 변수명 | 설명 |
|--------|------|
| `VITE_SUPABASE_URL` | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_VAPID_PUBLIC_KEY` | Web Push 공개키 (클라이언트) |
| `VITE_BOMB_PIN` | **절대 git 커밋 금지** — 빌드 시 번들 포함 |
| `VAPID_PUBLIC_KEY` | Web Push 공개키 (서버) |
| `VAPID_PRIVATE_KEY` | Web Push 비밀키 |
| `VAPID_MAILTO` | Web Push 연락처 |
| `CRON_SECRET` | Vercel cron 인증 토큰 |
| `PUSH_API_SECRET` | (선택) `/api/push` 서버-서버 Bearer 토큰 |
| `SUPABASE_URL` | `/api/push` JWT 검증용 (없으면 `VITE_SUPABASE_URL` fallback) |
| `SUPABASE_ANON_KEY` | `/api/push` JWT 검증용 (없으면 `VITE_SUPABASE_ANON_KEY` fallback) |

### Supabase Edge Function (`auto-checkout`)
| 변수명 | 설명 |
|--------|------|
| `SUPABASE_URL` | 자동 주입 |
| `SUPABASE_SERVICE_ROLE_KEY` | 자동 주입 |
| `DISCORD_WEBHOOK_URL` | Discord 알림 Webhook |

---

## 주요 비즈니스 로직

### 출석 흐름
1. 학생 코드 입력 → `attendances` INSERT (`status=pending`)
2. 조교 대시보드에서 승인 → `status=approved`
3. 23:00 KST 자동 하원 (Edge Function)
   - 대상: `status=approved`, `checked_out_at IS NULL`, `visit_type IN ('class_clinic','clinic')`
   - `next_clinic_date = today + 7일`
   - Discord Webhook 알림 (타입별 분리)

### 미완료 체크 (AttendPage)
- 지난주 전체 기록 조회 → 완료된 기록 1건이라도 있으면 팝업 미표시
- 완료 기록 없을 때만 가장 최근 기록의 미완료 필드 표시

### 점검 모드 (BombPage)
- `app_settings.maintenance_mode` 토글 (`'true'`/`'false'`)
- `AttendPage`, `DashboardPage` 시작 시 값 확인 → `'true'`면 접근 차단

### KST 날짜 계산 (공통 패턴)
```ts
const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
const today = kst.toISOString().split('T')[0]
```

---

## 자동화 스케줄

| 시각 | 트리거 | 파일 | 역할 |
|------|--------|------|------|
| 22:00 KST | Vercel Cron `0 13 * * *` | `api/cron/daily-report.ts` | 부모 Web Push 발송 |
| 23:00 KST | Supabase pg_cron | `auto-checkout/index.ts` | 자동 하원 처리 + Discord 알림 |

---

## 개발/배포 명령어

```bash
npm run dev                              # 로컬 개발 서버
npm run build                            # TS 컴파일 + Vite 빌드
git push origin main                     # Vercel 자동 배포
supabase functions deploy auto-checkout  # Edge Function 배포
```

---

## 운영 주의사항

- `unique(student_id, date)` 제약 → 하루 1회 출석만 가능
- `maintenance_mode` 값은 string `'true'`/`'false'` (boolean 아님)
- `/api/push`는 인증 필요:
  - `Authorization: Bearer <Supabase Access Token>` 또는 `Bearer <PUSH_API_SECRET>`
  - `url`은 내부 경로(`/...`)만 허용
- 부모 푸시 클릭 URL은 `/api/push` payload의 `url` 필드가 SW까지 전달되어야 함
- `api/push` 감사 로그는 `result`, `target_type`, `status_code`, `error_reason`만 기록 (payload/개인정보 로그 금지)
- 대형 파일 (`AttendPage.tsx`, `DashboardPage.tsx`, `AdminPage.tsx`) 수정 시 영향 범위 점검 필수

---

## 운영 점검 루틴 (옵션 A)

### 1) 크론 실행 확인 (매일)
```sql
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = 2
order by start_time desc
limit 20;
```

### 2) HTTP 응답 확인 (auto-checkout 호출 결과)
```sql
select id, status_code, content, timed_out, error_msg, created
from net._http_response
order by created desc
limit 20;
```

### 3) 긴급 롤백 체크리스트
푸시 이상 시: env 확인 -> 최근 배포 확인 -> 임시 비활성화
1. env 확인: `PUSH_API_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
2. 최근 배포 확인: Vercel 최근 배포와 `auto-checkout` Edge Function 최근 배포 버전 확인
3. 임시 비활성화: `/api/push` 호출 중단 또는 `PUSH_API_SECRET` 회전/비활성화로 추가 발송 차단

### 4) 배포 전/후 체크 (고정)
- 배포 전: `npm run build`
- 배포 후: 부모 알림 1건 테스트 + 로그 확인

---

## 최근 변경 이력

### [2026-04-22] AttendPage 카카오뱅크 스타일 UI 리디자인
- `src/pages/AttendPage.tsx` — 배경 `#F2F3F5`, 카드 flat white + `h-2.5` 두꺼운 divider로 섹션 구분
- 모든 모달 center popup → bottom sheet(`rounded-t-3xl` + 핸들바) 통일, 버튼 계층 명확화

### [2026-04-22] ParentsPage 한눈에 보이도록 UI 컴팩트화
- `src/pages/ParentsPage.tsx` — 결과 있을 때 상단 로고 축소(w-10, 헤딩 숨김), 페이지 패딩 py-3으로 축소
- 카드 헤더 pt-6 pb-5, 학생명 1.5rem, 타이밍 카드 py-2.5, 학습결과 행 py-2.5, 버튼 py-2.5로 전반적 여백 축소

### [2026-04-16] 수업 미출석 탭 추가
- `src/pages/DashboardPage.tsx` — `SCHOOL_SCHEDULE` 상수(요일→학교·선생님 매핑) 추가, 헤더 구두대기 옆 `수업 미출석` 버튼 추가
- 탭 진입 시 오늘 스케줄 학교 학생 전체 조회 후 출석 여부 색상 구분(초록=출석, rose=미출석), 선생님별 필터 제공

### [2026-04-16] 감사로그/헬스체크 고정 패치 (최종 반영)
- `api/push.ts`
  - 감사 로그 필드를 `result`, `target_type(parent/student)`, `status_code`, `error_reason`로 고정
  - 성공/실패만 기록하며 payload 본문/구독 객체 등 개인정보성 데이터 미출력
- `supabase/functions/auto-checkout/index.ts`
  - 실행 요약 로그 표준화: `processed`, `clinic_count`, `class_clinic_count`, `failed_count`
  - Discord 실패를 `discord_failed_count`로 별도 카운트
- `PROJECT_SUMMARY.md`
  - 운영 점검 루틴 쿼리 2개 고정: `cron.job_run_details`, `net._http_response`
  - 긴급 롤백 체크리스트 3단계 고정: `env 확인 -> 최근 배포 확인 -> 임시 비활성화`
  - 배포 전/후 고정 체크 반영: `npm run build`, 부모 알림 1건 테스트 + 로그 확인

### [2026-04-16] 운영 안정화 로그 보강 (옵션 A)
- `api/push.ts`
  - 감사 로그 추가: unauthorized / bad request / sent / send failed
  - 로그 필드: `clientIp`, `targetType`, `hasUrl` 중심
  - 구독 payload는 로그에 남기지 않음
- `supabase/functions/auto-checkout/index.ts`
  - 실행 요약 로그 표준화: `processed`, `class_clinic_count`, `clinic_count`, `discord_sent`, `discord_failed`
  - 응답 body도 동일 요약 구조로 반환
- `PROJECT_SUMMARY.md`
  - 운영 점검 루틴(SQL 3종), 긴급 롤백 체크리스트 추가

### [2026-04-16] `/api/push` 인증 강화 + 대시보드 호출 인증 헤더 적용
- `api/push.ts`
  - 무인증 호출 차단 (`Authorization` Bearer 필수)
  - 허용 토큰: Supabase 사용자 JWT 또는 `PUSH_API_SECRET`
  - `url` payload는 내부 경로(`/...`)만 허용
- `src/pages/DashboardPage.tsx`
  - `/api/push` 호출 3개 지점에 조교 세션 JWT 헤더 자동 첨부
  - 부모 알림 루프에서 `res.ok` 체크 후 성공 건수 집계

### [2026-04-16] CLAUDE.md 행동 지침 전용으로 압축 + PROJECT_SUMMARY.md 단일 소스 통합
- `CLAUDE.md` — 50줄 이내 행동 지침만 유지, 프로젝트 정보 전부 제거
- `PROJECT_SUMMARY.md` — 프로젝트 정보 단일 소스로 재정비

### [2026-04-16] ParentsPage 히스토리 bottom sheet 모달
- `src/pages/ParentsPage.tsx` — 지난 기록 인라인 → 슬라이드업 bottom sheet 모달
- 오버레이 탭 / ✕ 닫기, 최대 85vh + 스크롤, `slideUp` 애니메이션

### [2026-04-16] HTML 캐시 헤더 누락 수정
- `vercel.json` — `/(index|attend|parents|bomb).html` 패턴 전체 `no-cache` 적용
- 기존 `index.html`만 처리되어 배포 후 구버전 캐싱 문제 발생하던 것 수정

### [2026-04-15] auto-checkout Edge Function — clinic 포함 + Discord 분리
- `supabase/functions/auto-checkout/index.ts`
- `class_clinic`만 → `clinic`도 포함, Discord 알림 타입별 분리 출력

### [2026-04-15] ParentsPage 주차별 히스토리 기능
- `src/pages/ParentsPage.tsx` — `groupByWeek()`, `WeekCard`, `Promise.all` 병렬 조회

### [2026-04-14] BombPage 신규 (점검 모드)
- `bomb.html`, `src/bomb-main.tsx`, `src/pages/BombPage.tsx` 신규
- 12자리 PIN(`VITE_BOMB_PIN`), 카운트다운+폭발 UI, `maintenance_mode` 토글

### [2026-04-14] Dashboard 일괄 승인 + visit_type 뱃지
- `src/pages/DashboardPage.tsx` — 일괄 승인 버튼, 클리닉/수업+클리닉 뱃지

### [2026-04-14] AttendPage 미완료 체크 로직 수정
- `src/pages/AttendPage.tsx` — 지난주 완료 기록 1건이라도 있으면 팝업 미표시 (오탐 수정)


### [2026-04-16] 감사로그/헬스체크 고정 패치
- `api/push.ts`
  - 감사 로그를 `result`, `target_type(parent/student)`, `status_code`, `error_reason` 4개 필드로 통일
  - payload 본문/구독 객체 등 개인정보성 데이터 로그 미출력
- `supabase/functions/auto-checkout/index.ts`
  - 표준 실행 요약에 `processed`, `clinic_count`, `class_clinic_count`, `failed_count` 고정 출력
  - Discord 실패를 `discord_failed_count` 숫자 카운트로 분리
- `PROJECT_SUMMARY.md`
  - 운영 점검 루틴을 매일 확인 쿼리 2개(`cron.job_run_details`, `net._http_response`) 고정
  - 긴급 롤백 3단계 및 배포 전/후 체크 고정 문구 반영
