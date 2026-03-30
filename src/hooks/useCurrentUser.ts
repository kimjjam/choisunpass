import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useCurrentUser() {
  const [email, setEmail] = useState<string>('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? '')
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setEmail(session?.user.email ?? '')
    })
    return () => subscription.unsubscribe()
  }, [])

  return email
}
