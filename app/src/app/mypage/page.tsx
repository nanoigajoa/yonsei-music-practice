'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { clearStudentId, getStudentId } from '@/lib/localBooking'
import { useUserProfile } from '@/hooks/useUserProfile'
import { OnboardingModal } from '@/components/OnboardingModal'
import { AppMenu } from '@/components/AppMenu'
import { DEPARTMENTS, Department } from '@/types/collections'
import { PracticeHistory } from '@/components/PracticeHistory'

const DEPT_EMOJI: Record<string, string> = {
  '피아노과':   '🎹',
  '성악과':     '🎤',
  '관현악과':   '🎻',
  '교회음악과': '⛪',
  '작곡과':     '🎼',
  '미설정':     '🎵',
}

// ── 프로필 편집 시트 ──────────────────────────────────────
function EditProfileSheet({
  initialNickname, initialDept, onClose, onSave,
}: {
  initialNickname: string
  initialDept: Department | null
  onClose: () => void
  onSave: (nickname: string, department: Department) => Promise<void>
}) {
  const [nickname,   setNickname]   = useState(initialNickname)
  const [department, setDepartment] = useState<Department | null>(initialDept)
  const [saving,     setSaving]     = useState(false)

  const canSave = !!department && nickname.trim().length > 0 && !saving

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    try { await onSave(nickname.trim(), department!) } finally { setSaving(false) }
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <div className="w-full max-w-md bg-white rounded-t-3xl px-6 pt-5 pb-[calc(env(safe-area-inset-bottom)+28px)] shadow-2xl">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
          <h2 className="text-lg font-bold text-gray-900 mb-6">프로필 수정</h2>
          <div className="mb-5">
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-2">닉네임</p>
            <input type="text" value={nickname} maxLength={16}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full h-11 rounded-xl border-2 border-gray-200 px-3 text-sm font-bold text-gray-800 focus:border-rb-500 focus:outline-none transition-colors" />
            <p className="text-[11px] text-gray-400 mt-1.5 pl-1">최대 16자</p>
          </div>
          <div className="mb-7">
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-2">소속 과</p>
            <div className="grid grid-cols-2 gap-2">
              {DEPARTMENTS.map((dept) => (
                <button key={dept} onClick={() => setDepartment(dept)}
                  className={`flex items-center gap-2.5 h-12 px-3 rounded-xl border-2 font-bold text-sm transition-all active:scale-[0.97] ${
                    department === dept ? 'border-rb-600 bg-rb-600 text-white' : 'border-gray-200 bg-white text-gray-700'
                  }`}>
                  <span className="text-lg">{DEPT_EMOJI[dept]}</span>
                  <span>{dept}</span>
                </button>
              ))}
            </div>
          </div>
          <button onClick={handleSave} disabled={!canSave}
            className="w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 active:scale-[0.98] transition-all">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </>
  )
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.5 2.6 13.5l7.8 6C12.3 13.2 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17z"/>
      <path fill="#FBBC05" d="M10.4 28.5A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.5l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6.2z"/>
      <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.3-7.7 2.3-6.3 0-11.6-4.2-13.6-10l-7.8 6C6.6 42.5 14.6 48 24 48z"/>
    </svg>
  )
}

