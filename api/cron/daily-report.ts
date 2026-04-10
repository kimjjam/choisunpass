import type { VercelRequest, VercelResponse } from '@vercel/node'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

webpush.setVapidDetails(
  process.env.VAPID_MAILTO!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
)

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!,
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron 인증
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })

  // 오늘 등원한 학생 중 부모님 push 구독이 있는 학생 조회
  const { data: attendances, error } = await supabase
    .from('attendances')
    .select('student_id, students(id, name, parent_push_subscription)')
    .eq('date', today)
    .eq('status', 'approved')

  if (error) {
    console.error('DB error:', error)
    return res.status(500).json({ error: error.message })
  }

  let sent = 0
  let failed = 0

  for (const att of (attendances ?? [])) {
    const student = att.students as { id: string; name: string; parent_push_subscription: object | null } | null
    if (!student?.parent_push_subscription) continue

    try {
      await webpush.sendNotification(
        student.parent_push_subscription as webpush.PushSubscription,
        JSON.stringify({
          title: '📚 최선패스 알림장',
          body: `오늘 ${student.name} 학생의 학원 현황을 확인해보세요!`,
          url: '/parents',
        }),
      )
      sent++
    } catch (e) {
      console.error(`push failed for ${student.name}:`, e)
      failed++
    }
  }

  return res.status(200).json({ ok: true, today, sent, failed })
}
