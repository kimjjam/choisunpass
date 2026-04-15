import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DISCORD_WEBHOOK_URL = Deno.env.get('DISCORD_WEBHOOK_URL')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

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

  // 오늘 미하원 학생 조회 (클리닉 + 수업+클리닉)
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

  if (!targets || targets.length === 0) {
    const summary = {
      today,
      started_at: startedAt,
      processed: 0,
      class_clinic_count: 0,
      clinic_count: 0,
      failed_count: 0,
      discord_sent: false,
      discord_failed_count: 0,
      note: 'no targets',
    }
    console.info('[auto-checkout] summary', summary)
    return new Response(JSON.stringify(summary), { status: 200 })
  }

  // 일괄 하원 처리
  const ids = targets.map(t => t.id)
  const { error: updateError } = await supabase
    .from('attendances')
    .update({
      checked_out_at: now.toISOString(),
      next_clinic_date: nextWeek,
    })
    .in('id', ids)

  if (updateError) {
    console.error('업데이트 오류:', updateError)
    failedCount = targets.length
    const summary = {
      today,
      started_at: startedAt,
      processed: 0,
      class_clinic_count: classClinicCount,
      clinic_count: clinicCount,
      failed_count: failedCount,
      discord_sent: false,
      discord_failed_count: 0,
      error: String(updateError.message ?? updateError),
    }
    console.error('[auto-checkout] summary', summary)
    return new Response(JSON.stringify(summary), { status: 500 })
  }

  let discordSent = false

  // Discord 알림 전송
  if (DISCORD_WEBHOOK_URL) {
    const clinicTargets = targets.filter(t => t.visit_type === 'clinic')
    const classClinicTargets = targets.filter(t => t.visit_type === 'class_clinic')

    const formatList = (list: typeof targets) => list
      .map(t => {
        const student = t.students as { name: string } | null
        const name = student?.name ?? '(이름 없음)'
        return `• ${name} → 재등원: ${nextWeek}`
      })
      .join('\n')

    const parts: string[] = []
    if (classClinicTargets.length > 0) {
      parts.push(`📗 **수업+클리닉** (${classClinicTargets.length}명)\n${formatList(classClinicTargets)}`)
    }
    if (clinicTargets.length > 0) {
      parts.push(`📘 **클리닉** (${clinicTargets.length}명)\n${formatList(clinicTargets)}`)
    }
    const nameList = parts.join('\n\n')

    try {
      const discordRes = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🏫 **자동 하원 처리 완료** (${targets.length}명)\n${nameList}`,
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
      // Discord 실패해도 하원 처리는 완료된 것으로 처리
    }
  } else {
    console.warn('DISCORD_WEBHOOK_URL 미설정 - 알림 생략')
  }

  const summary = {
    today,
    started_at: startedAt,
    processed: targets.length,
    class_clinic_count: classClinicCount,
    clinic_count: clinicCount,
    failed_count: failedCount,
    discord_sent: discordSent,
    discord_failed_count: discordFailedCount,
  }
  console.info('[auto-checkout] summary', summary)
  return new Response(JSON.stringify(summary), { status: 200 })
})
