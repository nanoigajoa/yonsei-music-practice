'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { EarlyReturn, COLLECTIONS } from '@/types/collections'

function timeLeft(plannedTime: Timestamp): string {
  const mins = Math.round((plannedTime.toMillis() - Date.now()) / 60000)
  if (mins <= 0) return '곧 반납'
  if (mins === 1) return '1분 후'
  return `${mins}분 후`
}

export function EarlyReturnList() {
  const [items, setItems] = useState<EarlyReturn[]>([])
  const [, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const cutoff = Timestamp.fromMillis(Date.now() - 2 * 60 * 1000)
    const q = query(
      collection(db, COLLECTIONS.EARLY_RETURN),
      where('plannedTime', '>=', cutoff),
    )
    return onSnapshot(q, (snap) => {
      const now = Date.now()
      const list = snap.docs
        .map((d) => ({ ...(d.data() as EarlyReturn), id: d.id }))
        .filter((r) => !r.isTransferred && r.plannedTime.toMillis() > now - 2 * 60 * 1000)
        .sort((a, b) => a.plannedTime.toMillis() - b.plannedTime.toMillis())
      setItems(list)
    })
  }, [])

  if (items.length === 0) return null

  return (
    <section className="px-4 pb-2">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-bold text-rb-600 uppercase tracking-wider">곧 빌 방</p>
        <Link href="/early-return" className="text-xs text-rb-500 font-semibold">
          예고 등록 →
        </Link>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-4 bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3.5">
            <div className="w-11 h-11 rounded-xl bg-rb-50 flex items-center justify-center flex-shrink-0">
              <span className="text-rb-600 font-bold text-sm">{item.roomId}호</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900">{timeLeft(item.plannedTime)} 반납 예정</p>
              {item.note && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">"{item.note}"</p>
              )}
            </div>
            <span className="text-xs font-semibold text-rb-600 bg-rb-50 px-2.5 py-1 rounded-full flex-shrink-0">
              {timeLeft(item.plannedTime)}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
