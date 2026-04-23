import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'

interface Props {
  children: React.ReactNode
  requiredRole?: 'admin'
}

export default function ProtectedRoute({ children, requiredRole }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">로딩 중...</div>
  )
  if (!session) return <Navigate to="/login" replace />
  if (requiredRole && session.user.app_metadata?.role !== requiredRole) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
        접근 권한이 없습니다.
      </div>
    )
  }
  return <>{children}</>
}
