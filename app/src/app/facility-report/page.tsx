'use client'

import { useState } from 'react'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { COLLECTIONS } from '@/types/collections'

const ISSUE_OPTIONS = [
  { id: 'piano',    label: '🎹 피아노 이상',      sub: '조율 필요, 건반 문제 등' },
  { id: 'stand',    label: '🎼 보면대 파손',       sub: '흔들림, 잠금 불량 등' },
  { id: 'chair',    label: '🪑 의자 파손',         sub: '높이 조절 불가, 파손 등' },
  { id: 'hvac',     label: '❄️ 냉방/난방 문제',    sub: '에어컨/히터 작동 불량' },
  { id: 'light',    label: '💡 전등/전기 문제',    sub: '전등 고장, 콘센트 불량' },
  { id: 'clean',    label: '🧹 청결 문제',         sub: '청소 요청, 이물질 등' },
  { id: 'sound',    label: '🔇 방음 문제',         sub: '소음, 방음재 훼손 등' },
  { id: 'other',    label: '📋 기타',              sub: '위 항목에 없는 문제' },
]

function extractFloor(roomId: string): number | null {
  const m = roomId.match(/(\d{3})/)
  if (!m) return null
  const n = parseInt(m[1])
  if (n >= 100 && n < 200) return 1
  if (n >= 200 && n < 300) return 2
  if (n >= 300 && n < 400) return 3
  return null
}

type Status = 'idle' | 'submitting' | 'done' | 'error'

export default function FacilityReportPage() {
  const { user } = useAnonymousAuth()

  const [name, setName]             = useState('')
  const [studentId, setStudentId]   = useState('')
  const [roomId, setRoomId]         = useState('')
  const [issues, setIssues]         = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [contact, setContact]       = useState('')
  const [status, setStatus]         = useState<Status>('idle')
  const [errorMsg, setErrorMsg]     = useState('')

  const floor = extractFloor(roomId)

  function toggleIssue(id: string) {
    setIssues(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }

  const canSubmit =
    name.trim().length > 0 &&
    studentId.trim().length === 8 &&
    /^\d{8}$/.test(studentId.trim()) &&
    roomId.trim().length > 0 &&
    issues.length > 0 &&
    description.trim().length > 0 &&
    status !== 'submitting'

  async function handleSubmit() {
    if (!canSubmit || !user) return
    setStatus('submitting')
    setErrorMsg('')
    try {
      await addDoc(collection(db, COLLECTIONS.FACILITY_REPORTS), {
        name:        name.trim(),
        studentId:   studentId.trim(),
        roomId:      roomId.trim(),
        floor,
        issues,
        description: description.trim(),
        contact:     contact.trim() || null,
        status:      'pending',
        userId:      user.uid,
        createdAt:   serverTimestamp(),
      })
      setStatus('done')
    } catch {
      setErrorMsg('제출에 실패했어요. 다시 시도해 주세요.')
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh gap-5 px-6 bg-white text-center">
        <div className="w-20 h-20 rounded-full bg-rb-50 flex items-center justify-center text-4xl">📋</div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">신고 접수 완료</h2>
          <p className="text-gray-500 text-sm mt-2">소중한 제보 감사해요.</p>
          <p className="text-gray-400 text-xs mt-1">매주 월요일 행정실에 취합하여 전달됩니다.</p>
        </div>
        <Link
          href="/"
          className="mt-2 w-full max-w-xs h-14 flex items-center justify-center rounded-2xl bg-rb-600 text-white font-bold active:scale-[0.98] transition-all"
        >
          홈으로
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <Link href="/" className="text-rb-200 text-xs font-semibold">← 홈</Link>
        <h1 className="text-xl font-bold text-white mt-0.5">시설 신문고</h1>
        <p className="text-rb-200 text-xs mt-0.5">파손·고장 신고 → 매주 행정실 전달</p>
      </header>

      <main className="flex-1 px-4 pt-6 pb-4 space-y-7">

        {/* ① 인적사항 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">인적사항</p>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1.5 block">이름</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="홍길동"
                className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1.5 block">학번</label>
              <input
                type="text"
                inputMode="numeric"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="20250001"
                className={`w-full h-14 rounded-2xl border-2 bg-gray-50 px-4 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:bg-white focus:outline-none transition-colors ${
                  studentId.length > 0 && studentId.length !== 8
                    ? 'border-red-300 focus:border-red-400'
                    : 'border-gray-200 focus:border-rb-500'
                }`}
              />
              {studentId.length > 0 && studentId.length !== 8 && (
                <p className="text-xs text-red-400 mt-1">학번은 8자리예요 ({studentId.length}/8)</p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                연락처 <span className="font-normal text-gray-300">(선택 · 처리 결과 안내 시 사용)</span>
              </label>
              <input
                type="tel"
                inputMode="tel"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="010-0000-0000"
                className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
              />
            </div>
          </div>
        </section>

        {/* ② 신고 위치 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">신고 위치</p>
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">호실</label>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                inputMode="numeric"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="302"
                className="flex-1 h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 text-xl font-bold text-gray-900 placeholder:text-gray-300 placeholder:font-normal focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
              />
              {floor && (
                <div className="flex items-center justify-center h-14 px-4 rounded-2xl bg-rb-50 border-2 border-rb-100">
                  <span className="text-rb-700 font-bold">{floor}층</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ③ 문제 유형 (다중 선택) */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-1">문제 유형</p>
          <p className="text-xs text-gray-400 mb-3">해당하는 항목을 모두 선택해 주세요</p>
          <div className="space-y-2">
            {ISSUE_OPTIONS.map((opt) => {
              const selected = issues.includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggleIssue(opt.id)}
                  className={`w-full flex items-center gap-4 px-4 h-[60px] rounded-2xl border-2 transition-all active:scale-[0.99] text-left ${
                    selected ? 'border-rb-600 bg-rb-50' : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                    selected ? 'border-rb-600 bg-rb-600' : 'border-gray-300'
                  }`}>
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-bold ${selected ? 'text-rb-700' : 'text-gray-800'}`}>{opt.label}</p>
                    <p className="text-xs text-gray-400">{opt.sub}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {/* ④ 상세 설명 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">상세 설명</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="언제부터 문제가 발생했는지, 어떤 상태인지 자세히 적어주세요."
            rows={4}
            className="w-full rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 py-4 text-base text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors resize-none"
          />
          <p className="text-xs text-gray-400 mt-1 text-right">{description.length}자</p>
        </section>

        {/* 안내 */}
        <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-sm font-bold text-amber-800">📋 처리 안내</p>
          <ul className="text-xs text-amber-600 mt-1.5 space-y-0.5">
            <li>· 매주 월요일 음대 행정실에 취합하여 전달됩니다</li>
            <li>· 긴급한 경우 행정실에 직접 연락해 주세요</li>
            <li>· 연락처 입력 시 처리 결과를 안내해 드릴 수 있어요</li>
          </ul>
        </div>

        {status === 'error' && (
          <p className="text-sm text-red-500 font-medium text-center">{errorMsg}</p>
        )}

      </main>

      <div className="px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold disabled:opacity-30 active:scale-[0.98] transition-all shadow-md"
        >
          {status === 'submitting' ? '제출 중...' : '신고 접수하기'}
        </button>
        <p className="text-center text-xs text-gray-400 mt-2">개인정보는 행정 처리 목적으로만 사용됩니다</p>
      </div>

    </div>
  )
}
