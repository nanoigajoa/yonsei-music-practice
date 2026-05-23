'use client'

import { useState } from 'react'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { COLLECTIONS } from '@/types/collections'

const QUEUE_OPTIONS = [
  { label: '없음',     sub: '대기 없어요',    value: 0,  icon: '🟢' },
  { label: '1–2명',   sub: '잠깐 기다려요',  value: 1,  icon: '🟡' },
  { label: '3–5명',   sub: '조금 붐벼요',    value: 3,  icon: '🟠' },
  { label: '6–10명',  sub: '많이 기다려요',  value: 6,  icon: '🔴' },
  { label: '10명 이상', sub: '매우 혼잡해요', value: 11, icon: '🔴' },
]

type Status = 'idle' | 'loading' | 'done' | 'error'

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export default function ReportPage() {
  const { user } = useAnonymousAuth()
  const router = useRouter()

  const [floor, setFloor] = useState<1 | 2 | 3 | null>(null)
  const [queueValue, setQueueValue] = useState<number | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')

  async function handleSubmit() {
    if (floor === null || queueValue === null) return
    setStatus('loading')
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 8000),
      )
      await Promise.race([
        addDoc(collection(db, COLLECTIONS.CONGESTION), {
          floor,
          queueCount: queueValue,
          reportedBy: user?.uid ?? null,
          createdAt: serverTimestamp(),
        }),
        timeout,
      ])
      setStatus('done')
      setTimeout(() => router.push('/'), 1500)
    } catch (e) {
      console.error(e)
      setErrMsg(getErrMsg(e))
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh gap-4 px-5 bg-white">
        <div className="w-20 h-20 rounded-full bg-rb-50 flex items-center justify-center text-4xl">🎵</div>
        <h2 className="text-2xl font-bold text-gray-900">보고 완료!</h2>
        <p className="text-gray-500 text-base text-center">학우들에게 큰 도움이 됐어요 ✨</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* 헤더 */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 flex items-center gap-3">
        <Link href="/" className="text-white/70 hover:text-white transition-colors p-1 -ml-1">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white">대기 보고하기</h1>
          <p className="text-rb-200 text-xs mt-0.5">키오스크 앞 대기 인원을 알려주세요</p>
        </div>
      </header>

      <main className="flex-1 px-4 pt-6 space-y-8">

        {/* 층 선택 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">어느 층 키오스크인가요?</p>
          <div className="grid grid-cols-3 gap-3">
            {([1, 2, 3] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFloor(f)}
                className={`h-20 rounded-2xl text-xl font-bold border-2 transition-all active:scale-95 flex flex-col items-center justify-center gap-1 ${
                  floor === f
                    ? 'border-rb-600 bg-rb-600 text-white shadow-md'
                    : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                <span>{f}층</span>
                <span className={`text-xs font-normal ${floor === f ? 'text-rb-100' : 'text-gray-400'}`}>
                  키오스크
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* 대기 인원 선택 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">지금 몇 명이 기다리고 있나요?</p>
          <div className="space-y-2">
            {QUEUE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setQueueValue(opt.value)}
                className={`w-full flex items-center gap-4 px-4 h-[60px] rounded-2xl border-2 transition-all active:scale-[0.99] ${
                  queueValue === opt.value
                    ? 'border-rb-600 bg-rb-50'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <span className="text-xl">{opt.icon}</span>
                <div className="flex-1 text-left">
                  <span className={`text-base font-bold ${queueValue === opt.value ? 'text-rb-700' : 'text-gray-800'}`}>
                    {opt.label}
                  </span>
                </div>
                <span className={`text-sm ${queueValue === opt.value ? 'text-rb-500' : 'text-gray-400'}`}>
                  {opt.sub}
                </span>
              </button>
            ))}
          </div>
        </section>

      </main>

      {/* 제출 버튼 */}
      <div className="px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {status === 'error' && (
          <>
            <p className="text-center text-sm text-red-500 mb-1 font-medium">보고에 실패했어요. 다시 시도해 주세요.</p>
            {errMsg && <p className="text-center text-xs text-red-400 mb-3 break-all">{errMsg}</p>}
          </>
        )}
        <button
          onClick={handleSubmit}
          disabled={floor === null || queueValue === null || status === 'loading'}
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {status === 'loading' ? '보고 중...' : '보고하기'}
        </button>
        <p className="text-center text-xs text-gray-400 mt-2">익명으로 제출돼요</p>
      </div>

    </div>
  )
}
