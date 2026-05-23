'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { Room, COLLECTIONS } from '@/types/collections'

type FloorFilter = 'all' | 1 | 2 | 3
type TypeFilter = 'all' | 'piano' | 'church' | 'general'

const TYPE_LABEL: Record<string, string> = {
  piano:   '피아노과',
  church:  '교회음악과',
  general: '전체과',
}

const TYPE_STYLE: Record<string, string> = {
  piano:   'bg-rb-100 text-rb-700',
  church:  'bg-purple-100 text-purple-700',
  general: 'bg-gray-100 text-gray-600',
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [floor, setFloor] = useState<FloorFilter>('all')
  const [type, setType] = useState<TypeFilter>('all')

  useEffect(() => {
    getDocs(collection(db, COLLECTIONS.ROOMS))
      .then((snap) => {
        const list = snap.docs
          .map((d) => ({ ...(d.data() as Room), id: d.id }))
          .sort((a, b) => Number(a.id) - Number(b.id))
        setRooms(list)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = rooms.filter((r) => {
    if (floor !== 'all' && r.floor !== floor) return false
    if (type !== 'all' && r.type !== type) return false
    return true
  })

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <Link href="/" className="text-rb-200 text-xs font-semibold">← 홈</Link>
        <h1 className="text-xl font-bold text-white mt-0.5">방 비품 정보</h1>

        {/* 층 필터 */}
        <div className="flex gap-2 mt-4">
          {([['all', '전체'], [1, '1층'], [2, '2층'], [3, '3층']] as const).map(([v, label]) => (
            <button
              key={String(v)}
              onClick={() => setFloor(v)}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                floor === v ? 'bg-white text-rb-700' : 'bg-rb-700 text-rb-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 종류 필터 */}
        <div className="flex gap-2 mt-2">
          {([['all', '전체'], ['piano', '피아노과'], ['church', '교회음악과'], ['general', '전체과']] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setType(v)}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                type === v ? 'bg-white text-rb-700' : 'bg-rb-700 text-rb-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-gray-400 text-sm">불러오는 중...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p className="text-4xl">🎵</p>
            <p className="text-gray-500 text-sm">방 정보가 없어요</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((room) => (
              <div key={room.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-rb-50 flex items-center justify-center flex-shrink-0">
                      <span className="text-rb-700 font-bold text-sm">{room.id}호</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${TYPE_STYLE[room.type]}`}>
                          {TYPE_LABEL[room.type]}
                        </span>
                        <span className="text-xs text-gray-400">{room.floor}층</span>
                      </div>
                      {/* 비품 현황 */}
                      <div className="flex items-center gap-2.5 mt-1.5">
                        {room.pianoChairs > 0 && (
                          <span className="flex items-center gap-1 text-xs text-gray-600">
                            <span>🪑</span>
                            <span className="font-semibold">피아노의자 {room.pianoChairs}</span>
                          </span>
                        )}
                        {room.regularChairs > 0 && (
                          <span className="flex items-center gap-1 text-xs text-gray-600">
                            <span>🪑</span>
                            <span className="font-semibold">일반의자 {room.regularChairs}</span>
                          </span>
                        )}
                        {room.musicStands > 0 && (
                          <span className="flex items-center gap-1 text-xs text-gray-600">
                            <span>🎼</span>
                            <span className="font-semibold">보면대 {room.musicStands}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <p className="text-center text-xs text-gray-300 mt-6">
            비품 정보는 실제와 다를 수 있어요 · 오류 발견 시 제보해주세요
          </p>
        )}
      </main>
    </div>
  )
}
