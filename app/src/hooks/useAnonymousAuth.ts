'use client'
import { useEffect, useState, useCallback } from 'react'
import {
  User, onAuthStateChanged, browserLocalPersistence, setPersistence,
  GoogleAuthProvider, linkWithPopup, signInWithPopup,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

export type GoogleLinkResult = 'linked' | 'restored' | 'cancelled' | 'error'

export function useAnonymousAuth() {
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void setPersistence(auth, browserLocalPersistence)
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  // 익명 계정에 Google 연결 (기기 바꿔도 UID 유지)
  const linkGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    const provider = new GoogleAuthProvider()
    try {
      if (user?.isAnonymous) {
        await linkWithPopup(user, provider)
        return 'linked'
      }
      await signInWithPopup(auth, provider)
      return 'restored'
    } catch (e: unknown) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return 'cancelled'
      }
      // 이미 다른 계정에 연결된 Google 계정 → 그 계정으로 복원
      if (code === 'auth/credential-already-in-use') {
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
    } catch (e: unknown) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
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
