import type { VercelRequest, VercelResponse } from '@vercel/node'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

function getEnv(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]
    if (value) return value
  }
  return undefined
}

const supabaseUrl = getEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
const supabaseAnonKey = getEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
const pushApiSecret = process.env.PUSH_API_SECRET

const authSupabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

webpush.setVapidDetails(
  process.env.VAPID_MAILTO!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
)

async function isAuthorized(req: VercelRequest) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice(7).trim()
  if (!token) return false

  // Server-to-server secret support (optional).
  if (pushApiSecret && token === pushApiSecret) return true

  if (!authSupabase) return false
  const { data, error } = await authSupabase.auth.getUser(token)
  if (error) return false
  return !!data.user
}

type TargetType = 'parent' | 'student' | 'general'

function getTargetType(url?: string, title?: string): TargetType {
  if (url === '/parents') return 'parent'
  if (title?.includes('조교') || title?.includes('호출')) return 'student'
  return 'general'
}

function getRequestUrl(req: VercelRequest): string | undefined {
  const body = req.body as { url?: unknown } | undefined
  return typeof body?.url === 'string' ? body.url : undefined
}

function normalizeTargetType(targetType: TargetType): 'parent' | 'student' {
  return targetType === 'parent' ? 'parent' : 'student'
}

function logPushAudit(params: {
  result: 'success' | 'failure'
  targetType: TargetType
  statusCode: number
  errorReason?: string
}) {
  const payload = {
    result: params.result,
    target_type: normalizeTargetType(params.targetType),
    status_code: params.statusCode,
    error_reason: params.errorReason ?? null,
  }

  if (params.result === 'success') {
    console.info('[push.audit]', payload)
    return
  }
  console.error('[push.audit]', payload)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    logPushAudit({
      result: 'failure',
      targetType: getTargetType(getRequestUrl(req)),
      statusCode: 405,
      errorReason: 'method_not_allowed',
    })
    return res.status(405).end()
  }

  if (!(await isAuthorized(req))) {
    logPushAudit({
      result: 'failure',
      targetType: getTargetType(getRequestUrl(req)),
      statusCode: 401,
      errorReason: 'unauthorized',
    })
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { subscription, title, body, url } = req.body as {
    subscription: webpush.PushSubscription
    title: string
    body?: string
    url?: string
  }

  if (!subscription || !title) {
    logPushAudit({
      result: 'failure',
      targetType: getTargetType(url, title),
      statusCode: 400,
      errorReason: 'missing_fields',
    })
    return res.status(400).json({ error: 'missing fields' })
  }
  if (url && !url.startsWith('/')) {
    logPushAudit({
      result: 'failure',
      targetType: getTargetType(url, title),
      statusCode: 400,
      errorReason: 'invalid_url',
    })
    return res.status(400).json({ error: 'invalid url' })
  }

  const targetType = getTargetType(url, title)

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body, url }),
    )
    logPushAudit({
      result: 'success',
      targetType,
      statusCode: 200,
    })
    return res.status(200).json({ ok: true })
  } catch (err: unknown) {
    logPushAudit({
      result: 'failure',
      targetType,
      statusCode: 500,
      errorReason: String(err),
    })
    return res.status(500).json({ error: String(err) })
  }
}
