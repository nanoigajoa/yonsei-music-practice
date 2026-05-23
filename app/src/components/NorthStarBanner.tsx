'use client'

import { useEffect, useState } from 'react'
import { collection, getAggregateFromServer, sum, count } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { COLLECTIONS } from '@/types/collections'

interface Props {
  todayCount: number  // 새 보고 들어올 때 재계산 트리거
}

function formatTime(minutes: number) {
  if (minutes < 60) return `${minutes}분`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
}

export function NorthStarBanner({ todayCount }: Props) {
  const [totalMinutes, setTotalMinutes] = useState<number | null>(null)
  const [totalReports, setTotalReports] = useState<number | null>(null)

  useEffect(() => {
    getAggregateFromServer(collection(db, COLLECTIONS.CONGESTION), {
      total: count(),
      queueSum: sum('queueCount'),
    }).then((snap) => {
      const d = snap.data()
      setTotalReports(d.total)
      setTotalMinutes(d.queueSum * 5)
    }).catch(() => {})
  }, [todayCount])

  if (totalReports === null) return null

  return (
    <div className="mx-4 mt-4 rounded-2xl bg-rb-600 px-5 py-4">
      <p className="text-rb-200 text-xs font-semibold uppercase tracking-wider">지금까지 공유된 대기 정보</p>
      <p className="text-white text-4xl font-bold mt-1 tracking-tight">
        {totalReports.toLocaleString()}번
      </p>
      <p className="text-rb-200 text-sm mt-1">
        최대 {formatTime(totalMinutes ?? 0)} 줄서기 감소 가능 · 오늘 {todayCount}명 참여
      </p>
    </div>
  )
}
