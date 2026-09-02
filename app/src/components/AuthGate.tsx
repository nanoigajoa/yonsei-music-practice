'use client'

import { useState } from 'react'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, linkGoogle } = useAnonymousAuth()
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState('')
  const authenticated = user && !user.isAnonymous

  async function login() {
    setSigningIn(true)
    setError('')
    const result = await linkGoogle()
    if (result === 'error') setError('로그인에 실패했습니다. 다시 시도해 주세요.')
    setSigningIn(false)
  }

  if (loading) {
    return <div className="min-h-dvh flex items-center justify-center bg-rb-600 text-white text-sm">로그인 확인 중...</div>
  }
  if (!authenticated) {
    return (
      <main className="min-h-dvh max-w-md mx-auto bg-rb-600 px-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 rounded-3xl bg-white/15 flex items-center justify-center text-4xl">🎵</div>
        <h1 className="mt-6 text-2xl font-bold text-white">음대 연습실</h1>
        <p className="mt-2 text-sm leading-6 text-rb-200">처음 한 번만 로그인하면<br />다음부터 자동으로 연결됩니다.</p>
        <button onClick={login} disabled={signingIn}
          className="mt-8 h-14 w-full rounded-2xl bg-white text-gray-800 font-bold shadow-lg disabled:opacity-60">
          {signingIn ? '로그인 중...' : 'Google로 시작하기'}
        </button>
        {error && <p className="mt-3 text-sm text-red-200">{error}</p>}
        <p className="mt-5 text-[11px] leading-5 text-rb-300">Google 계정은 앱 로그인에만 사용되며<br />학번과 연결되지 않습니다.</p>
      </main>
    )
  }
  return children
}
