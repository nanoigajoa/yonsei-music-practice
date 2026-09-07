'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { communityRequest } from '@/lib/community'

type Period = 'daily' | 'weekly' | 'monthly'
const periods = { daily: '오늘', weekly: '이번 주', monthly: '이번 달' }
interface BookingSession {
  id: string; room_no: string; corner_no: number; created_at: string
  start_at: string; end_at: string; returned_at: string | null; status: string
  duration_min: number | null; usage_minutes: number | null
}
interface HistoryData {
  sessions: BookingSession[]; has_more: boolean; next_offset: number; updated_at: string
  summary: { minutes: number; session_count: number; unknown_count: number }
}
const states: Record<string, [string, string]> = {
  creating: ['예약 준비 중', 'bg-gray-100 text-gray-700'],
  submitting: ['예약 처리 중', 'bg-gray-100 text-gray-700'],
  uncertain: ['예약 확인 중', 'bg-amber-50 text-amber-800'],
  pending_tag: ['인증대기', 'bg-amber-50 text-amber-800'],
  active: ['사용 중', 'bg-rb-50 text-rb-700'],
  returned: ['반납 완료', 'bg-emerald-50 text-emerald-800'],
  ended: ['예약시간 종료', 'bg-gray-100 text-gray-700'],
  expired: ['미인증 만료', 'bg-gray-100 text-gray-600'],
  cancelled: ['예약 취소', 'bg-gray-100 text-gray-600'],
  failed: ['예약 실패', 'bg-rose-50 text-rose-800'],
  unconfirmed_ended: ['확인 없이 종료', 'bg-gray-100 text-gray-600'],
}
function minutes(value: number) { return value < 60 ? `${value}분` : `${Math.floor(value/60)}시간${value%60 ? ` ${value%60}분` : ''}` }
function dateTime(value: string | number) {
  return new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false})
}

export function PracticeHistory({ user }: { user: User }) {
  const [period, setPeriod] = useState<Period>('weekly')
  return <section className="space-y-4" aria-label="자동 연습 기록">
    <div className="flex gap-2">{(Object.entries(periods) as [Period,string][]).map(([key,label]) => <button key={key} onClick={() => setPeriod(key)} aria-pressed={period === key} className={`flex-1 py-2 rounded-xl text-sm font-bold ${period === key ? 'bg-rb-600 text-white' : 'bg-rb-50 text-rb-600'}`}>{label}</button>)}</div>
    <BookingHistory key={`${user.uid}:${period}`} period={period} />
    <LegacyHistory key={user.uid} user={user} />
  </section>
}

