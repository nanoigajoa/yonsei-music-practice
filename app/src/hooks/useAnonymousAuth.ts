'use client'
import { useEffect, useState, useCallback } from 'react'
import {
  User, onAuthStateChanged, browserLocalPersistence, setPersistence,
  GoogleAuthProvider, getRedirectResult, linkWithPopup, linkWithRedirect,
  signInWithPopup, signInWithRedirect,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { GoogleLinkResult, googleErrorResult } from '@/lib/googleAuthError'

export type { GoogleLinkResult } from '@/lib/googleAuthError'

export function useAnonymousAuth() {
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<GoogleLinkResult | null>(null)

  useEffect(() => {
    let cancelled = false
    let unsubscribe = () => {}
    void (async () => {
      // 로그인 버튼을 노출하기 전에 영속 저장소 설정을 완료해야, 로그인 팝업이
      // 열리는 순간의 Firebase 상태와 이후 복원 상태가 엇갈리지 않는다.
      try {
        await setPersistence(auth, browserLocalPersistence)
      } catch {
        // 지원하지 않는 브라우저도 상태 관찰은 계속해, 아래의 명확한 오류 안내로
        // 사용자가 일반 Safari/Chrome으로 복구할 수 있게 한다.
      }
      if (cancelled) return
      try {
        // 모바일 redirect 로그인에서 돌아온 결과를 먼저 처리한다. 실패했을 때
        // 빈 Firebase 페이지에 남기지 않고 앱 안에서 복구 안내를 보여준다.
        await getRedirectResult(auth)
      } catch (error) {
        if (!cancelled) setAuthError(googleErrorResult(error))
      }
      if (cancelled) return
      unsubscribe = onAuthStateChanged(auth, (currentUser) => {
        setUser(currentUser)
        setLoading(false)
      })
    })()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  function shouldUseRedirect() {
    return typeof navigator !== 'undefined'
      && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  }

  // 모바일은 Firebase 권장 방식인 redirect, 데스크톱은 팝업을 사용한다.
  const linkGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    const provider = new GoogleAuthProvider()
    setAuthError(null)
    try {
      if (shouldUseRedirect()) {
        if (user?.isAnonymous) await linkWithRedirect(user, provider)
        else await signInWithRedirect(auth, provider)
        return 'redirecting'
      }
      if (user?.isAnonymous) {
        await linkWithPopup(user, provider)
        return 'linked'
      }
      await signInWithPopup(auth, provider)
      return 'restored'
    } catch (e: unknown) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : ''
      // 이미 다른 계정에 연결된 Google 계정 → 그 계정으로 복원
      if (code === 'auth/credential-already-in-use') {
        try {
          await signInWithPopup(auth, provider)
          return 'restored'
        } catch (restoreError) {
          return googleErrorResult(restoreError)
        }
      }
      return googleErrorResult(e)
    }
  }, [user])

  // 새 기기: 이미 Google 연결한 계정 복원
  const restoreWithGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    const provider = new GoogleAuthProvider()
    setAuthError(null)
    try {
      if (shouldUseRedirect()) {
        await signInWithRedirect(auth, provider)
        return 'redirecting'
      }
      await signInWithPopup(auth, provider)
      return 'restored'
    } catch (e: unknown) {
      return googleErrorResult(e)
    }
  }, [])

  const isLinked = !user?.isAnonymous
  const linkedEmail = isLinked
    ? user?.providerData.find((p) => p.providerId === 'google.com')?.email ?? null
    : null

  return { user, loading, authError, linkGoogle, restoreWithGoogle, isLinked, linkedEmail }
}
