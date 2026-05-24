'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { useUserProfile } from '@/hooks/useUserProfile'
import { NotificationBanner } from '@/components/NotificationBanner'
import { EarlyReturnList } from '@/components/EarlyReturnList'
import { UrgentTossSheet } from '@/components/UrgentTossSheet'
import { OnboardingModal } from '@/components/OnboardingModal'
import { TransferRequest, COLLECTIONS } from '@/types/collections'
import { useRoomStatus, Room } from '@/hooks/useRoomStatus'

// ── 연결 상태 배지 ────────────────────────────────────────
const CONN_BADGE: Record<string, string> = {
  live:       '● 실시간',
  polling:    '○ 갱신중',
  connecting: '○ 연결중',
  error:      '⚠ 오프라인',
}
const CONN_COLOR: Record<string, string> = {
  live:       'text-emerald-300',
  polling:    'text-yellow-300',
  connecting: 'text-rb-200',
  error:      'text-red-300',
}

// ── 운영 시간 판별 (07:00–22:00) ──────────────────────────
function isOperatingHours(now: Date = new Date()): boolean {
  const min = now.getHours() * 60 + now.getMinutes()
  return min >= 7 * 60 && min < 22 * 60
}

// ── corner → 동 ──────────────────────────────────────────
function buildingOf(cornerNo: number): 'A동' | 'B동' {
  return [1, 2, 3, 4].includes(cornerNo) ? 'A동' : 'B동'
}

// ── 방 번호 추출 ──────────────────────────────────────────
function roomNum(name: string) {
  return name.match(/(\d+)호/)?.[1] ?? '?'
}

// ── 구역 레이블 ───────────────────────────────────────────
function sectionLabel(rooms: Room[]) {
  const nums = rooms
    .map((r) => parseInt(roomNum(r.name)))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b)
  if (nums.length === 0) return '구역'
  return nums[0] === nums[nums.length - 1]
    ? `${nums[0]}호`
    : `${nums[0]}~${nums[nums.length - 1]}호`
}

