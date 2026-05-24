'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { CongestionReport, COLLECTIONS } from '@/types/collections'

const QUEUE_OPTIONS = [
  { label: '없음',      sub: '대기 없어요',   value: 0,  icon: '🟢' },
  { label: '1–2명',    sub: '잠깐 기다려요', value: 1,  icon: '🟡' },
  { label: '3–5명',    sub: '조금 붐벼요',   value: 3,  icon: '🟠' },
  { label: '6–10명',   sub: '많이 기다려요', value: 6,  icon: '🔴' },
  { label: '10명 이상', sub: '매우 혼잡해요', value: 11, icon: '🔴' },
]

type Status = 'idle' | 'loading' | 'done' | 'error'

// ── 대기 추정 로직 ────────────────────────────────────────
// TTL: 20분
// 비대칭 감쇠: 없음(0) → 5분 반감기 / 대기있음 → 12분 반감기
// 단일 보고:  반감기 추가 30% 단축 + "추정" 뱃지
const TTL_MS        = 20 * 60 * 1000
const HALF_LIFE_NONE = 5  * 60 * 1000   // queueCount === 0
const HALF_LIFE_BUSY = 12 * 60 * 1000   // queueCount  >  0
const SINGLE_FACTOR  = 0.7              // 1명 보고 시 반감기 × 0.7

function computeFloorStatus(reports: CongestionReport[], nowMs: number): FloorStatus {
  const recent = reports.filter((r) => nowMs - r.createdAt.toMillis() < TTL_MS)
  if (recent.length === 0) return { avg: null, reportCount: 0, lastAt: null, isEstimate: false }

  const isEstimate = recent.length === 1
  let wSum = 0, wTotal = 0

  for (const r of recent) {
    const age = nowMs - r.createdAt.toMillis()
    let halfLife = r.queueCount === 0 ? HALF_LIFE_NONE : HALF_LIFE_BUSY
    if (isEstimate) halfLife *= SINGLE_FACTOR
    const w = Math.pow(0.5, age / halfLife)
    wSum += r.queueCount * w
    wTotal += w
  }

  const sorted = [...recent].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
  return {
    avg:         wTotal > 0 ? wSum / wTotal : 0,
    reportCount: recent.length,
    lastAt:      sorted[0].createdAt.toDate(),
    isEstimate,
  }
}

function statusConfig(avg: number | null) {
  if (avg === null) return {
    label: '정보 없음', sub: '아직 보고가 없어요',
    dot: 'bg-gray-300', text: 'text-gray-500',
    badge: 'bg-gray-100 text-gray-500', bar: 'bg-gray-200', barWidth: 'w-0',
  }
  if (avg === 0) return {
    label: '한산해요', sub: '대기 없음',
    dot: 'bg-emerald-400', text: 'text-emerald-700',
    badge: 'bg-emerald-50 text-emerald-700', bar: 'bg-emerald-400', barWidth: 'w-1/12',
  }
  if (avg <= 2) return {
    label: `약 ${Math.round(avg)}명 대기`, sub: '잠깐 기다려요',
    dot: 'bg-yellow-400', text: 'text-yellow-700',
    badge: 'bg-yellow-50 text-yellow-700', bar: 'bg-yellow-400', barWidth: 'w-3/12',
  }
  if (avg <= 5) return {
    label: `약 ${Math.round(avg)}명 대기`, sub: '조금 붐벼요',
    dot: 'bg-orange-400', text: 'text-orange-700',
    badge: 'bg-orange-50 text-orange-700', bar: 'bg-orange-400', barWidth: 'w-6/12',
  }
  return {
    label: `약 ${Math.round(avg)}명 대기`, sub: '매우 혼잡해요',
    dot: 'bg-red-500', text: 'text-red-700',
    badge: 'bg-red-50 text-red-700', bar: 'bg-red-500', barWidth: 'w-10/12',
  }
}

function timeAgo(date: Date, nowMs: number) {
  const mins = Math.floor((nowMs - date.getTime()) / 60000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  return `${Math.floor(mins / 60)}시간 전`
}

interface FloorStatus {
  avg:         number | null
  reportCount: number
  lastAt:      Date | null
  isEstimate:  boolean
}

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export default function ReportPage() {
  const { user } = useAnonymousAuth()
  const router = useRouter()

  const [floor, setFloor]           = useState<1 | 2 | 3 | null>(null)
  const [queueValue, setQueueValue] = useState<number | null>(null)
  const [status, setStatus]         = useState<Status>('idle')
  const [errMsg, setErrMsg]         = useState('')
  const [now, setNow]               = useState(Date.now())
  const [reports, setReports]       = useState<CongestionReport[]>([])
  const [floorStatus, setFloorStatus] = useState<Record<number, FloorStatus>>({
    1: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
    2: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
    3: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
  })

  // 1분마다 now 갱신
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // 오늘 보고 실시간 구독
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

  // 층별 대기 현황 재계산 (reports 또는 now 변경 시)
  useEffect(() => {
    const next: Record<number, FloorStatus> = {
      1: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
      2: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
      3: { avg: null, reportCount: 0, lastAt: null, isEstimate: false },
    }
    ;[1, 2, 3].forEach((f) => {
      next[f] = computeFloorStatus(reports.filter((r) => r.floor === f), now)
    })
    setFloorStatus(next)
  }, [reports, now])

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
          <h1 className="text-xl font-bold text-white">키오스크 대기 현황</h1>
          <p className="text-rb-200 text-xs mt-0.5">최근 20분 보고 기준 · 크라우드소싱</p>
        </div>
      </header>

      <main className="flex-1 px-4 pt-5 space-y-6 pb-8">

        {/* ── 층별 현황 카드 ── */}
        <section className="space-y-3">
          {[1, 2, 3].map((f) => {
            const st  = floorStatus[f]
            const cfg = statusConfig(st.avg)
            return (
              <div key={f} className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-5 py-4">
                  {/* 상단: 층 이름 + 신뢰도 정보 */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-3 h-3 rounded-full ${cfg.dot} flex-shrink-0`} />
                      <span className="text-base font-bold text-gray-900">{f}층 키오스크</span>
                    </div>
                    {st.lastAt ? (
                      <span className="text-xs text-gray-400">
                        {timeAgo(st.lastAt, now)} · {st.isEstimate
                          ? <span className="text-amber-500 font-semibold">추정</span>
                          : <span>{st.reportCount}명 보고</span>
                        }
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300">보고 없음</span>
                    )}
                  </div>
                  {/* 상태 레이블 */}
                  <div className="flex items-center justify-between">
                    <span className={`text-lg font-bold ${cfg.text}`}>{cfg.label}</span>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${cfg.badge}`}>
                      {cfg.sub}
                    </span>
                  </div>
                  {/* 혼잡도 바 */}
                  <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${cfg.bar} ${cfg.barWidth} ${st.isEstimate ? 'opacity-50' : ''}`} />
                  </div>
                  {/* 추정 안내 */}
                  {st.isEstimate && (
                    <p className="text-[11px] text-amber-500 mt-1.5">
                      ⚠ 1명 보고 기준 · 실제와 다를 수 있어요
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </section>

        {/* ── 보고하기 폼 ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="h-px flex-1 bg-gray-100" />
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">내가 보고하기</span>
            <div className="h-px flex-1 bg-gray-100" />
          </div>

          {/* 층 선택 */}
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">어느 층 키오스크인가요?</p>
          <div className="grid grid-cols-3 gap-3 mb-6">
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

          {/* 대기 인원 선택 */}
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
      <div className="px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
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
