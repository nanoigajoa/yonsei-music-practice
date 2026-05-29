'use client'

import { useState, useEffect } from 'react'
import { collection, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import Link from 'next/link'
import { db } from '@/lib/firebase'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { useFcmToken } from '@/hooks/useFcmToken'
import { useUserProfile } from '@/hooks/useUserProfile'
import { COLLECTIONS } from '@/types/collections'

type ReservedMode = 'now' | 'manual'
type EndMode = 'none' | 'plus1h' | 'plus2h' | 'custom'
type Step = 'form' | 'timer'

function pad(n: number) { return n.toString().padStart(2, '0') }
function toHHMM(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function formatCountdown(ms: number) {
  if (ms <= 0) return '00:00'
  const secs = Math.floor(ms / 1000)
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function NotifyRow({ enabled, label, desc }: { enabled: boolean; label: string; desc: string }) {
  return (
    <div className={`flex items-start gap-3 ${enabled ? '' : 'opacity-40'}`}>
      <span className="mt-0.5 text-base">{enabled ? '🔔' : '🔕'}</span>
      <div className="flex-1">
        <p className={`text-sm font-bold ${enabled ? 'text-gray-900' : 'text-gray-400'}`}>
          {label}
          {!enabled && <span className="ml-1.5 text-[10px] font-medium text-gray-400">꺼짐</span>}
        </p>
        <p className={`text-sm ${enabled ? 'text-gray-500' : 'text-gray-300'}`}>{desc}</p>
      </div>
    </div>
  )
}

// ─── 타이머 화면 ──────────────────────────────────────────────
function TimerScreen({ reservedAt, endTime, roomHint, notifyTag, notifyExtend, notifyReturn }: {
  reservedAt: Date
  endTime: Date | null
  roomHint: string
  notifyTag: boolean
  notifyExtend: boolean
  notifyReturn: boolean
}) {
  const deadline = new Date(reservedAt.getTime() + 10 * 60 * 1000)
  const [countdown, setCountdown] = useState(formatCountdown(deadline.getTime() - Date.now()))
  const [expired, setExpired] = useState(deadline.getTime() <= Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      const remaining = deadline.getTime() - Date.now()
      setCountdown(formatCountdown(remaining))
      setExpired(remaining <= 0)
    }, 1000)
    return () => clearInterval(id)
  }, [deadline])

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 flex items-center gap-3">
        <Link href="/" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
        <h1 className="text-xl font-bold text-white">알림 등록 완료</h1>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-5 gap-6">

        {/* 카운트다운 */}
        <div className={`w-full rounded-3xl py-10 px-6 text-center ${expired ? 'bg-gray-50' : 'bg-rb-600'}`}>
          {roomHint && (
            <p className={`text-sm font-semibold mb-3 ${expired ? 'text-gray-500' : 'text-rb-100'}`}>
              {roomHint}
            </p>
          )}
          <p className={`text-8xl font-bold tabular-nums tracking-tighter ${expired ? 'text-gray-300' : 'text-white'}`}>
            {countdown}
          </p>
          <p className={`text-sm mt-3 font-medium ${expired ? 'text-gray-400' : 'text-rb-100'}`}>
            {expired ? '태그 시간이 지났어요' : '카드 태그까지 남은 시간'}
          </p>
        </div>

        {/* 등록된 알림 요약 */}
        <div className="w-full rounded-2xl bg-rb-50 border border-rb-100 px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider">알림 설정</p>
            <Link href="/mypage" className="text-[11px] text-rb-400 underline underline-offset-2">
              설정 변경
            </Link>
          </div>

          {/* 태그 알림 */}
          <NotifyRow
            enabled={notifyTag}
            label="태그 알림"
            desc="슬롯 시작 5분 후 · 2분 전"
          />

          {/* 연장 리마인더 */}
          {endTime && (
            <NotifyRow
              enabled={notifyExtend}
              label="연장 리마인더"
              desc={`${toHHMM(new Date(endTime.getTime() - 40 * 60 * 1000))} — 연장 여부 결정`}
            />
          )}

          {/* 반납 리마인더 */}
          {endTime && (
            <NotifyRow
              enabled={notifyReturn}
              label="반납 리마인더"
              desc={`${toHHMM(new Date(endTime.getTime() - 10 * 60 * 1000))} — 10분 전 반납 알림`}
            />
          )}
        </div>

      </main>

      <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <Link
          href="/"
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-gray-100 text-gray-700 text-base font-bold active:scale-[0.98] transition-all"
        >
          홈으로
        </Link>
      </div>
    </div>
  )
}

