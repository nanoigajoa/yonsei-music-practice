'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { collection, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { COLLECTIONS } from '@/types/collections'

function pad(n: number) { return n.toString().padStart(2, '0') }
function toHHMM(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

export default function TransferNewPage() {
  const { user } = useAnonymousAuth()
  const router = useRouter()

  const [roomId, setRoomId] = useState('')
  const [floor, setFloor] = useState<1 | 2 | 3 | null>(null)
  const [endTimeInput, setEndTimeInput] = useState('')
  const [type, setType] = useState<'give' | 'swap'>('give')
  const [swapNote, setSwapNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setEndTimeInput(toHHMM(new Date(Date.now() + 2 * 60 * 60 * 1000)))
  }, [])

  async function handleSubmit() {
    if (!user || !roomId.trim() || !floor || !endTimeInput) return
    setSubmitting(true)
    setError('')
    try {
      const [h, m] = endTimeInput.split(':').map(Number)
      const endDate = new Date()
      endDate.setHours(h, m, 0, 0)
      if (endDate.getTime() <= Date.now()) endDate.setDate(endDate.getDate() + 1)

      await addDoc(collection(db, COLLECTIONS.TRANSFERS), {
        roomId: roomId.trim(),
        floor,
        userId: user.uid,
        endTime: Timestamp.fromDate(endDate),
        type,
        swapNote: type === 'swap' ? swapNote.trim() || null : null,
        matchedBy: null,
        status: 'open',
        createdAt: serverTimestamp(),
      })
      router.push('/transfer')
    } catch (e) {
      setError(e instanceof Error ? e.message : '등록에 실패했어요')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 flex items-center gap-3">
        <Link href="/transfer" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
        <div>
          <h1 className="text-xl font-bold text-white">양도 · 바꿔치기 등록</h1>
          <p className="text-rb-200 text-xs mt-0.5">방을 넘기거나 교환할 상대를 찾아요</p>
        </div>
      </header>

      <main className="flex-1 px-4 pt-6 space-y-7">

        {/* 타입 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">어떤 방식인가요?</p>
          <div className="grid grid-cols-2 gap-2">
            {([['give', '양도', '방을 통째로 넘겨요'], ['swap', '바꿔치기', '서로 카드를 교환해요']] as const).map(([v, label, sub]) => (
              <button
                key={v}
                onClick={() => setType(v)}
                className={`h-20 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 ${
                  type === v ? 'border-rb-600 bg-rb-600 text-white' : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                <span className="text-base font-bold">{label}</span>
                <span className={`text-xs ${type === v ? 'text-rb-100' : 'text-gray-400'}`}>{sub}</span>
              </button>
            ))}
          </div>
        </section>

        {/* 방 번호 + 층 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">방 정보</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="방 번호 (예: 302)"
              inputMode="numeric"
              className="flex-1 h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 text-lg font-bold text-gray-900 placeholder:text-gray-300 placeholder:font-normal focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
            />
            <div className="flex gap-1.5">
              {([1, 2, 3] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFloor(f)}
                  className={`w-14 h-14 rounded-2xl text-sm font-bold border-2 transition-all active:scale-95 ${
                    floor === f ? 'border-rb-600 bg-rb-600 text-white' : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  {f}층
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 예약 종료 시각 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">예약 종료 시각</p>
          <input
            type="time"
            value={endTimeInput}
            onChange={(e) => setEndTimeInput(e.target.value)}
            className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-2xl font-bold text-gray-900 text-center focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
          />
        </section>

        {/* 바꿔치기 조건 메모 */}
        {type === 'swap' && (
          <section>
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">
              원하는 조건 <span className="font-normal text-gray-400 normal-case">(선택)</span>
            </p>
            <input
              type="text"
              value={swapNote}
              onChange={(e) => setSwapNote(e.target.value)}
              placeholder="예: 피아노 방 선호해요"
              className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
            />
          </section>
        )}

        {/* 안내 */}
        <div className="rounded-2xl bg-rb-50 border border-rb-100 px-4 py-3">
          <p className="text-sm font-bold text-rb-800">
            {type === 'give' ? '🎁 양도 후 상대방이 새로 예약해요' : '🔄 현장에서 서로 카드를 교환해요'}
          </p>
          <p className="text-xs text-rb-600 mt-1">
            {type === 'give' ? '수락자가 키오스크에서 예약 후 현장에서 카드 전달' : '두 사람이 방 앞에서 직접 만나 학생증 교환'}
          </p>
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
          disabled={submitting || !user || !roomId.trim() || !floor || !endTimeInput}
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 active:scale-[0.98] transition-all"
        >
          {submitting ? '등록 중...' : '게시물 올리기'}
        </button>
      </div>
    </div>
  )
}
