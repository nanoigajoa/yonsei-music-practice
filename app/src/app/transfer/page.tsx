'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { TransferRequest, COLLECTIONS } from '@/types/collections'

type Filter = 'all' | 'give' | 'swap'

function pad(n: number) { return n.toString().padStart(2, '0') }
function toHHMM(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function timeAgo(ts: Timestamp) {
  const mins = Math.floor((Date.now() - ts.toMillis()) / 60000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  return `${Math.floor(mins / 60)}시간 전`
}

export default function TransferPage() {
  const { user } = useAnonymousAuth()
  const [items, setItems] = useState<TransferRequest[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [matching, setMatching] = useState<string | null>(null)
  const [matched, setMatched] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const q = query(
      collection(db, COLLECTIONS.TRANSFERS),
      where('status', 'in', ['open', 'urgent']),
    )
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ ...(d.data() as TransferRequest), id: d.id }))
        .sort((a, b) => {
          // urgent 먼저, 그 다음 최신순
          if (a.status === 'urgent' && b.status !== 'urgent') return -1
          if (b.status === 'urgent' && a.status !== 'urgent') return 1
          return b.createdAt.toMillis() - a.createdAt.toMillis()
        })
      setItems(list)
    })
  }, [])

  const filtered = filter === 'all' ? items : items.filter((i) => i.type === filter || i.status === 'urgent')

  async function handleMatch(item: TransferRequest) {
    if (!user || !item.id) return
    setMatching(item.id)
    setError('')
    try {
      const idToken = await user.getIdToken()
      const res = await fetch(`/api/transfers/${item.id}/match`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '매칭 실패')
      setMatched(item.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '매칭에 실패했어요')
    } finally {
      setMatching(null)
    }
  }

  async function handleCancel(item: TransferRequest) {
    if (!user || !item.id) return
    try {
      const idToken = await user.getIdToken()
      await fetch(`/api/transfers/${item.id}/cancel`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}` },
      })
    } catch {
      setError('취소에 실패했어요')
    }
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-rb-200 text-xs font-semibold">← 홈</Link>
            <h1 className="text-xl font-bold text-white mt-0.5">양도 · 바꿔치기</h1>
          </div>
          <Link
            href="/transfer/new"
            className="flex items-center gap-1.5 bg-white text-rb-600 text-sm font-bold px-4 py-2 rounded-xl active:scale-95 transition-all"
          >
            + 등록
          </Link>
        </div>

        {/* 필터 탭 */}
        <div className="flex gap-2 mt-4">
          {([['all', '전체'], ['give', '양도'], ['swap', '바꿔치기']] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                filter === v ? 'bg-white text-rb-700' : 'bg-rb-700 text-rb-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {error && (
          <div className="mb-3 rounded-2xl bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm font-medium text-red-700">{error}</p>
          </div>
        )}

        {matched && (
          <div className="mb-3 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3">
            <p className="text-sm font-bold text-emerald-800">🎉 매칭 완료! 상대방에게 알림을 보냈어요</p>
            <p className="text-xs text-emerald-600 mt-0.5">현장에서 직접 만나 진행해 주세요</p>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="text-5xl">🎵</div>
            <p className="text-gray-500 font-medium text-center">
              {filter === 'all' ? '아직 등록된 게시물이 없어요' : `${filter === 'give' ? '양도' : '바꿔치기'} 게시물이 없어요`}
            </p>
            <Link
              href="/transfer/new"
              className="mt-2 px-6 py-3 rounded-2xl bg-rb-600 text-white text-sm font-bold active:scale-95 transition-all"
            >
              첫 번째로 등록하기
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((item) => {
              const isOwn = item.userId === user?.uid
              const isMatchingThis = matching === item.id
              const isMatched = matched === item.id
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div className="px-4 pt-4 pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-12 h-12 rounded-xl bg-rb-50 flex items-center justify-center flex-shrink-0">
                          <span className="text-rb-700 font-bold text-sm">{item.roomId}호</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            {item.status === 'urgent' && (
                              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600 animate-pulse">🚨 긴급</span>
                            )}
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              item.type === 'give' ? 'bg-rb-100 text-rb-700' : 'bg-purple-100 text-purple-700'
                            }`}>
                              {item.type === 'give' ? '양도' : '바꿔치기'}
                            </span>
                            <span className="text-xs text-gray-400">{item.floor}층</span>
                          </div>
                          <p className="text-base font-bold text-gray-900 mt-0.5">
                            {toHHMM(item.endTime.toDate())}까지
                          </p>
                        </div>
                      </div>
                      <span className="text-xs text-gray-300 flex-shrink-0 mt-1">
                        {timeAgo(item.createdAt)}
                      </span>
                    </div>

                    {item.swapNote && (
                      <p className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-xl px-3 py-2">
                        💬 {item.swapNote}
                      </p>
                    )}
                  </div>

                  <div className="px-4 pb-4">
                    {isOwn ? (
                      <button
                        onClick={() => handleCancel(item)}
                        className="w-full h-10 rounded-xl border-2 border-gray-200 text-gray-500 text-sm font-semibold active:scale-[0.98] transition-all"
                      >
                        내 게시물 — 취소하기
                      </button>
                    ) : isMatched ? (
                      <div className="w-full h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                        <span className="text-emerald-700 text-sm font-bold">✅ 매칭 완료</span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleMatch(item)}
                        disabled={isMatchingThis}
                        className="w-full h-10 rounded-xl bg-rb-600 text-white text-sm font-bold disabled:opacity-60 active:scale-[0.98] transition-all"
                      >
                        {isMatchingThis ? '매칭 중...' : item.type === 'give' ? '🎁 양도 수락하기' : '🔄 바꿔치기 신청하기'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