// ─── 폼 화면 ──────────────────────────────────────────────────
export default function AlarmPage() {
  const { user } = useAnonymousAuth()
  const { permission, requestAndRegister } = useFcmToken(user)
  const { profile } = useUserProfile(user)

  const [reservedMode, setReservedMode] = useState<ReservedMode>('now')
  const [reservedTimeInput, setReservedTimeInput] = useState('')
  const [endMode, setEndMode] = useState<EndMode>('plus2h')
  const [endTimeInput, setEndTimeInput] = useState('')
  const [roomHint, setRoomHint] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState<Step>('form')
  const [reservedAt, setReservedAt] = useState<Date | null>(null)
  const [endTime, setEndTime] = useState<Date | null>(null)

  useEffect(() => {
    const now = new Date()
    setReservedTimeInput(toHHMM(now))
    setEndTimeInput(toHHMM(new Date(now.getTime() + 2 * 60 * 60 * 1000)))
  }, [])

  // 키오스크 10분 슬롯 기준으로 올림 (14:14 → 14:20)
  function snapToSlotStart(d: Date): Date {
    const total = d.getHours() * 60 + d.getMinutes()
    const snapped = Math.ceil(total / 10) * 10
    const result = new Date(d)
    result.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0)
    return result
  }

  function resolveReservedAt(): Date | null {
    let raw: Date
    if (reservedMode === 'now') {
      raw = new Date()
    } else {
      if (!reservedTimeInput) return null
      const [h, m] = reservedTimeInput.split(':').map(Number)
      raw = new Date()
      raw.setHours(h, m, 0, 0)
      if (raw.getTime() > Date.now() + 60_000) raw.setDate(raw.getDate() - 1)
    }
    const slotStart = snapToSlotStart(raw)
    const slotEnd = new Date(slotStart.getTime() + 10 * 60 * 1000)
    // 슬롯이 이미 종료됐으면 거부
    if (slotEnd.getTime() <= Date.now()) return null
    return slotStart
  }

  function resolveEndTime(base: Date): Date | null {
    if (endMode === 'none') return null
    if (endMode === 'plus1h') return new Date(base.getTime() + 60 * 60 * 1000)
    if (endMode === 'plus2h') return new Date(base.getTime() + 2 * 60 * 60 * 1000)
    if (!endTimeInput) return null
    const [h, m] = endTimeInput.split(':').map(Number)
    const d = new Date(base)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1)
    return d
  }

  function previewEndTime(mode: EndMode): string {
    const base = reservedMode === 'now' ? new Date() : (() => {
      if (!reservedTimeInput) return new Date()
      const [h, m] = reservedTimeInput.split(':').map(Number)
      const d = new Date(); d.setHours(h, m, 0, 0); return d
    })()
    if (mode === 'plus1h') return toHHMM(new Date(base.getTime() + 60 * 60 * 1000))
    if (mode === 'plus2h') return toHHMM(new Date(base.getTime() + 2 * 60 * 60 * 1000))
    return ''
  }

  async function handleSubmit() {
    if (!user) return
    const resolved = resolveReservedAt()
    if (!resolved) {
      setError('인증 시간이 지났어요. 새로 예약 후 다시 등록해주세요.')
      return
    }
    const resolvedEnd = resolveEndTime(resolved)
    setError('')
    setSubmitting(true)

    // FCM 토큰이 없으면 권한 요청 후 등록
    if (permission !== 'granted') {
      const granted = await requestAndRegister()
      if (granted !== 'granted') {
        setError('알림 권한이 없으면 태그 알림을 받을 수 없어요. 브라우저 설정에서 알림을 허용해 주세요.')
        setSubmitting(false)
        return
      }
    }
    try {
      await addDoc(collection(db, COLLECTIONS.ALARM_SESSIONS), {
        userId:            user.uid,
        reservedAt:        Timestamp.fromDate(resolved),
        endTime:           resolvedEnd ? Timestamp.fromDate(resolvedEnd) : null,
        roomHint:          roomHint.trim() || null,
        notified5:         false,
        notified1:         false,
        notifiedReturn40:  false,
        notifiedReturn10:  false,
        practiceLogged:    false,
        status:            'active',
        createdAt:         serverTimestamp(),
      })
      setReservedAt(resolved)
      setEndTime(resolvedEnd)
      setStep('timer')
    } catch (e) {
      console.error(e)
      setError('등록에 실패했어요. 다시 시도해 주세요.')
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'timer' && reservedAt) {
    return (
      <TimerScreen
        reservedAt={reservedAt}
        endTime={endTime}
        roomHint={roomHint}
        notifyTag={profile?.notifyTag !== false}
        notifyExtend={profile?.notifyExtend !== false}
        notifyReturn={profile?.notifyReturn !== false}
      />
    )
  }

  const endButtons: { mode: EndMode; label: string }[] = [
    { mode: 'plus1h',  label: `+1시간 (${previewEndTime('plus1h')}까지)` },
    { mode: 'plus2h',  label: `+2시간 (${previewEndTime('plus2h')}까지)` },
    { mode: 'custom',  label: '직접 입력' },
    { mode: 'none',    label: '리마인더 없음' },
  ]

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 flex items-center gap-3">
        <Link href="/" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
        <div>
          <h1 className="text-xl font-bold text-white">태그 · 반납 알림</h1>
          <p className="text-rb-200 text-xs mt-0.5">키오스크 예약 직후 등록하세요</p>
        </div>
      </header>

      <main className="flex-1 px-4 pt-6 space-y-7">

        {/* ① 예약 시각 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">언제 예약하셨나요?</p>
          <div className="grid grid-cols-2 gap-2">
            {([['now', '방금 예약했어요'], ['manual', '시각 직접 입력']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setReservedMode(m)}
                className={`h-13 rounded-2xl text-sm font-bold border-2 transition-all active:scale-95 ${
                  reservedMode === m
                    ? 'border-rb-600 bg-rb-600 text-white'
                    : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {reservedMode === 'manual' && (
            <div className="mt-3">
              <input
                type="time"
                value={reservedTimeInput}
                onChange={(e) => setReservedTimeInput(e.target.value)}
                className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-2xl font-bold text-gray-900 text-center focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
              />
              <p className="text-xs text-gray-400 mt-2 text-center">예약한 지 9분 이내만 등록 가능해요</p>
            </div>
          )}
        </section>

        {/* ② 종료 시각 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-1">예약 종료 시각</p>
          <p className="text-xs text-gray-400 mb-3">15분·5분 전에 반납 리마인더를 보내드려요</p>
          <div className="grid grid-cols-2 gap-2">
            {endButtons.map(({ mode, label }) => (
              <button
                key={mode}
                onClick={() => setEndMode(mode)}
                className={`h-13 rounded-2xl text-xs font-bold border-2 transition-all active:scale-95 px-2 ${
                  endMode === mode
                    ? 'border-rb-600 bg-rb-600 text-white'
                    : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {endMode === 'custom' && (
            <div className="mt-3">
              <input
                type="time"
                value={endTimeInput}
                onChange={(e) => setEndTimeInput(e.target.value)}
                className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-2xl font-bold text-gray-900 text-center focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
              />
            </div>
          )}
        </section>

        {/* ③ 방 번호 */}
        <section>
          <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-3">
            방 번호 <span className="font-normal text-gray-400 normal-case">(선택)</span>
          </p>
          <input
            type="text"
            value={roomHint}
            onChange={(e) => setRoomHint(e.target.value)}
            placeholder="예: 302호"
            className="w-full h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-5 text-base font-medium text-gray-900 placeholder:text-gray-300 focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
          />
        </section>

        {/* 패널티 안내 */}
        <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-sm font-bold text-amber-800">⚠️ 예약 후 10분 내 태그 필수</p>
          <p className="text-xs text-amber-600 mt-1">미태그 시 패널티 (2회→3일, 3회→7주 이용 불가)</p>
        </div>

        {/* 현재 알림 설정 미리보기 */}
        {profile && (
          <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-gray-500">현재 알림 설정</p>
              <Link href="/mypage" className="text-[11px] text-rb-500 underline underline-offset-2">변경</Link>
            </div>
            <div className="flex gap-3 flex-wrap">
              {[
                { key: 'notifyTag',    label: '태그 알림' },
                { key: 'notifyExtend', label: '연장' },
                { key: 'notifyReturn', label: '반납' },
              ].map(({ key, label }) => {
                const on = profile[key as keyof typeof profile] !== false
                return (
                  <span key={key} className={`text-xs font-bold px-2 py-1 rounded-lg ${on ? 'bg-rb-100 text-rb-700' : 'bg-gray-100 text-gray-400 line-through'}`}>
                    {on ? '🔔' : '🔕'} {label}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm font-medium text-red-700">{error}</p>
          </div>
        )}

      </main>

      <div className="px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <button
          onClick={handleSubmit}
          disabled={submitting || !user}
          className="flex items-center justify-center w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 active:scale-[0.98] transition-all"
        >
          {submitting ? '등록 중...' : '알림 등록하기'}
        </button>
        <p className="text-center text-xs text-gray-400 mt-2">태그 알림 + 반납 리마인더를 한 번에 등록해요</p>
      </div>

    </div>
  )
}
