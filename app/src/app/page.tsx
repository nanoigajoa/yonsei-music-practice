'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { useUserProfile } from '@/hooks/useUserProfile'
import { AppMenu } from '@/components/AppMenu'
import { auth } from '@/lib/firebase'
import { COMMUNITY_API } from '@/lib/community'
import { watchKey } from '@/lib/community'
import { OnboardingModal } from '@/components/OnboardingModal'
import { useRoomStatus, Room } from '@/hooks/useRoomStatus'
import { BookingSheet } from '@/components/BookingSheet'
import { ActiveBooking, getActiveBooking, clearActiveBooking, saveActiveBooking, getStudentId } from '@/lib/localBooking'
import { isCurrentlyAvailable, isEndingSoon, isOperatingHours } from '@/lib/roomAvailability'

// ── 연결 상태 배지 ────────────────────────────────────────
const CONN_BADGE: Record<string, string> = {
  live:       '● 실시간',
  polling:    '○ 갱신중',
  connecting: '○ 연결중',
  error:      '⚠ 오프라인',
}
const CONN_COLOR: Record<string, string> = {
  live:       'text-white',
  polling:    'text-white',
  connecting: 'text-white',
  error:      'text-white',
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

function bookingTime(value?: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function bookingPeriod(booking: ActiveBooking) {
  const start = bookingTime(booking.startAt)
  const end = bookingTime(booking.endAt)
  return start && end ? `${start}–${end}` : null
}

// ── 방 칩 ────────────────────────────────────────────────
function RoomChip({ room, now, onReserve }: { room: Room; now: number | null; onReserve: (room: Room) => void }) {
  const num     = roomNum(room.name)
  const isOrgan = room.name.includes('오르간')
  const period  = room.available_periods[0]

  if (room.occupied) {
    const endingSoon = isEndingSoon(room, now)
    const pendingTag = room.reservation_state === 'pending_tag'
    return (
      <button onClick={() => onReserve(room)}
        className={`w-full rounded-xl px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center active:scale-95 transition-transform ${endingSoon ? 'bg-rose-100 border-2 border-rose-500' : pendingTag ? 'bg-amber-50 border-2 border-amber-300' : 'bg-rb-50 border-2 border-rb-200'}`}>
        <div className={`w-1.5 h-1.5 rounded-full ${endingSoon ? 'bg-rose-600' : pendingTag ? 'bg-amber-400' : 'bg-rb-400'}`} />
        <span className={`text-xs font-bold leading-none mt-0.5 ${endingSoon ? 'text-rose-900' : pendingTag ? 'text-amber-800' : 'text-rb-800'}`}>{num}호</span>
        {isOrgan && <span className={`text-[9px] ${endingSoon ? 'text-rose-700' : pendingTag ? 'text-amber-600' : 'text-rb-400'} leading-none`}>오르간</span>}
        <span className={`text-[10px] leading-none ${endingSoon ? 'text-rose-900' : pendingTag ? 'text-amber-700' : 'text-rb-700'}`}>
          {pendingTag ? '인증대기' : endingSoon
            ? `${room.occupied_until} 종료`
            : room.occupied_until ? `사용중 ~${room.occupied_until}` : '사용중'}
        </span>
      </button>
    )
  }

  if (period) {
    return (
      <button onClick={() => onReserve(room)}
        className="w-full rounded-xl bg-emerald-50 border-2 border-emerald-300 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center active:scale-95 transition-transform">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-xs font-bold text-emerald-800 leading-none mt-0.5">{num}호</span>
        {isOrgan && <span className="text-[9px] text-emerald-700 leading-none">오르간</span>}
        <span className="text-[10px] text-emerald-700 leading-none">{period.start}~</span>
      </button>
    )
  }

  // 학교 키오스크에서 직접 예약한 뒤 학생증 태그 전에는 현재 슬롯이
  // 공실도 사용중도 아닌 상태로 내려온다. 앱 예약의 노란 인증대기와
  // 구분할 수 있도록 흰색 인증대기로 표시한다.
  const kioskPendingTag = isOperatingHours(now)
  return (
    <button onClick={() => onReserve(room)}
      className={`w-full rounded-xl border-2 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center active:scale-95 transition-transform ${kioskPendingTag ? 'bg-white border-gray-300' : 'bg-gray-50 border-gray-200'}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${kioskPendingTag ? 'bg-white border border-gray-400' : 'bg-gray-300'}`} />
      <span className={`text-xs font-bold leading-none mt-0.5 ${kioskPendingTag ? 'text-gray-800' : 'text-gray-700'}`}>{num}호</span>
      {isOrgan && <span className="text-[9px] leading-none text-gray-500">오르간</span>}
      {kioskPendingTag && <span className="text-[10px] text-gray-700 leading-none">인증대기</span>}
    </button>
  )
}

const FLOORS = [1, 2, 3, 4]

export default function HomePage() {
  const { user } = useAnonymousAuth()
  const { profile, isNew, suggestedNickname, rerollNickname, saveProfile } = useUserProfile(user)
  const { status, connState, byFloor, refresh, refreshing } = useRoomStatus()
  const openedNotification = useRef<string | null>(null)

  const [activeFloor, setActiveFloor]   = useState(1)
  const [now, setNow] = useState<number | null>(null)
  const [bookingRoom, setBookingRoom] = useState<Room | null>(null)
  const [activeBooking, setActiveBooking] = useState<ActiveBooking | null>(null)
  const [showAvailableOnly, setShowAvailableOnly] = useState(false)

  // 현재 시각 표시 갱신
  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0)
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearTimeout(initial); clearInterval(id) }
  }, [])

  useEffect(() => {
    const id = setTimeout(() => setActiveBooking(getActiveBooking()), 0)
    return () => clearTimeout(id)
  }, [])

  // Reconcile automatic returns without letting an old response erase a newer booking.
  useEffect(() => {
    if (!user || bookingRoom) return
    let alive = true
    let busy = false
    const sync = async () => {
      if (busy || document.visibilityState !== 'visible') return
      const before = getActiveBooking()
      setActiveBooking(before)
      if (!before || !getStudentId()) return
      busy = true
      try {
        const token = await user.getIdToken()
        const response = await fetch(`${COMMUNITY_API}/booking/current`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_id: getStudentId() }), signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) return
        const data = await response.json()
        if (!alive || auth.currentUser?.uid !== user.uid || getActiveBooking()?.returnToken !== before.returnToken) return
        if (data.success && data.found === false) {
          if (clearActiveBooking(before.returnToken)) setActiveBooking(null)
        } else if (data.success && data.found && data.return_token && data.reservation
          && data.corner_no === before.room.corner_no
          && data.room_no === roomNum(before.room.name)
          && (!before.reservationId || data.reservation.id === before.reservationId)) {
          const next: ActiveBooking = { ...before, reservationId: data.reservation.id,
            returnToken: data.return_token, step: data.reservation.status === 'active' ? 'active' : 'tag',
            startAt: data.reservation.start_at, endAt: data.reservation.end_at, tagDeadline: data.reservation.tag_deadline }
          saveActiveBooking(next)
          setActiveBooking(next)
        }
      } catch { /* Preserve the booking on an uncertain network response. */ }
      finally { busy = false }
    }
    const initial = setTimeout(() => { void sync() }, 0)
    const interval = setInterval(() => { void sync() }, 15000)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('storage', sync)
    return () => { alive = false; clearTimeout(initial); clearInterval(interval); document.removeEventListener('visibilitychange', sync); window.removeEventListener('storage', sync) }
  }, [user, bookingRoom])

  const updatedAt = status?.updated_at
    ? (() => {
        const s = status.updated_at
        const iso = s.endsWith('Z') || s.includes('+') ? s : s + 'Z'
        return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
      })()
    : null
  const floorData   = byFloor[activeFloor] ?? {}
  const corners     = Object.keys(floorData).map(Number).sort((a, b) => a - b)

  useEffect(() => {
    if (!status) return
    const key = new URLSearchParams(window.location.search).get('room')
    if (!key || openedNotification.current === key) return
    const room = status.rooms.find(r => watchKey(r) === key)
    if (!room) return
    openedNotification.current = key
    const timer = setTimeout(() => { setActiveFloor(room.floor); setShowAvailableOnly(false) }, 0)
    return () => clearTimeout(timer)
  }, [status])

  function openBooking(room: Room) {
    if (activeBooking && (activeBooking.room.name !== room.name || activeBooking.room.corner_no !== room.corner_no)) {
      setBookingRoom(activeBooking.room)
      return
    }
    setBookingRoom(room)
  }

  // rooms 배열 기준 재계산 (인증대기 방이 집계에서 빠지는 문제 방지)
  const totalCount    = status?.rooms.length ?? 0
  const availableCount = status?.rooms.filter(isCurrentlyAvailable).length ?? 0
  const occupiedCount  = status?.rooms.filter(r => r.occupied).length ?? 0

  function floorAvailable(floor: number) {
    return Object.values(byFloor[floor] ?? {})
      .flat()
      .filter(isCurrentlyAvailable).length
  }

  const availableGroups = Object.entries(byFloor)
    .sort(([floorA], [floorB]) => Number(floorA) - Number(floorB))
    .flatMap(([floor, floorCorners]) =>
      Object.entries(floorCorners)
        .sort(([cornerA], [cornerB]) => Number(cornerA) - Number(cornerB))
        .map(([corner, rooms]) => ({
          floor: Number(floor),
          cornerNo: Number(corner),
          rooms: rooms.filter(isCurrentlyAvailable),
        }))
        .filter((group) => group.rooms.length > 0),
    )

  const availableOnlyActive = showAvailableOnly

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-4 sticky top-0 z-20">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white text-xs font-semibold tracking-widest uppercase">Yonsei Music</p>
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
            <AppMenu />
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <p className="text-white text-sm">
            키오스크 실시간 연동{updatedAt && <span> · {updatedAt} 갱신</span>}
          </p>
          {/* 프로필 칩 → 마이페이지 */}
          {profile && (
            <Link href="/mypage" className="text-[11px] text-white font-medium transition-colors active:opacity-70 flex items-center gap-1">
              {profile.nickname} · {profile.department} ›
            </Link>
          )}
        </div>

        {/* 요약 통계 */}
        {status && (
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => setShowAvailableOnly(false)}
                aria-pressed={!availableOnlyActive}
                className={`flex-1 rounded-xl bg-rb-700 py-1.5 text-center text-rb-100 active:scale-95 transition-all ${
                  !availableOnlyActive ? 'ring-2 ring-white ring-offset-2 ring-offset-rb-600' : ''
                }`}
              >
                <p className="text-base font-bold leading-none">{totalCount}</p>
                <p className="text-[10px] mt-0.5">전체 보기</p>
              </button>
              <div className="flex-1 rounded-xl bg-rb-800 text-rb-200 py-1.5 text-center">
                <p className="text-base font-bold leading-none">{occupiedCount}</p>
                <p className="text-[10px] mt-0.5">사용중</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAvailableOnly(true)}
                aria-pressed={availableOnlyActive}
                aria-label={`현재 공실 ${availableCount}개만 보기`}
                className={`flex-1 rounded-xl bg-emerald-700 py-1.5 text-center text-white active:scale-95 transition-all ${
                  availableOnlyActive ? 'ring-2 ring-white ring-offset-2 ring-offset-rb-600' : ''
                }`}
              >
                <p className="text-base font-bold leading-none">{availableCount}</p>
                <p className="text-[10px] mt-0.5">공실만 보기</p>
              </button>
            </div>
        )}
      </header>

      {/* ── 층 탭 ── */}
      {availableOnlyActive ? (
        <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-3 text-center">
          <p className="text-sm font-bold text-emerald-800">현재 공실 {availableCount}개만 표시 중</p>
        </div>
      ) : (
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
      )}

      {/* ── 방 목록 ── */}
      <main className="flex-1 px-4 pt-4 space-y-5">

        {/* 로딩 */}
        {!status && connState !== 'error' && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-rb-200 border-t-rb-600 animate-spin" />
            <p className="text-gray-600 text-sm">키오스크 서버 연결 중...</p>
          </div>
        )}

        {!status && connState === 'error' && (
          <div role="alert" className="flex flex-col items-center justify-center py-14 gap-3 text-center">
            <p className="text-3xl">📡</p>
            <div>
              <p className="font-bold text-gray-800">현황 서버에 연결할 수 없어요</p>
              <p className="mt-1 text-sm text-gray-600">인터넷 연결을 확인하고 다시 시도해 주세요.</p>
            </div>
            <button onClick={refresh} disabled={refreshing}
              className="mt-1 h-11 rounded-xl bg-rb-600 px-5 text-sm font-bold text-white disabled:opacity-50">
              {refreshing ? '다시 연결 중...' : '다시 시도'}
            </button>
          </div>
        )}

        {/* 구역별 방 그리드 */}
        {status && !availableOnlyActive && corners.map((cornerNo) => {
          const rooms     = floorData[cornerNo]
          if (!rooms?.length) return null
          const availCount = rooms.filter(isCurrentlyAvailable).length
          const building  = buildingOf(cornerNo)
          return (
            <section key={cornerNo}>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {activeFloor}층 · <span className="text-rb-700">{building}</span> · {sectionLabel(rooms)}
                </h2>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  availCount > 0
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-gray-100 text-gray-700'
                }`}>
                  {availCount > 0 ? `공실 ${availCount}개` : '공실 없음'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {rooms.map(room => <RoomChip key={watchKey(room)} room={room} now={now} onReserve={openBooking} />)}
              </div>
            </section>
          )
        })}

        {status && availableOnlyActive && availableGroups.map(({ floor, cornerNo, rooms }) => (
          <section key={`${floor}-${cornerNo}`}>
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                {floor}층 · <span className="text-rb-700">{buildingOf(cornerNo)}</span> · {sectionLabel(rooms)}
              </h2>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                공실 {rooms.length}개
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {rooms.map(room => <RoomChip key={watchKey(room)} room={room} now={now} onReserve={openBooking} />)}
            </div>
          </section>
        ))}

        {status && availableOnlyActive && availableGroups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <p className="text-3xl">🎵</p>
            <div>
              <p className="font-bold text-gray-800">현재 바로 예약 가능한 공실이 없어요</p>
              <p className="mt-1 text-sm text-gray-600">현황이 바뀌면 실시간으로 표시됩니다.</p>
            </div>
            <button type="button" onClick={() => setShowAvailableOnly(false)}
              className="h-11 rounded-xl bg-rb-600 px-5 text-sm font-bold text-white">
              전체 방 보기
            </button>
          </div>
        )}

        {status && !availableOnlyActive && corners.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <p className="text-3xl">🎵</p>
            <p className="text-gray-600 text-sm">{activeFloor}층 정보가 없어요</p>
          </div>
        )}

        {/* 범례 */}
        {status && (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-2">
            {[
              { dot: 'bg-emerald-400', label: '공실' },
              { dot: 'bg-amber-400',   label: '앱 인증대기' },
              { dot: 'bg-white border border-gray-400', label: '키오스크 인증대기' },
              { dot: 'bg-rb-400',      label: '사용중' },
              { dot: 'bg-rose-600',    label: '두칸남음' },
            ].map(({ dot, label }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-gray-700">
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                {label}
              </span>
            ))}
          </div>
        )}
      </main>

      {/* ── 하단 버튼 ── */}
      <div className={`px-4 pt-5 space-y-2.5 ${
        activeBooking
          ? 'pb-[calc(env(safe-area-inset-bottom)+104px)]'
          : 'pb-[calc(env(safe-area-inset-bottom)+24px)]'
      }`}>
        <div className="flex items-center justify-center w-full h-[88px] rounded-2xl bg-rb-600 text-white shadow-md">
          <time dateTime={now ? new Date(now).toISOString() : undefined}
            className="font-mono text-4xl font-bold tabular-nums tracking-wider" aria-label="현재 시각">
            {now ? new Date(now).toLocaleTimeString('ko-KR', {
              hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }) : '--:--:--'}
          </time>
        </div>
        <Link href="/lounge"
          className="flex items-center justify-between w-full h-11 rounded-2xl bg-rb-50 border-2 border-rb-200 px-4 text-rb-700 text-sm font-bold active:scale-[0.98] transition-transform">
          <span>음대 라운지</span>
          <span className="text-xs">익명 채팅 ›</span>
        </Link>
        <p className="text-center text-[11px] text-gray-600 pt-1">
          <Link href="/privacy" className="underline underline-offset-2 hover:text-gray-400 transition-colors">
            개인정보처리방침
          </Link>
        </p>
      </div>

      {activeBooking && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pointer-events-none">
          <button
            type="button"
            onClick={() => setBookingRoom(activeBooking.room)}
            aria-label={`${roomNum(activeBooking.room.name)}호 ${activeBooking.step === 'tag' ? '인증대기 예약' : '사용 중인 예약'} 열기`}
            className={`pointer-events-auto mx-auto flex w-full max-w-md items-center gap-3 rounded-2xl border px-3.5 py-3 text-left shadow-[0_8px_30px_rgba(15,23,42,0.22)] active:scale-[0.98] transition-transform ${
              activeBooking.step === 'tag'
                ? 'border-amber-300 bg-amber-50'
                : 'border-rb-300 bg-rb-600'
            }`}
          >
            <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold ${
              activeBooking.step === 'tag' ? 'bg-amber-200 text-amber-900' : 'bg-white/15 text-white'
            }`}>
              {activeBooking.step === 'tag' ? '인증대기' : '사용 중'}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-bold ${activeBooking.step === 'tag' ? 'text-amber-950' : 'text-white'}`}>
                {roomNum(activeBooking.room.name)}호
                {bookingPeriod(activeBooking) && <span className="ml-2 font-semibold">{bookingPeriod(activeBooking)}</span>}
              </span>
              <span className={`block truncate text-xs mt-0.5 ${activeBooking.step === 'tag' ? 'text-amber-800' : 'text-rb-100'}`}>
                {activeBooking.step === 'tag' ? '현장 단말기에 학생증을 태그하세요' : '예약 상세 · 반납'}
              </span>
            </span>
            <span className={`shrink-0 text-sm font-bold ${activeBooking.step === 'tag' ? 'text-amber-900' : 'text-white'}`}>
              열기 ›
            </span>
          </button>
        </div>
      )}

      {bookingRoom && (
        <BookingSheet
          room={bookingRoom}
          resumedBooking={
            activeBooking?.room.name === bookingRoom.name
            && activeBooking.room.corner_no === bookingRoom.corner_no
              ? activeBooking : null
          }
          onClose={() => setBookingRoom(null)}
          onChanged={refresh}
          onSessionChange={() => setActiveBooking(getActiveBooking())}
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