// ── 방 칩 ────────────────────────────────────────────────
function RoomChip({ room, operating }: { room: Room; operating: boolean }) {
  const num     = roomNum(room.name)
  const isOrgan = room.name.includes('오르간')
  const period  = room.available_periods[0]

  // 운영외 시간이면 모두 회색
  if (!operating) {
    return (
      <div className="rounded-xl bg-gray-50 border-2 border-gray-100 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center opacity-40">
        <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
        <span className="text-xs font-bold text-gray-500 leading-none mt-0.5">{num}호</span>
        {isOrgan && <span className="text-[9px] text-gray-400 leading-none">오르간</span>}
        <span className="text-[10px] text-gray-400 leading-none">운영외</span>
      </div>
    )
  }

  if (room.occupied) {
    return (
      <div className="rounded-xl bg-rb-50 border-2 border-rb-200 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center">
        <div className="w-1.5 h-1.5 rounded-full bg-rb-400" />
        <span className="text-xs font-bold text-rb-800 leading-none mt-0.5">{num}호</span>
        {isOrgan && <span className="text-[9px] text-rb-400 leading-none">오르간</span>}
        <span className="text-[10px] text-rb-500 leading-none">
          {room.occupied_until ? `~${room.occupied_until}` : '사용중'}
        </span>
      </div>
    )
  }

  if (period) {
    return (
      <div className="rounded-xl bg-emerald-50 border-2 border-emerald-300 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-xs font-bold text-emerald-800 leading-none mt-0.5">{num}호</span>
        {isOrgan && <span className="text-[9px] text-emerald-400 leading-none">오르간</span>}
        <span className="text-[10px] text-emerald-700 leading-none">{period.start}~</span>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-gray-50 border-2 border-gray-100 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center opacity-40">
      <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
      <span className="text-xs font-bold text-gray-500 leading-none mt-0.5">{num}호</span>
      {isOrgan && <span className="text-[9px] text-gray-400 leading-none">오르간</span>}
      <span className="text-[10px] text-gray-400 leading-none">운영외</span>
    </div>
  )
}

const FLOORS = [1, 2, 3, 4]

export default function HomePage() {
  const { user } = useAnonymousAuth()
  const { profile, isNew, suggestedNickname, rerollNickname, saveProfile } = useUserProfile(user)
  const { status, connState, byFloor, refresh, refreshing } = useRoomStatus()

  const [activeFloor, setActiveFloor]   = useState(1)
  const [allUrgentItems, setAllUrgentItems] = useState<TransferRequest[]>([])
  const [urgentItems, setUrgentItems]   = useState<TransferRequest[]>([])
  const [showTossSheet, setShowTossSheet] = useState(false)
  const [tossSuccess, setTossSuccess]   = useState<{ roomId: string; floor: number } | null>(null)
  const [now, setNow] = useState(Date.now())

  // 1분마다 now 갱신 (긴급 토스 TTL 만료 트리거)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // 긴급 토스 실시간 구독
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

  // 10분 TTL 자동 만료
  useEffect(() => {
    setUrgentItems(allUrgentItems.filter((r) => r.createdAt.toMillis() > now - 10 * 60 * 1000))
  }, [allUrgentItems, now])

  const updatedAt  = status?.updated_at.slice(11, 16) ?? null
  const floorData  = byFloor[activeFloor] ?? {}
  const corners    = Object.keys(floorData).map(Number).sort((a, b) => a - b)
  const operating  = isOperatingHours(new Date(now))

  function floorAvailable(floor: number) {
    if (!operating) return 0
    return Object.values(byFloor[floor] ?? {})
      .flat()
      .filter((r) => r.available_periods.length > 0).length
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-4 sticky top-0 z-20">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-rb-200 text-xs font-semibold tracking-widest uppercase">Yonsei Music</p>
            <h1 className="text-white text-2xl font-bold mt-0.5">연습실 공실 현황</h1>
          </div>
          {/* 새로고침 + 연결 배지 */}
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={refresh}
              disabled={refreshing}
              className="w-7 h-7 rounded-full bg-rb-500 flex items-center justify-center active:scale-90 transition-transform disabled:opacity-50"
              aria-label="새로고침"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                className={`w-3.5 h-3.5 text-white ${refreshing ? 'animate-spin' : ''}`}>
                <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clipRule="evenodd" />
              </svg>
            </button>
            <span className={`text-xs font-semibold ${CONN_COLOR[connState]}`}>
              {CONN_BADGE[connState]}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <p className="text-rb-200 text-sm">
            키오스크 실시간 연동{updatedAt && <span> · {updatedAt} 갱신</span>}
          </p>
          {/* 프로필 칩 → 마이페이지 */}
          {profile && (
            <Link href="/mypage" className="text-[11px] text-rb-200 font-medium hover:text-white transition-colors active:opacity-70 flex items-center gap-1">
              {profile.nickname} · {profile.department} ›
            </Link>
          )}
        </div>

        {/* 요약 통계 */}
        {status && (
          operating ? (
            <div className="flex gap-2 mt-3">
              {[
                { label: '전체',   value: status.total,          color: 'bg-rb-700 text-rb-100' },
                { label: '사용중', value: status.occupied_count,  color: 'bg-rb-800 text-rb-200' },
                { label: '공실',   value: status.available_count, color: 'bg-emerald-600 text-emerald-50' },
              ].map(({ label, value, color }) => (
                <div key={label} className={`flex-1 rounded-xl ${color} py-1.5 text-center`}>
                  <p className="text-base font-bold leading-none">{value}</p>
                  <p className="text-[10px] mt-0.5 opacity-80">{label}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-rb-700 px-4 py-2 text-center">
              <p className="text-rb-200 text-xs font-medium">🌙 운영 시간 외 · 07:00 – 22:00 운영</p>
            </div>
          )
        )}
      </header>

      {/* ── 알림 배너 ── */}
      <NotificationBanner user={user} />

      {/* ── 긴급 토스 배너 ── */}
      {urgentItems.length > 0 && (
        <div className="mx-4 mt-3 rounded-2xl bg-red-50 border border-red-200 overflow-hidden">
          <div className="px-4 py-2 bg-red-500 flex items-center gap-2">
            <span className="text-white text-xs font-bold animate-pulse">🚨 긴급</span>
            <span className="text-red-100 text-xs">방금 올라온 방이 있어요</span>
          </div>
          {urgentItems.map((item) => (
            <Link key={item.id} href="/transfer"
              className="flex items-center justify-between px-4 py-3 border-t border-red-100 first:border-0 active:bg-red-100 transition-colors">
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

      {/* ── 층 탭 ── */}
      <div className="bg-white border-b border-gray-100 px-4 pt-3 pb-2 flex gap-2">
        {FLOORS.map((floor) => {
          const avail   = floorAvailable(floor)
          const hasData = Object.keys(byFloor[floor] ?? {}).length > 0
          if (!hasData && status) return null
          return (
            <button
              key={floor}
              onClick={() => setActiveFloor(floor)}
              className={`flex-1 relative rounded-full py-1.5 text-sm font-bold transition-all ${
                activeFloor === floor
                  ? 'bg-rb-600 text-white shadow-sm'
                  : 'bg-rb-50 text-rb-600'
              }`}
            >
              {floor}층
              {avail > 0 && (
                <span className={`
                  absolute -top-1 -right-1 min-w-[16px] h-4 px-1
                  rounded-full text-[9px] font-bold leading-4 text-center
                  ${activeFloor === floor ? 'bg-emerald-400 text-white' : 'bg-emerald-500 text-white'}
                `}>
                  {avail}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── 방 목록 ── */}
      <main className="flex-1 px-4 pt-4 space-y-5">

        {/* 로딩 */}
        {!status && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-rb-200 border-t-rb-600 animate-spin" />
            <p className="text-gray-400 text-sm">키오스크 서버 연결 중...</p>
          </div>
        )}

        {/* 구역별 방 그리드 */}
        {status && corners.map((cornerNo) => {
          const rooms     = floorData[cornerNo]
          if (!rooms?.length) return null
          const availCount = operating
            ? rooms.filter((r) => r.available_periods.length > 0).length
            : 0
          const building  = buildingOf(cornerNo)
          return (
            <section key={cornerNo}>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {activeFloor}층 · <span className="text-rb-500">{building}</span> · {sectionLabel(rooms)}
                </h2>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  !operating
                    ? 'bg-gray-100 text-gray-400'
                    : availCount > 0
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-gray-100 text-gray-500'
                }`}>
                  {!operating ? '운영외' : availCount > 0 ? `공실 ${availCount}개` : '모두 사용중'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {rooms.map((room) => (
                  <RoomChip key={room.name} room={room} operating={operating} />
                ))}
              </div>
            </section>
          )
        })}

        {status && corners.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <p className="text-3xl">🎵</p>
            <p className="text-gray-400 text-sm">{activeFloor}층 정보가 없어요</p>
          </div>
        )}

        {/* 범례 */}
        {status && (
          <div className="flex items-center justify-center gap-4 pt-2">
            {[
              { dot: 'bg-emerald-400', label: '공실' },
              { dot: 'bg-rb-400',      label: '사용중' },
              { dot: 'bg-gray-300',    label: '운영외' },
            ].map(({ dot, label }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                {label}
              </span>
            ))}
          </div>
        )}
      </main>

      {/* ── 조기 반납 목록 ── */}
      <EarlyReturnList />

      {/* ── 하단 버튼 ── */}
      <div className="px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-2.5">
        {/* 보조 기능 3개 + 토스 */}
        <div className="grid grid-cols-4 gap-2">
          <Link href="/alarm"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5">
            <span>⏰</span><span>태그 알림</span>
          </Link>
          <Link href="/early-return"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5">
            <span>🚪</span><span>조기 반납</span>
          </Link>
          <Link href="/transfer"
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-rb-50 border-2 border-rb-200 text-rb-700 text-xs font-bold active:scale-[0.98] transition-transform gap-0.5">
            <span>🔄</span><span>양도·교환</span>
          </Link>
          <button
            onClick={() => setShowTossSheet(true)}
            className="flex flex-col items-center justify-center h-14 rounded-2xl bg-red-500 text-white text-xs font-bold active:scale-[0.98] transition-transform gap-0.5 shadow-md"
          >
            <span>🚨</span><span>토스</span>
          </button>
        </div>
        {/* 대기 보고하기 — 풀너비 */}
        <Link
          href="/report"
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md active:scale-[0.98] transition-transform"
        >
          📣 대기 보고하기
        </Link>
        <Link href="/facility-report"
          className="flex items-center justify-between w-full h-11 rounded-2xl bg-amber-50 border-2 border-amber-200 px-4 text-amber-700 text-sm font-bold active:scale-[0.98] transition-transform">
          <span>📋 시설 신문고</span>
          <span className="text-amber-400 text-xs">→</span>
        </Link>
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

      {/* ── 온보딩 (신규 사용자) ── */}
      {isNew && suggestedNickname && (
        <OnboardingModal
          suggestedNickname={suggestedNickname}
          onReroll={rerollNickname}
          onSave={saveProfile}
        />
      )}

    </div>
  )
}
