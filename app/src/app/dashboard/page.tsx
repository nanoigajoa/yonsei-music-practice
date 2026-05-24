'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { DashboardData, RoomStatusItem } from '@/app/api/dashboard/route'

function pad(n: number) { return n.toString().padStart(2, '0') }
function toHHMM(ms: number) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function formatRemaining(ms: number) {
  if (ms <= 0) return '곧 반납'
  const m = Math.ceil(ms / 60000)
  if (m < 60) return `${m}분 후`
  return `${Math.floor(m / 60)}시간 ${m % 60}분 후`
}

function urgencyConfig(remainingMs: number) {
  if (remainingMs <= 0)         return { dot: 'bg-gray-300', badge: 'bg-gray-100 text-gray-500', text: '반납 예정' }
  if (remainingMs <= 10 * 60000) return { dot: 'bg-emerald-400', badge: 'bg-emerald-50 text-emerald-700', text: '곧 빌 예정' }
  if (remainingMs <= 30 * 60000) return { dot: 'bg-yellow-400',  badge: 'bg-yellow-50 text-yellow-700',  text: '30분 내 반납' }
  return                               { dot: 'bg-red-400',       badge: 'bg-red-50 text-red-600',        text: '사용 중' }
}

// ── 방 번호 → 동 판별 ──────────────────────────────────────
// A동: corner 1,2,3,4 (107~114, 205~209, 302~307, 406~411)
// B동: corner 6,8,9   (119~126, 310~317, 416~421)
function buildingByRoom(hint: string | null): 'A동' | 'B동' | null {
  if (!hint) return null
  const n = parseInt(hint.replace(/\D/g, ''))
  if (isNaN(n)) return null
  const floor = Math.floor(n / 100)
  const last  = n % 100
  if (floor === 1) return last <= 18 ? 'A동' : 'B동'
  if (floor === 2) return 'A동'
  if (floor === 3) return last <= 9  ? 'A동' : 'B동'
  if (floor === 4) return last <= 15 ? 'A동' : 'B동'
  return null
}

function RoomCard({ item, now }: { item: RoomStatusItem; now: number }) {
  const remaining = item.endTime ? item.endTime - now : 0
  const cfg      = urgencyConfig(remaining)
  const building = buildingByRoom(item.roomHint)
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 bg-white rounded-2xl border border-gray-100 shadow-sm">
      <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
      <div className="w-12 h-12 rounded-xl bg-rb-50 flex items-center justify-center flex-shrink-0">
        <span className="text-rb-700 font-bold text-sm">{item.roomHint}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {item.floor && <span className="text-xs text-gray-400">{item.floor}층</span>}
          {building && (
            <span className="text-[10px] font-bold text-rb-500 bg-rb-50 px-1.5 py-0.5 rounded-full">{building}</span>
          )}
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.badge}`}>{cfg.text}</span>
        </div>
        <p className="text-sm font-bold text-gray-900 mt-0.5">
          {item.endTime ? `${toHHMM(item.endTime)}까지` : '종료시각 미설정'}
        </p>
      </div>
      <span className="text-xs font-semibold text-gray-400 flex-shrink-0">
        {item.endTime ? formatRemaining(remaining) : '—'}
      </span>
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard')
      if (!res.ok) return
      const json: DashboardData = await res.json()
      setData(json)
      setLastUpdated(Date.now())
    } catch {
      // 실패 시 기존 데이터 유지
    } finally {
      setLoading(false)
    }
  }, [])

  // 최초 로드 + 1분마다 폴링
  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 60 * 1000)
    return () => clearInterval(id)
  }, [fetchData])

  // 매초 now 갱신 → 남은 시간 카운트다운
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const soonFree  = data?.occupied.filter(r => r.remainingMs > 0 && r.remainingMs <= 30 * 60000) ?? []
  const inUse     = data?.occupied.filter(r => r.remainingMs > 30 * 60000) ?? []
  const totalActive = (data?.occupied.length ?? 0) + (data?.unknownCount ?? 0)

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <Link href="/" className="text-rb-200 text-xs font-semibold">← 홈</Link>
        <h1 className="text-xl font-bold text-white mt-0.5">연습실 현황</h1>
        <p className="text-rb-200 text-xs mt-0.5">
          알림 등록 기반 · {lastUpdated ? `${Math.floor((Date.now() - lastUpdated) / 1000)}초 전 갱신` : '갱신 중...'}
        </p>
      </header>

      <main className="flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-5">

        {/* 통계 요약 */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: '현재 사용 중', value: loading ? '—' : `${totalActive}명` },
            { label: '방 번호 확인', value: loading ? '—' : `${data?.occupied.length ?? 0}개` },
            { label: '오늘 등록',    value: loading ? '—' : `${data?.todayTotal ?? 0}명` },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-2xl bg-rb-50 border border-rb-100 px-3 py-3 text-center">
              <p className="text-xl font-bold text-rb-700">{value}</p>
              <p className="text-xs text-rb-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <p className="text-gray-400 text-sm">불러오는 중...</p>
          </div>
        ) : (
          <>
            {/* 곧 빌 예정 (30분 내) */}
            {soonFree.length > 0 && (
              <section>
                <p className="text-xs font-bold text-yellow-600 uppercase tracking-wider mb-2">⏳ 30분 내 반납 예정</p>
                <div className="space-y-2">
                  {soonFree.map((item) => (
                    <RoomCard key={item.roomHint} item={item} now={now} />
                  ))}
                </div>
              </section>
            )}

            {/* 사용 중 */}
            {inUse.length > 0 && (
              <section>
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">🔴 사용 중</p>
                <div className="space-y-2">
                  {inUse.map((item) => (
                    <RoomCard key={item.roomHint} item={item} now={now} />
                  ))}
                </div>
              </section>
            )}

            {/* 방 번호 미입력 */}
            {(data?.unknownCount ?? 0) > 0 && (
              <div className="rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3">
                <p className="text-sm font-semibold text-gray-700">
                  방 번호 미입력 {data!.unknownCount}명 추가 사용 중
                </p>
                <p className="text-xs text-gray-400 mt-0.5">알림 등록 시 방 번호를 입력하면 여기 표시돼요</p>
              </div>
            )}

            {/* 데이터 없음 */}
            {totalActive === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <p className="text-4xl">🎵</p>
                <p className="text-gray-500 font-medium">현재 알림 등록된 사용자가 없어요</p>
                <p className="text-xs text-gray-400 text-center">
                  키오스크 예약 후 태그 알림을 등록하면<br />여기서 사용 현황을 확인할 수 있어요
                </p>
              </div>
            )}

            <p className="text-center text-xs text-gray-300 pt-2">
              알림 등록한 사용자만 집계 · 실제 사용 현황과 다를 수 있어요
            </p>
          </>
        )}
      </main>
    </div>
  )
}
