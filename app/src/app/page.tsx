'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { NotificationBanner } from '@/components/NotificationBanner'
import { EarlyReturnList } from '@/components/EarlyReturnList'
import { UrgentTossSheet } from '@/components/UrgentTossSheet'
import { CongestionReport, TransferRequest, COLLECTIONS } from '@/types/collections'
import { NorthStarBanner } from '@/components/NorthStarBanner'
import { useRoomStatus } from '@/hooks/useRoomStatus'

interface FloorStatus {
  avg: number | null
  lastAt: Date | null
}

function statusConfig(avg: number | null) {
  if (avg === null) return {
    label: '정보 없음',
    sub: '아직 보고가 없어요',
    dot: 'bg-gray-300',
    text: 'text-gray-500',
    badge: 'bg-gray-100 text-gray-500',
    bar: 'bg-gray-200',
    barWidth: 'w-0',
  }
  if (avg === 0) return {
    label: '한산해요',
    sub: '대기 없음',
    dot: 'bg-emerald-400',
    text: 'text-emerald-700',
    badge: 'bg-emerald-50 text-emerald-700',
    bar: 'bg-emerald-400',
    barWidth: 'w-1/12',
  }
  if (avg <= 2) return {
    label: `약 ${Math.round(avg)}명 대기`,
    sub: '잠깐 기다려요',
    dot: 'bg-yellow-400',
    text: 'text-yellow-700',
    badge: 'bg-yellow-50 text-yellow-700',
    bar: 'bg-yellow-400',
    barWidth: 'w-3/12',
  }
  if (avg <= 5) return {
    label: `약 ${Math.round(avg)}명 대기`,
    sub: '조금 붐벼요',
    dot: 'bg-orange-400',
    text: 'text-orange-700',
    badge: 'bg-orange-50 text-orange-700',
    bar: 'bg-orange-400',
    barWidth: 'w-6/12',
  }
  return {
    label: `약 ${Math.round(avg)}명 대기`,
    sub: '매우 혼잡해요',
    dot: 'bg-red-500',
    text: 'text-red-700',
    badge: 'bg-red-50 text-red-700',
    bar: 'bg-red-500',
    barWidth: 'w-10/12',
  }
}

// 10분 반감기 지수 감쇠 가중 평균: 최신 보고에 더 높은 가중치
function weightedAvg(reports: CongestionReport[], nowMs: number): number {
  const DECAY = 10 * 60 * 1000
  let wSum = 0, wTotal = 0
  for (const r of reports) {
    const w = Math.pow(0.5, (nowMs - r.createdAt.toMillis()) / DECAY)
    wSum += r.queueCount * w
    wTotal += w
  }
  return wTotal > 0 ? wSum / wTotal : 0
}

