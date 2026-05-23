'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRoomStatus, Room } from '@/hooks/useRoomStatus'

// ── 방 번호 추출 ──────────────────────────────────────────
function roomNum(name: string) {
  return name.match(/(\d+)호/)?.[1] ?? '?'
}

// ── 구역 레이블: 해당 코너의 최소~최대 방 번호 ─────────────
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

// ── 연결 상태 뱃지 ────────────────────────────────────────
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

// ── 방 칩 ────────────────────────────────────────────────
function RoomChip({ room }: { room: Room }) {
  const num    = roomNum(room.name)
  const isOrgan = room.name.includes('오르간')
  const period = room.available_periods[0]

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

  // 운영 외 / 데이터 없음
  return (
    <div className="rounded-xl bg-gray-50 border-2 border-gray-100 px-2 py-2.5 flex flex-col items-center gap-0.5 min-h-[64px] justify-center opacity-40">
      <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
      <span className="text-xs font-bold text-gray-500 leading-none mt-0.5">{num}호</span>
      {isOrgan && <span className="text-[9px] text-gray-400 leading-none">오르간</span>}
      <span className="text-[10px] text-gray-400 leading-none">운영외</span>
    </div>
  )
}

// ── 메인 페이지 ───────────────────────────────────────────
const FLOORS = [1, 2, 3, 4]

export default function StatusPage() {
  const { status, connState, byFloor, refresh, refreshing } = useRoomStatus()
  const [activeFloor, setActiveFloor] = useState(1)

  const updatedAt = status
    ? status.updated_at.slice(11, 16)   // "HH:MM"
    : null

  // 선택 층의 코너별 방 목록 (코너 번호 오름차순)
  const floorData = byFloor[activeFloor] ?? {}
  const corners   = Object.keys(floorData)
    .map(Number)
    .sort((a, b) => a - b)

  // 층별 공실 수 (탭 뱃지용)
  function floorAvailable(floor: number) {
    const sections = byFloor[floor] ?? {}
    return Object.values(sections)
      .flat()
      .filter((r) => r.available_periods.length > 0).length
  }

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ───────────────────────────────────────── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-4 sticky top-0 z-20">
        <Link href="/" className="text-rb-200 text-xs font-semibold">← 홈</Link>
        <div className="flex items-end justify-between mt-0.5">
          <h1 className="text-xl font-bold text-white">연습실 공실 현황</h1>
          <div className="flex items-center gap-2">
            {/* 새로고침 버튼 */}
            <button
              onClick={refresh}
              disabled={refreshing}
              className="w-7 h-7 rounded-full bg-rb-500 flex items-center justify-center active:scale-90 transition-transform disabled:opacity-50"
              aria-label="새로고침"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-3.5 h-3.5 text-white ${refreshing ? 'animate-spin' : ''}`}
              >
                <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clipRule="evenodd" />
              </svg>
            </button>
            <span className={`text-xs font-semibold ${CONN_COLOR[connState]}`}>
              {CONN_BADGE[connState]}
            </span>
          </div>
        </div>
        <p className="text-rb-200 text-xs mt-0.5">
          키오스크 실시간 연동
          {updatedAt && <span> · {updatedAt} 갱신</span>}
        </p>

        {/* ── 요약 통계 ── */}
        {status && (
          <div className="flex gap-2 mt-3">
            {[
              { label: '전체',   value: status.total,          color: 'bg-rb-700 text-rb-100'  },
              { label: '사용중', value: status.occupied_count,  color: 'bg-rb-800 text-rb-200'  },
              { label: '공실',   value: status.available_count, color: 'bg-emerald-600 text-emerald-50' },
            ].map(({ label, value, color }) => (
              <div key={label} className={`flex-1 rounded-xl ${color} py-1.5 text-center`}>
                <p className="text-base font-bold leading-none">{value}</p>
                <p className="text-[10px] mt-0.5 opacity-80">{label}</p>
              </div>
            ))}
          </div>
        )}
      </header>

      {/* ── 층 탭 ─────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100 sticky top-0 z-10">
        {/* sticky top-0 는 헤더 아래 붙도록 mt 계산 없이 자연스럽게 */}
        <div className="flex px-4 pt-3 pb-2 gap-2">
          {FLOORS.map((floor) => {
            const avail = floorAvailable(floor)
            const hasData = Object.keys(byFloor[floor] ?? {}).length > 0
            if (!hasData) return null
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
      </div>

      {/* ── 방 목록 ───────────────────────────────────── */}
      <main className="flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-5">

        {/* 로딩 */}
        {!status && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-rb-200 border-t-rb-600 animate-spin" />
            <p className="text-gray-400 text-sm">키오스크 서버 연결 중...</p>
          </div>
        )}

        {/* 구역별 방 그리드 */}
        {status && corners.map((cornerNo) => {
          const rooms = floorData[cornerNo]
          if (!rooms?.length) return null

          const availCount = rooms.filter((r) => r.available_periods.length > 0).length

          return (
            <section key={cornerNo}>
              {/* 구역 헤더 */}
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {activeFloor}층 · {sectionLabel(rooms)}
                </h2>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  availCount > 0
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-gray-100 text-gray-500'
                }`}>
                  {availCount > 0 ? `공실 ${availCount}개` : '모두 사용중'}
                </span>
              </div>

              {/* 4열 그리드 */}
              <div className="grid grid-cols-4 gap-2">
                {rooms.map((room) => (
                  <RoomChip key={room.name} room={room} />
                ))}
              </div>
            </section>
          )
        })}

        {/* 선택 층에 방 없음 (예외 처리) */}
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
    </div>
  )
}
