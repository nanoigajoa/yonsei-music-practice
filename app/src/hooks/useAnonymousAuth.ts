'use client'
import { useEffect, useState } from 'react'
import { User, signInAnonymously, onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase'

export function useAnonymousAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser)
        setLoading(false)
      } else {
        try {
          const { user: newUser } = await signInAnonymously(auth)
          setUser(newUser)
        } catch (e) {
          console.error('Anonymous sign-in failed:', e)
        } finally {
          setLoading(false)
        }
      }
    })
    return unsubscribe
  }, [])

  return { user, loading }
}
