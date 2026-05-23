'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'

const TIME_OPTIONS = [
  { label: '15분 후', value: 15 },
  { label: '30분 후', value: 30 },
  { label: '45분 후', value: 45 },
  { label: '60분 후', value: 60 },
]

type Step = 'form' | 'done'

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

export default function EarlyReturnPage() {
  const { user } = useAnonymousAuth()

  const [roomId, setRoomId] = useState('')
  const [minutesLater, setMinutesLater] = useState<number | null>(30)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState<Step>('form')

  async function handleSubmit() {
    if (!user || !roomId.trim() || !minutesLater) return
    setSubmitting(true)
    setError('')
    try {
      const idToken = await user.getIdToken()
      const res = await fetch('/api/early-return', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ roomId: roomId.trim(), minutesLater, note }),
      })
      if (!res.ok) throw new Error(await res.text())
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : '등록에 실패했어요')
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh gap-5 px-6 bg-white">
        <div className="w-24 h-24 rounded-full bg-rb-50 flex items-center justify-center text-5xl">🙏</div>
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900">알려줘서 고마워요!</h2>
          <p className="text-gray-500 text-base mt-2">대기 중인 학우에게 알림을 보냈어요</p>
          <p className="text-rb-600 font-semibold mt-1">{roomId}호 — {minutesLater}분 후 반납 예정</p>
        </div>
        <Link
          href="/"
          className="mt-4 flex items-center justify-center w-full max-w-xs h-14 rounded-2xl bg-rb-600 text-white text-base font-bold active:scale-[0.98] transition-all"
        >
          홈으로
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 flex items-center gap-3">
        <Link href="/" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
        <div>
          <h1 className="text-xl font-bold text-white">조기 반납 예고</h1>
          <p className="text-rb-200 text-xs mt-0.5">반납 전에 미리 알려주세요</p>
        </div>
      </header>

      <main className="flex-1 px-4 pt-6 space-y-7">

        {/* 방 번호 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">몇 호 방이에요?</p>
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="예: 302"
            inputMode="numeric"
            className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-xl font-bold text-gray-900 placeholder:text-gray-300 placeholder:font-normal focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
          />
        </section>

        {/* 나갈 시각 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">언제 나갈 예정이에요?</p>
          <div className="grid grid-cols-2 gap-2">
            {TIME_OPTIONS.map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setMinutesLater(value)}
                className={`h-14 rounded-2xl text-base font-bold border-2 transition-all active:scale-95 ${
                  minutesLater === value
                    ? 'border-rb-600 bg-rb-600 text-white'
                    : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* 메모 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">
            메모 <span className="font-normal text-gray-400 normal-case">(선택)</span>
          </p>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="예: 밥 먹으러 가요"
            className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
          />
        </section>

        {/* 양보 안내 */}
        <div className="rounded-2xl bg-rb-50 border border-rb-100 px-4 py-3">
          <p className="text-sm font-bold text-rb-800">🎵 조기 반납으로 학우에게 양보해요</p>
          <p className="text-xs text-rb-600 mt-1">대기 중인 학우가 미리 이동해 전환 시간을 줄일 수 있어요</p>
        </div>

        {error && (
          <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm font-medium text-red-700">{error}</p>
          </div>
        )}

      </main>

      <div className="px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <button
          onClick={handleSubmit}
          disabled={submitting || !user || !roomId.trim() || !minutesLater}
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 active:scale-[0.98] transition-all"
        >
          {submitting ? '등록 중...' : '예고 등록하기'}
        </button>
        <p className="text-center text-xs text-gray-400 mt-2">등록하면 대기 중인 학우에게 알림이 가요</p>
      </div>

    </div>
  )
}