function timeAgo(date: Date, nowMs: number) {
  const mins = Math.floor((nowMs - date.getTime()) / 60000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  return `${Math.floor(mins / 60)}시간 전`
}

export default function HomePage() {
  const { user } = useAnonymousAuth()
  const { status: roomStatus } = useRoomStatus()

  const [reports, setReports] = useState<CongestionReport[]>([])
  const [now, setNow] = useState(Date.now())
  const [floorStatus, setFloorStatus] = useState<Record<number, FloorStatus>>({
    1: { avg: null, lastAt: null },
    2: { avg: null, lastAt: null },
    3: { avg: null, lastAt: null },
  })
  const [todayCount, setTodayCount] = useState(0)
  const [allUrgentItems, setAllUrgentItems] = useState<TransferRequest[]>([])
  const [urgentItems, setUrgentItems] = useState<TransferRequest[]>([])
  const [showTossSheet, setShowTossSheet] = useState(false)
  const [tossSuccess, setTossSuccess] = useState<{ roomId: string; floor: number } | null>(null)

  // 1분마다 now 갱신 → floorStatus 재계산 + 긴급 토스 TTL 만료 트리거
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // 오늘 보고 실시간 구독 — 원본 데이터만 저장
  useEffect(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const q = query(
      collection(db, COLLECTIONS.CONGESTION),
      where('createdAt', '>=', Timestamp.fromDate(todayStart)),
    )
    return onSnapshot(q, (snap) => {
      setReports(snap.docs.map((d) => ({ ...(d.data() as CongestionReport), id: d.id })))
    })
  }, [])

  // reports 또는 now 변경 시 floorStatus 재계산
  // → 30분 TTL 자동 만료 + 최신 보고 가중 평균 적용
  useEffect(() => {
    const cutoff = now - 30 * 60 * 1000
    const recent = reports.filter((r) => r.createdAt.toMillis() > cutoff)
    setTodayCount(reports.length)

    const next: Record<number, FloorStatus> = {
      1: { avg: null, lastAt: null },
      2: { avg: null, lastAt: null },
      3: { avg: null, lastAt: null },
    }
    ;[1, 2, 3].forEach((f) => {
      const fr = recent.filter((r) => r.floor === f)
      if (fr.length === 0) return
      const sorted = [...fr].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
      next[f] = {
        avg: weightedAvg(fr, now),
        lastAt: sorted[0].createdAt.toDate(),
      }
    })
    setFloorStatus(next)
  }, [reports, now])

  // 긴급 토스 실시간 구독 — 원본 전체 저장
  useEffect(() => {
    const cutoff = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000)
    const q = query(
      collection(db, COLLECTIONS.TRANSFERS),
      where('status', '==', 'urgent'),
      where('createdAt', '>=', cutoff),
    )
    return onSnapshot(q, (snap) => {
      setAllUrgentItems(
        snap.docs
          .map((d) => ({ ...(d.data() as TransferRequest), id: d.id }))
          .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()),
      )
    })
  }, [])

  // now 변경 시 긴급 토스 10분 TTL 자동 제거
  useEffect(() => {
    setUrgentItems(allUrgentItems.filter((r) => r.createdAt.toMillis() > now - 10 * 60 * 1000))
  }, [allUrgentItems, now])

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+20px)] pb-6">
        <p className="text-rb-200 text-xs font-semibold tracking-widest uppercase">Yonsei Music</p>
        <h1 className="text-white text-2xl font-bold mt-1">연습실 대기현황</h1>
        <p className="text-rb-200 text-sm mt-0.5">최근 30분 보고 기준 · 실시간 갱신</p>
      </header>

      {/* ── 알림 배너 ── */}
      <NotificationBanner user={user} />

      {/* ── 긴급 섹션 ── */}
      {urgentItems.length > 0 && (
        <div className="mx-4 mt-3 rounded-2xl bg-red-50 border border-red-200 overflow-hidden">
          <div className="px-4 py-2 bg-red-500 flex items-center gap-2">
            <span className="text-white text-xs font-bold animate-pulse">🚨 긴급</span>
            <span className="text-red-100 text-xs">방금 올라온 방이 있어요</span>
          </div>
          {urgentItems.map((item) => (
            <Link key={item.id} href="/transfer" className="flex items-center justify-between px-4 py-3 border-t border-red-100 first:border-0 active:bg-red-100 transition-colors">
              <div>
                <span className="text-sm font-bold text-red-800">{item.floor}층 {item.roomId}호</span>
                <span className="text-xs text-red-500 ml-2">지금 바로 수락 가능</span>
              </div>
              <span className="text-xs font-bold text-red-500">확인 →</span>
            </Link>
          ))}
        </div>
      )}

      {/* ── 토스 성공 ── */}
      {tossSuccess && (
        <div className="mx-4 mt-3 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex items-center justify-between">
          <p className="text-sm font-bold text-emerald-800">✅ {tossSuccess.floor}층 {tossSuccess.roomId}호 토스 완료!</p>
          <button onClick={() => setTossSuccess(null)} className="text-emerald-400 text-xs">닫기</button>
        </div>
      )}

      {/* ── North Star 배너 ── */}
      <NorthStarBanner todayCount={todayCount} />

      {/* ── 공실 현황 배너 ── */}
      <Link
        href="/status"
        className="mx-4 mt-3 rounded-2xl overflow-hidden border border-rb-100 shadow-sm block active:scale-[0.98] transition-transform"
      >
        <div className="bg-rb-600 px-4 py-2 flex items-center justify-between">
          <span className="text-white text-xs font-bold">🎵 연습실 공실 현황</span>
          {roomStatus ? (
            <span className="text-rb-200 text-xs">
              {roomStatus.available_count}개 공실 · {roomStatus.updated_at.slice(11, 16)} 갱신
            </span>
          ) : (
            <span className="text-rb-300 text-xs">연결 중...</span>
          )}
        </div>
        {roomStatus ? (
          <div className="bg-white px-4 py-3 flex items-center justify-between">
            <div className="flex gap-3">
              {[1, 2, 3, 4].map((floor) => {
                const rooms = roomStatus.rooms.filter((r) => r.floor === floor)
                if (rooms.length === 0) return null
                const avail = rooms.filter((r) => r.available_periods.length > 0).length
                return (
                  <div key={floor} className="flex flex-col items-center gap-0.5">
                    <span className={`text-base font-bold leading-none ${avail > 0 ? 'text-emerald-600' : 'text-rb-400'}`}>
                      {avail}
                    </span>
                    <span className="text-[10px] text-gray-400">{floor}층</span>
                  </div>
                )
              })}
            </div>
            <span className="text-rb-400 text-sm font-bold">자세히 →</span>
          </div>
        ) : (
          <div className="bg-white px-4 py-3">
            <p className="text-xs text-gray-400">API 서버 연결 후 표시됩니다</p>
          </div>
        )}
      </Link>

      {/* ── 층별 카드 ── */}
      <main className="flex-1 px-4 pt-4 space-y-3">
        {[1, 2, 3].map((floor) => {
          const status = floorStatus[floor]
          const cfg = statusConfig(status.avg)
          return (
            <div key={floor} className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-3 h-3 rounded-full ${cfg.dot} flex-shrink-0`} />
                    <span className="text-base font-bold text-gray-900">{floor}층 키오스크</span>
                  </div>
                  {status.lastAt ? (
                    <span className="text-xs text-gray-400">{timeAgo(status.lastAt, now)}</span>
                  ) : (
                    <span className="text-xs text-gray-300">보고 없음</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className={`text-lg font-bold ${cfg.text}`}>{cfg.label}</span>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${cfg.badge}`}>
                    {cfg.sub}
                  </span>
                </div>
                {/* 혼잡도 바 */}
                <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${cfg.bar} ${cfg.barWidth}`} />
                </div>
              </div>
            </div>
          )
        })}
      </main>

      {/* ── 조기 반납 목록 ── */}
      <EarlyReturnList />

      {/* ── 하단 버튼 ── */}
      <div className="px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-3">
        <div className="flex gap-2">
          <Link
            href="/report"
            className="flex-[3] flex items-center justify-center h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md active:scale-[0.98] transition-transform"
          >
            지금 대기 보고하기
          </Link>
          <button
            onClick={() => setShowTossSheet(true)}
            className="flex-1 flex flex-col items-center justify-center h-14 rounded-2xl bg-red-500 text-white text-xs font-bold active:scale-[0.98] transition-transform gap-0.5 shadow-md"
          >
            <span>🚨</span>
            <span>토스</span>
          </button>
        </div>
        <div className="flex gap-2">
          <Link
            href="/status"
            className="flex-1 flex items-center justify-between h-12 rounded-2xl bg-rb-50 border-2 border-rb-200 px-4 text-rb-700 text-sm font-bold active:scale-[0.98] transition-transform"
          >
            <span>🎵 공실 현황</span>
            <span className="text-rb-400 text-xs">→</span>
          </Link>
          <Link
            href="/facility-report"
            className="flex-1 flex items-center justify-between h-12 rounded-2xl bg-amber-50 border-2 border-amber-200 px-4 text-amber-700 text-sm font-bold active:scale-[0.98] transition-transform"
          >
            <span>📋 시설 신문고</span>
            <span className="text-amber-400 text-xs">→</span>
          </Link>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Link
            href="/alarm"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5"
          >
            <span>⏰</span>
            <span>태그 알림</span>
          </Link>
          <Link
            href="/early-return"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5"
          >
            <span>🚪</span>
            <span>조기 반납</span>
          </Link>
          <Link
            href="/transfer"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5"
          >
            <span>🔄</span>
            <span>양도·교환</span>
          </Link>
          <Link
            href="/rooms"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5"
          >
            <span>🎵</span>
            <span>방 비품</span>
          </Link>
        </div>
      </div>

      {showTossSheet && (
        <UrgentTossSheet
          user={user}
          onClose={() => setShowTossSheet(false)}
          onSuccess={(roomId, floor) => {
            setShowTossSheet(false)
            setTossSuccess({ roomId, floor })
          }}
        />
      )}

    </div>
  )
}
