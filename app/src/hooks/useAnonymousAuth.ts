'use client'
import { useEffect, useState, useCallback } from 'react'
import {
  User, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, linkWithPopup, signInWithPopup,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

export type GoogleLinkResult = 'linked' | 'restored' | 'cancelled' | 'error'

export function useAnonymousAuth() {
  const [user, setUser]       = useState<User | null>(null)
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

  // 익명 계정에 Google 연결 (기기 바꿔도 UID 유지)
  const linkGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    if (!user) return 'error'
    const provider = new GoogleAuthProvider()
    try {
      await linkWithPopup(user, provider)
      return 'linked'
    } catch (e: any) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
        return 'cancelled'
      }
      // 이미 다른 계정에 연결된 Google 계정 → 그 계정으로 복원
      if (e.code === 'auth/credential-already-in-use') {
        try {
          await signInWithPopup(auth, provider)
          return 'restored'
        } catch {
          return 'error'
        }
      }
      return 'error'
    }
  }, [user])

  // 새 기기: 이미 Google 연결한 계정 복원
  const restoreWithGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    const provider = new GoogleAuthProvider()
    try {
      await signInWithPopup(auth, provider)
      return 'restored'
    } catch (e: any) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
        return 'cancelled'
      }
      return 'error'
    }
  }, [])

  const isLinked = !user?.isAnonymous
  const linkedEmail = isLinked
    ? user?.providerData.find((p) => p.providerId === 'google.com')?.email ?? null
    : null

  return { user, loading, linkGoogle, restoreWithGoogle, isLinked, linkedEmail }
}
