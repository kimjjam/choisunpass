import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DISCORD_WEBHOOK_URL = Deno.env.get('DISCORD_WEBHOOK_URL')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // 한국 시간 기준 오늘 날짜
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const today = kst.toISOString().split('T')[0]
  const nextWeek = new Date(kst.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // 오늘 미하원 수업+클리닉 학생 조회
  const { data: targets, error } = await supabase
    .from('attendances')
    .select('id, students(name)')
    .eq('visit_type', 'class_clinic')
    .eq('status', 'approved')
    .is('checked_out_at', null)
    .eq('date', today)

  if (error) {
    console.error('조회 오류:', error)
    return new Response(JSON.stringify({ error }), { status: 500 })
  }

  if (!targets || targets.length === 0) {
    console.log('자동 하원 대상 없음')
    return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
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
    return new Response(JSON.stringify({ error: updateError }), { status: 500 })
  }

  // Discord 알림 전송
  const nameList = targets
    .map(t => `• ${(t.students as { name: string }).name} → 재등원: ${nextWeek}`)
    .join('\n')

  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🏫 **자동 하원 처리 완료** (${targets.length}명)\n${nameList}`,
    }),
  })

  console.log(`자동 하원 처리: ${targets.length}명`)
  return new Response(JSON.stringify({ processed: targets.length }), { status: 200 })
})
