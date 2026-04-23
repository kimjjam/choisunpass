import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

function getEnv(...keys: string[]) {
  for (const key of keys) {
    const val = process.env[key]
    if (val) return val
  }
  return undefined
}

const supabaseUrl = getEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey = getEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
const bombPin = process.env.BOMB_PIN

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { pin, action, value } = req.body as {
    pin?: string
    action?: 'verify' | 'toggle'
    value?: boolean
  }

  if (!bombPin) return res.status(500).json({ error: 'BOMB_PIN not configured' })
  if (pin !== bombPin) return res.status(401).json({ error: 'Invalid PIN' })

  const dbKey = serviceRoleKey ?? anonKey
  if (!dbKey) return res.status(500).json({ error: 'Supabase key not configured' })

  const supabase = createClient(supabaseUrl, dbKey)

  if (action === 'verify') {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single()
    return res.status(200).json({ ok: true, maintenance: data?.value === 'true' })
  }

  if (action === 'toggle') {
    if (typeof value !== 'boolean') return res.status(400).json({ error: 'value must be boolean' })
    const { error } = await supabase.from('app_settings').upsert({
      key: 'maintenance_mode',
      value: String(value),
      updated_at: new Date().toISOString(),
    })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, maintenance: value })
  }

  return res.status(400).json({ error: 'action must be verify or toggle' })
}