// ── 메인 페이지 ────────────────────────────────────────
export default function MyPage() {
  const { user, linkGoogle, restoreWithGoogle, isLinked, linkedEmail } = useAnonymousAuth()
  const { profile, isNew, suggestedNickname, rerollNickname, saveProfile } = useUserProfile(user)

  const [googleState, setGoogleState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [showEdit,    setShowEdit]    = useState(false)

  async function handleLinkGoogle() {
    setGoogleState('loading')
    const result = await linkGoogle()
    if (result === 'linked' || result === 'restored') setGoogleState('done')
    else if (result === 'error') setGoogleState('error')
    else setGoogleState('idle')
  }

  async function handleRestoreGoogle() {
    setGoogleState('loading')
    const result = await restoreWithGoogle()
    if (result === 'restored') setGoogleState('done')
    else if (result === 'error') setGoogleState('error')
    else setGoogleState('idle')
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
          <div>
            <h1 className="text-xl font-bold text-white">마이페이지</h1>
            <p className="text-rb-200 text-xs mt-0.5">프로필 · 연습 통계</p>
          </div>
          <div className="ml-auto"><AppMenu /></div>
        </div>

        {profile ? (
          <div className="rounded-2xl bg-white/10 px-4 py-3.5 flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-2xl">
              {DEPT_EMOJI[profile.department ?? '미설정'] ?? '🎵'}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-white font-bold text-base">{profile.nickname}</p>
                <button onClick={() => setShowEdit(true)}
                  className="text-rb-300 text-[11px] font-medium border border-rb-400 rounded-md px-1.5 py-0.5 active:opacity-70 transition-opacity">
                  편집
                </button>
              </div>
              <p className="text-rb-200 text-xs">{profile.department ?? '학과 미설정'}</p>
            </div>

          </div>
        ) : (
          <div className="rounded-2xl bg-white/10 px-4 py-3 text-rb-200 text-sm">로딩 중...</div>
        )}
      </header>

      <main className="flex-1 px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-5">

        {user && <PracticeHistory user={user} />}

        {/* ── Google 계정 연결 카드 ── */}
        {isLinked ? (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex items-center gap-3">
            <span className="text-lg">✅</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-emerald-800">Google 계정 연결됨</p>
              <p className="text-xs text-emerald-600 truncate">{linkedEmail}</p>
            </div>
          </div>
        ) : googleState === 'done' ? (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3">
            <p className="text-sm font-bold text-emerald-800">✅ 연결 완료! 다른 기기에서도 이 계정으로 복원할 수 있어요.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-gray-50 border-2 border-gray-100 px-4 py-3.5 space-y-3">
            <div>
              <p className="text-sm font-bold text-gray-800">기기 바꿔도 기록 유지하기</p>
              <p className="text-xs text-gray-500 mt-0.5">Google 계정을 연결하면 새 기기에서도 연습 기록과 설정을 복원할 수 있어요.</p>
            </div>
            {googleState === 'error' && (
              <p className="text-xs text-red-500 font-medium">연결에 실패했어요. 다시 시도해 주세요.</p>
            )}
            <div className="flex gap-2">
              <button onClick={handleLinkGoogle} disabled={googleState === 'loading'}
                className="flex-1 h-10 rounded-xl bg-white border-2 border-gray-200 text-sm font-bold text-gray-700 disabled:opacity-40 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5">
                {googleState === 'loading' ? '연결 중...' : <><GoogleIcon />Google 연결</>}
              </button>
              <button onClick={handleRestoreGoogle} disabled={googleState === 'loading'}
                className="flex-1 h-10 rounded-xl bg-white border-2 border-gray-200 text-sm font-bold text-gray-500 disabled:opacity-40 active:scale-[0.98] transition-all">
                계정 복원
              </button>
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-gray-50 border-2 border-gray-100 px-4 py-3.5 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-gray-800">이 기기의 예약 학번</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {(() => { const id = getStudentId(); return id ? `${id.slice(0, 4)}••••` : '미등록' })()}
            </p>
          </div>
          <button onClick={() => { clearStudentId(); window.location.assign('/') }}
            className="h-9 px-3 rounded-xl bg-white border border-gray-200 text-xs font-bold text-gray-600">
            변경
          </button>
        </div>

        <Link href="/alarm" className="block rounded-2xl bg-rb-50 border border-rb-200 p-4 text-rb-800">
          <p className="font-bold text-sm">찜·알림 설정 →</p><p className="text-xs mt-1">권한 확인 · 테스트 알림 · 태그·반납 알림</p>
        </Link>

      </main>

      {showEdit && profile && (
        <EditProfileSheet initialNickname={profile.nickname} initialDept={profile.department}
          onClose={() => setShowEdit(false)} onSave={saveProfile} />
      )}

      {isNew && suggestedNickname && (
        <OnboardingModal suggestedNickname={suggestedNickname} onReroll={rerollNickname} onSave={saveProfile} />
      )}
    </div>
  )
}
