'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { getStudentId, YONSEI_STUDENT_ID_PATTERN, saveStudentId } from '@/lib/localBooking'

const API_URL = process.env.NEXT_PUBLIC_BOOKING_API_URL
  ?? process.env.NEXT_PUBLIC_KIOSK_API_URL
  ?? 'http://localhost:8000'

const LOGIN_MESSAGES = {
  unauthorized_domain: '이 배포 주소가 Google 로그인 허용 도메인에 등록되지 않았습니다. 운영자에게 알려 주세요.',
  provider_disabled: 'Firebase에서 Google 로그인이 아직 활성화되지 않았습니다. 운영자에게 알려 주세요.',
  popup_blocked: '브라우저가 Google 로그인 창을 차단했습니다. 팝업을 허용한 뒤 다시 시도해 주세요.',
  network_error: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
  storage_unavailable: '이 브라우저에서는 로그인 정보를 유지할 수 없어요. 카카오톡·인스타 앱 안이나 시크릿 모드가 아닌 Safari 또는 Chrome에서 다시 열어 주세요.',
  error: '로그인에 실패했습니다. 다시 시도해 주세요.',
} as const

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, authError, linkGoogle } = useAnonymousAuth()
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState('')
  const [studentId, setStudentId] = useState('')
  const [savedStudentId, setSavedStudentId] = useState(() => getStudentId())
  const [binding, setBinding] = useState<'idle' | 'checking' | 'ready'>('idle')
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false)
  const authenticated = user && !user.isAnonymous

  async function login() {
    setSigningIn(true)
    setError('')
    const result = await linkGoogle()
    if (result in LOGIN_MESSAGES) setError(LOGIN_MESSAGES[result as keyof typeof LOGIN_MESSAGES])
    // redirect는 Google 페이지로 이동하므로 돌아오기 전까지 버튼을 계속 비활성화한다.
    if (result !== 'redirecting') setSigningIn(false)
  }

  useEffect(() => {
    if (authError && authError in LOGIN_MESSAGES) {
      setError(LOGIN_MESSAGES[authError as keyof typeof LOGIN_MESSAGES])
      setSigningIn(false)
    }
  }, [authError])

  async function bindStudent(id: string) {
    const idToken = await user?.getIdToken(true)
    if (!idToken) throw new Error('Google 로그인이 필요합니다.')
    const response = await fetch(`${API_URL}/identity/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ student_id: id, privacy_notice_version: '2026-09-06' }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.detail ?? '학번 등록을 확인하지 못했습니다.')
  }

  // 이 기기에 저장되어 있던 학번도 서버의 Google 계정 연결과 대조한다.
  // 브라우저 저장소를 지웠다가 다른 학번을 넣어도 예약 API가 통과하지 않는다.
  useEffect(() => {
    if (!authenticated || !savedStudentId) {
      setBinding('idle')
      return
    }
    let cancelled = false
    setBinding('checking')
    void bindStudent(savedStudentId)
      .then(() => { if (!cancelled) setBinding('ready') })
      .catch((cause: unknown) => {
        if (cancelled) return
        setBinding('idle')
        setSavedStudentId('')
        setError(cause instanceof Error ? cause.message : '학번 등록을 확인하지 못했습니다.')
      })
    return () => { cancelled = true }
  // bindStudent uses the current Firebase user and deliberately reruns when its UID changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, savedStudentId, user?.uid])

  async function saveAndBindStudent() {
    if (!YONSEI_STUDENT_ID_PATTERN.test(studentId) || !noticeAcknowledged) return
    setSigningIn(true)
    setError('')
    try {
      await bindStudent(studentId)
      saveStudentId(studentId)
      setSavedStudentId(studentId)
      setBinding('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '학번 등록을 확인하지 못했습니다.')
    } finally {
      setSigningIn(false)
    }
  }

  if (loading) {
    return <div className="min-h-dvh flex items-center justify-center bg-rb-600 text-white text-sm">로그인 확인 중...</div>
  }
  if (!authenticated) {
    return (
      <main className="min-h-dvh max-w-md mx-auto bg-rb-600 px-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 rounded-3xl bg-white/15 flex items-center justify-center text-4xl">🎵</div>
        <h1 className="mt-6 text-2xl font-bold text-white">음대 연습실</h1>
        <p className="mt-2 text-sm leading-6 text-white">처음 한 번만 로그인하면<br />다음부터 자동으로 연결됩니다.</p>
        <button onClick={login} disabled={signingIn}
          className="mt-8 h-14 w-full rounded-2xl bg-white text-gray-800 font-bold shadow-lg disabled:opacity-60">
          {signingIn ? '로그인 중...' : 'Google로 시작하기'}
        </button>
        {error && <p className="mt-3 text-sm text-red-200">{error}</p>}
        <p className="mt-5 text-[11px] leading-5 text-white">Google 계정당 학번 하나만 등록할 수 있습니다.</p>
      </main>
    )
  }
  if (savedStudentId && binding !== 'ready') {
    return <div className="min-h-dvh flex items-center justify-center bg-rb-600 text-white text-sm">등록된 학번 확인 중...</div>
  }
  if (!savedStudentId) {
    const valid = YONSEI_STUDENT_ID_PATTERN.test(studentId)
    return (
      <main className="min-h-dvh max-w-md mx-auto bg-rb-600 px-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 rounded-3xl bg-white/15 flex items-center justify-center text-4xl">🪪</div>
        <h1 className="mt-6 text-2xl font-bold text-white">학번을 한 번만 입력하세요</h1>
        <p className="mt-2 text-sm leading-6 text-white">연세대학교 학번 10자리를 입력하세요.<br />학교 키오스크에서 이용 가능한 학번만 등록됩니다.</p>
        <input value={studentId} onChange={(e) => setStudentId(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric" maxLength={10} placeholder="학번 10자리"
          className="mt-7 h-14 w-full rounded-2xl bg-white px-4 text-center text-lg font-bold text-gray-900 outline-none" />
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl bg-white/10 p-4 text-left text-xs leading-5 text-white">
          <input type="checkbox" checked={noticeAcknowledged} onChange={(event) => setNoticeAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-white" />
          <span>
            학번은 예약·취소·반납 처리와 학교 키오스크 연동을 위해 연동 서버와 학교 예약 시스템에 전송됩니다.
            Google 비밀번호는 앱이나 연동 서버에 저장·전송되지 않습니다. 학생증 태그는 반드시 현장 단말기에서 해야 하며, 키오스크 상태가 최종 기준입니다.
            <span className="mt-1 block font-bold">[필수] 개인정보 처리 안내를 확인했습니다.</span>
          </span>
        </label>
        <Link href="/privacy" target="_blank" className="mt-2 block text-left text-[11px] text-white underline underline-offset-2">개인정보처리방침 보기</Link>
        <button disabled={!valid || !noticeAcknowledged || signingIn} onClick={saveAndBindStudent}
          className="mt-3 h-14 w-full rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40">
          {signingIn ? '등록 확인 중...' : '등록하고 시작하기'}
        </button>
        {error && <p className="mt-4 text-[11px] leading-5 text-red-200">{error}</p>}
        <p className="mt-4 text-[11px] leading-5 text-white">등록 후에는 Google 계정당 학번 하나만 사용할 수 있습니다.</p>
      </main>
    )
  }
  return children
}
