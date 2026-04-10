import type { VercelRequest, VercelResponse } from '@vercel/node'
import webpush from 'web-push'

webpush.setVapidDetails(
  process.env.VAPID_MAILTO!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { subscription, title, body } = req.body as {
    subscription: webpush.PushSubscription
    title: string
    body: string
  }

  if (!subscription || !title) return res.status(400).json({ error: 'missing fields' })

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body }),
    )
    return res.status(200).json({ ok: true })
  } catch (err: unknown) {
    console.error('push error', err)
    return res.status(500).json({ error: String(err) })
  }
}
