import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DISCORD_WEBHOOK_URL = Deno.env.get('DISCORD_WEBHOOK_URL')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// 요일(0=일,1=월...6=토) → 수업 학교 목록 (프론트 DashboardPage SCHOOL_SCHEDULE과 동기화 유지)
const SCHOOL_SCHEDULE: Record<number, string[]> = {
  1: ['서원고', '수지고', '죽전고'],          // 월
  2: ['수지고', '신봉고', '풍덕고'],          // 화
  3: ['성복고', '신봉고', '풍덕고'],          // 수
  4: ['서원고', '현암고', '홍천고'],          // 목
  5: ['상현고', '현암고', '홍천고'],          // 금
}

Deno.serve(async () => {
  // 환경변수 검증
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const summary = {
      processed: 0,
      class_clinic_count: 0,
      clinic_count: 0,
      failed_count: 1,
      discord_failed_count: 0,
      error: 'missing_env',
    }
    console.error('[auto-checkout] summary', summary)
    return new Response(JSON.stringify(summary), { status: 500 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // 한국 시간 기준 오늘 날짜
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const today = kst.toISOString().split('T')[0]
  const nextWeek = new Date(kst.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const startedAt = now.toISOString()

  // ── 1. 자동 하원 처리 ──────────────────────────────────────────────────────

  const { data: targets, error } = await supabase
    .from('attendances')
    .select('id, visit_type, students(name)')
    .in('visit_type', ['class_clinic', 'clinic'])
    .eq('status', 'approved')
    .is('checked_out_at', null)
    .eq('date', today)

  if (error) {
    const summary = {
      today,
      started_at: startedAt,
      processed: 0,
      class_clinic_count: 0,
      clinic_count: 0,
      failed_count: 1,
      discord_failed_count: 0,
      error: String(error.message ?? error),
    }
    console.error('[auto-checkout] summary', summary)
    return new Response(JSON.stringify(summary), { status: 500 })
  }

  const clinicCount = (targets ?? []).filter(t => t.visit_type === 'clinic').length
  const classClinicCount = (targets ?? []).filter(t => t.visit_type === 'class_clinic').length
  let failedCount = 0
  let discordFailedCount = 0

  if (targets && targets.length > 0) {
    const ids = targets.map(t => t.id)
    const { error: updateError } = await supabase
      .from('attendances')
      .update({
        checked_out_at: now.toISOString(),
        next_clinic_date: nextWeek,
      })
      .in('id', ids)

    if (updateError) {
      console.error('하원 업데이트 오류:', updateError)
      failedCount = targets.length
    }
  }

  // ── 2. 자동 결석처리 ───────────────────────────────────────────────────────

  let absentCount = 0
  let absentFailedCount = 0
  const todayDay = kst.getDay()
  const todaySchools = SCHOOL_SCHEDULE[todayDay] ?? []

  if (todaySchools.length > 0) {
    // 오늘 수업 학교 학생 전체 조회
    const { data: schoolStudents } = await supabase
      .from('students')
      .select('id, name')
      .in('school', todaySchools)

    if (schoolStudents && schoolStudents.length > 0) {
      const allStudentIds = schoolStudents.map(s => s.id)

      // 오늘 이미 출결 레코드가 있는 학생 ID 조회
      const { data: existingRecs } = await supabase
        .from('attendances')
        .select('student_id')
        .eq('date', today)
        .in('student_id', allStudentIds)

      const existingIds = new Set((existingRecs ?? []).map(r => r.student_id))
      const absentTargets = schoolStudents.filter(s => !existingIds.has(s.id))

      if (absentTargets.length > 0) {
        const rows = absentTargets.map(s => ({
          student_id: s.id,
          date: today,
          status: 'absent',
          checked_in_at: null,
        }))
        const { error: absentError } = await supabase.from('attendances').insert(rows)
        if (absentError) {
          console.error('자동 결석처리 오류:', absentError)
          absentFailedCount = absentTargets.length
        } else {
          absentCount = absentTargets.length
        }
      }
    }
  }

  // ── 3. Discord 알림 ────────────────────────────────────────────────────────

  let discordSent = false

  if (DISCORD_WEBHOOK_URL) {
    const parts: string[] = []

    if (targets && targets.length > 0 && failedCount === 0) {
      const clinicTargets = targets.filter(t => t.visit_type === 'clinic')
      const classClinicTargets = targets.filter(t => t.visit_type === 'class_clinic')
      const formatList = (list: typeof targets) => list
        .map(t => {
          const student = t.students as { name: string } | null
          return `• ${student?.name ?? '(이름 없음)'} → 재등원: ${nextWeek}`
        })
        .join('\n')

      if (classClinicTargets.length > 0) {
        parts.push(`📗 **수업+클리닉** (${classClinicTargets.length}명)\n${formatList(classClinicTargets)}`)
      }
      if (clinicTargets.length > 0) {
        parts.push(`📘 **클리닉** (${clinicTargets.length}명)\n${formatList(clinicTargets)}`)
      }
    }

    if (absentCount > 0) {
      parts.push(`🔴 **자동 결석처리** (${absentCount}명)`)
    }

    if (parts.length > 0) {
      try {
        const discordRes = await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🏫 **23:00 자동 처리 완료**\n${parts.join('\n\n')}`,
          }),
        })
        if (!discordRes.ok) {
          discordFailedCount += 1
          console.error('Discord 알림 실패:', discordRes.status, await discordRes.text())
        } else {
          discordSent = true
        }
      } catch (discordErr) {
        discordFailedCount += 1
        console.error('Discord 알림 오류:', discordErr)
      }
    }
  } else {
    console.warn('DISCORD_WEBHOOK_URL 미설정 - 알림 생략')
  }

  const summary = {
    today,
    started_at: startedAt,
    processed: (targets?.length ?? 0) - failedCount,
    class_clinic_count: classClinicCount,
    clinic_count: clinicCount,
    failed_count: failedCount,
    absent_count: absentCount,
    absent_failed_count: absentFailedCount,
    discord_sent: discordSent,
    discord_failed_count: discordFailedCount,
  }
  console.info('[auto-checkout] summary', summary)
  return new Response(JSON.stringify(summary), { status: 200 })
})