function BookingHistory({ period }: { period: Period }) {
  const [data, setData] = useState<HistoryData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false)
  const loading = useRef(false)
  const expanded = useRef(false)
  const load = useCallback(async (offset = 0) => {
    if (loading.current) return
    loading.current = true; setBusy(true)
    try {
      const result = await communityRequest<HistoryData>(`/practice?period=${period}&limit=30&offset=${offset}`)
      if (!alive.current) return
      setData(old => offset && old ? {...result, sessions: [...old.sessions, ...result.sessions.filter(s => !old.sessions.some(prev => prev.id === s.id))]} : result)
      expanded.current = offset > 0
      setError('')
    } catch {
      if (alive.current) setError('예약 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
    } finally { loading.current = false; if (alive.current) setBusy(false) }
  }, [period])
  useEffect(() => {
    alive.current = true
    const initial = setTimeout(() => void load(), 0)
    const refreshVisible = () => { if (document.visibilityState === 'visible' && !expanded.current) void load() }
    const timer = setInterval(refreshVisible, 30000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => { alive.current = false; clearTimeout(initial); clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible) }
  }, [load])
  return <>
    <div className="rounded-2xl bg-rb-50 border border-rb-200 p-4">
      <h2 className="font-bold text-rb-800">{periods[period]} 예약 기반 이용시간</h2>
      {data ? <div className="flex items-end justify-between mt-3"><p className="text-3xl font-bold text-rb-700">{minutes(data.summary.minutes)}</p><p className="text-sm text-rb-700">이용 {data.summary.session_count}회</p></div> : <p className="text-sm text-gray-500 mt-3">{error ? '기록 연결 확인 필요' : '기록을 불러오는 중…'}</p>}
      <p className="text-xs text-gray-600 leading-5 mt-3">학생증 인증이 확인된 예약의 시작 시각부터 반납 확인 또는 예약 종료까지 집계해요. 사용 중인 방은 현재까지의 시간만 포함하며, 취소·미인증 예약은 포함하지 않아요. 실제 연습한 시간을 측정하는 기능은 아니에요.</p>
      {!!data?.summary.unknown_count && <p className="text-xs text-amber-800 mt-2">반납 시각이 남아 있지 않은 이전 기록 {data.summary.unknown_count}건은 시간 합계에서 제외했어요.</p>}
    </div>
    <div className="flex items-center justify-between"><div><h2 className="font-bold">최근 예약 기록</h2><p className="text-xs text-gray-500 mt-1">전체 기간 · 예약하면 최신순으로 자동 저장돼요</p></div><button onClick={() => void load()} disabled={busy} className="shrink-0 rounded-lg p-2 text-sm text-rb-700 disabled:opacity-40">{busy ? '갱신 중…' : '새로고침'}</button></div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {data?.sessions.length === 0 && <p className="py-6 text-center text-sm text-gray-500">아직 앱에 저장된 예약이 없어요. 연습실을 예약하면 여기에 쌓여요.</p>}
    <ol aria-label="예약 기록 목록" className="space-y-3">{data?.sessions.map(session => {
      const [label, color] = states[session.status] ?? ['상태 확인 필요','bg-gray-100 text-gray-700']
      return <li key={session.id} className="rounded-2xl border border-gray-200 p-4">
        <div className="flex items-center justify-between gap-2"><h3 className="font-bold">{[1,2,3,4].includes(session.corner_no) ? 'A동' : 'B동'} {session.room_no}호</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}>{label}</span></div>
        <p className="text-xs text-gray-500 mt-2">접수 {dateTime(session.created_at)}</p>
        <p className="text-sm text-gray-700 mt-2">예약 {dateTime(session.start_at)} ~ {dateTime(session.end_at)}</p>
        {session.returned_at && <p className="text-xs text-gray-600 mt-1">반납 확인 {dateTime(session.returned_at)}</p>}
        {session.usage_minutes !== null ? <p className="text-sm font-semibold text-rb-700 mt-2">예약 기준 {minutes(session.usage_minutes)}{session.status === 'active' ? ' · 이용 중' : ''}</p> : session.status === 'returned' ? <p className="text-xs text-gray-500 mt-2">이전 반납 시각 미기록 · 이용시간 미집계</p> : null}
      </li>
    })}</ol>
    {data?.has_more && <button disabled={busy} onClick={() => void load(data.next_offset)} className="w-full rounded-xl border border-gray-200 p-3 text-sm font-semibold text-gray-700 disabled:opacity-40">이전 예약 더 보기</button>}
    {data && <p className="text-[11px] text-gray-500">{dateTime(data.updated_at)} 갱신 · 앱에서 예약하거나 불러온 이용만 표시돼요.</p>}
  </>
}

function LegacyHistory({ user }: { user: User }) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<{id:string;roomHint:string|null;startedAt:number;durationMin:number;source:string}[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function load() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const token = await user.getIdToken()
      const result = await fetch('/api/practice?limit=50', {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),cache:'no-store'})
      if (!result.ok) throw new Error('failed')
      setSessions((await result.json()).sessions)
    } catch { setError('이전 기록을 불러오지 못했어요.') }
    finally { setBusy(false) }
  }
  return <div className="border-t border-gray-100 pt-4">
    <button aria-expanded={open} onClick={() => {setOpen(!open); if (!open && !sessions) void load()}} className="text-sm font-semibold text-gray-600">이전 직접 입력·알림 기록 {open ? '⌃' : '⌄'}</button>
    {open && <div className="mt-3 space-y-2"><p className="text-xs text-gray-500 leading-5">기존에 저장한 기록은 그대로 보관돼요. 자동 예약 통계와 별도로 최근 50건을 보여드려요.</p>
      {busy && <p className="text-sm text-gray-500">불러오는 중…</p>}
      {error && <p role="alert" className="text-sm text-rose-800">{error} <button onClick={() => void load()} className="underline">다시 시도</button></p>}
      {sessions?.map(s => <div key={s.id} className="rounded-xl bg-gray-50 p-3 text-sm"><p>{s.roomHint || '방 미입력'} · {minutes(s.durationMin)}</p><p className="text-xs text-gray-500 mt-1">{dateTime(s.startedAt)} · {s.source === 'manual' ? '직접 입력' : '이전 알림 기록'}</p></div>)}
      {sessions?.length === 0 && <p className="text-sm text-gray-500">이전에 저장된 기록이 없어요.</p>}
    </div>}
  </div>
}
