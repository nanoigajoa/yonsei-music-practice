'use client'

import { useEffect, useState } from 'react'
import { Room } from '@/hooks/useRoomStatus'
import { useAnnouncements } from '@/components/Announcements'
import { auth } from '@/lib/firebase'
import { bookingApiErrorMessage } from '@/lib/bookingApiError'
import { bookingFailureReason, trackBookingEvent } from '@/lib/bookingAnalytics'
import {
  ActiveBooking, clearActiveBooking, getStudentId, saveActiveBooking,
  clearPendingBookingRequest, getPendingBookingRequest, savePendingBookingRequest, YONSEI_STUDENT_ID_PATTERN,
} from '@/lib/localBooking'

const API_URL = process.env.NEXT_PUBLIC_BOOKING_API_URL
  ?? process.env.NEXT_PUBLIC_KIOSK_API_URL
  ?? 'http://localhost:8000'
type Step = 'reserve' | 'tag' | 'active' | 'returned'
type BookingAction = 'reserve' | 'check' | 'import' | 'return' | 'cancel' | null
const REQUEST_TIMEOUT_MS = 15_000
const TAG_CONFIRM_TIMEOUT_MS = 30_000

function roomNumber(room: Room) {
  return room.name.match(/(\d+)호/)?.[1] ?? ''
}

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

function availableDurations(room: Room) {
  // 현황 폴링은 현재 슬롯만 보여주므로, 그 값으로 예약 시간을 제한하면
  // 실제 키오스크에서 가능한 1~2시간 선택지가 사라질 수 있다. 예약 시점에
  // 학교 서버가 최신 공실과 최대 시간을 최종 검증하므로 항상 전체 선택지를
  // 보여준다.
  void room
  // 22시 이후 종료도 학교 키오스크가 허용한다. 시작 가능 여부와 최종 공실은
  // 예약 요청 때 키오스크가 확인하므로 화면에서 임의로 시간을 제거하지 않는다.
  return [30, 60, 90, 120]
}

export function BookingSheet({ room, resumedBooking, onClose, onChanged, onSessionChange }: {
  room: Room
  resumedBooking?: ActiveBooking | null
  onClose: () => void
  onChanged: () => void
  onSessionChange: (booking: ActiveBooking | null) => void
}) {
  const { dailyEnabled } = useAnnouncements()
  const studentId = getStudentId()
  const durations = availableDurations(room)
  const [duration, setDuration] = useState(() => durations.includes(120) ? 120 : (durations[0] ?? 30))
  const [step, setStep] = useState<Step>(() => resumedBooking?.step ?? 'reserve')
  const [loadingAction, setLoadingAction] = useState<BookingAction>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [returnToken, setReturnToken] = useState(() => resumedBooking?.returnToken ?? '')
  const [requestId, setRequestId] = useState(() => {
    const pending = getPendingBookingRequest()
    return pending && pending.cornerNo === room.corner_no && pending.roomNo === roomNumber(room)
      ? pending.requestId
      : null
  })
  const number = roomNumber(room)
  const loading = loadingAction !== null
  const displayedAvailable = !room.occupied && room.available_periods.length > 0
  const tagDeadline = resumedBooking?.tagDeadline
    ? new Date(resumedBooking.tagDeadline).toLocaleTimeString('ko-KR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : null
  const tagStart = resumedBooking?.startAt ? new Date(resumedBooking.startAt) : null
  const tagNotStarted = step === 'tag' && tagStart !== null && Number.isFinite(tagStart.getTime()) && tagStart > new Date()
  const tagStartLabel = tagStart && Number.isFinite(tagStart.getTime())
    ? tagStart.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
    : null

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !loading) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [loading, onClose])

  async function call(
    path: string,
    body: Record<string, unknown>,
    action: Exclude<BookingAction, null>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    setLoadingAction(action)
    setMessage('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 예약 직전에 토큰을 강제 갱신해 만료된 캐시 토큰을 보내지 않도록 한다.
      const idToken = await auth.currentUser?.getIdToken(true)
      if (!idToken) throw new Error('로그인이 필요합니다.')
      const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail ?? '요청에 실패했습니다.')
      setMessage(data.message ?? '요청을 처리했습니다.')
      setError(!data.success)
      return data
    } catch (e) {
      setError(true)
      setMessage(bookingApiErrorMessage(e))
      return null
    } finally {
      window.clearTimeout(timeout)
      setLoadingAction(null)
    }
  }

  async function reserve() {
    if (!YONSEI_STUDENT_ID_PATTERN.test(studentId)) {
      setError(true); setMessage('연세대학교 10자리 학번을 다시 등록해 주세요.'); return
    }
    const stableRequestId = requestId ?? newRequestId()
    setRequestId(stableRequestId)
    // 응답이 끊겨도 같은 요청을 복구할 수 있도록 브라우저에 짧게 보관한다.
    savePendingBookingRequest({ requestId: stableRequestId, cornerNo: room.corner_no, roomNo: number, createdAt: Date.now() })
    // 이 값은 시간 선택지 통계용일 뿐, 학번·방 번호·예약 식별번호는 전송하지 않는다.
    trackBookingEvent('booking_attempt', { duration_minutes: duration })
    const data = await call('/booking/reserve', {
      student_id: studentId, corner_no: room.corner_no, room_no: number, limit_time: duration, request_id: stableRequestId,
    }, 'reserve')
    if (data?.return_token) setReturnToken(data.return_token)
    // 학교 서버의 중복 예약 거부는 새 방의 진행 상태로 저장하지 않는다.
    // 기존 예약을 새 실패 응답이 덮어쓰면 원래 방의 취소/태그 경로가 사라진다.
    if (data?.success && data.return_token) {
      setReturnToken(data.return_token)
      const confirmedStep = data.reservation?.status === 'active' ? 'active' as const : 'tag' as const
      setStep(confirmedStep)
      const active = {
        room, returnToken: data.return_token, reservationId: data.reservation?.id, step: confirmedStep, createdAt: Date.now(),
        startAt: data.reservation?.start_at, endAt: data.reservation?.end_at,
        tagDeadline: data.reservation?.tag_deadline,
      }
      saveActiveBooking(active)
      clearPendingBookingRequest()
      setRequestId(null)
      onSessionChange(active)
      onChanged()
      trackBookingEvent('booking_success', { duration_minutes: duration })
    } else if (data?.pending) {
      // 키오스크 요청은 계속 진행 중이다. 같은 버튼을 다시 눌러도 request_id가
      // 같으므로 중복 예약 대신 현재 결과만 돌려받는다.
      setError(false)
    } else {
      // 네트워크 응답 자체가 사라진 경우에는 request_id를 유지해 다음 시도에서
      // 결과를 복구한다. 키오스크의 명시적 실패만 새 요청을 허용한다.
      if (data) {
        clearPendingBookingRequest()
        setRequestId(null)
      }
      trackBookingEvent('booking_failed', {
        duration_minutes: duration,
        failure_reason: bookingFailureReason(data?.message),
      })
    }
  }

  async function checkActive() {
    const data = await call('/booking/active', {
      student_id: studentId, corner_no: room.corner_no, return_token: returnToken,
    }, 'check', TAG_CONFIRM_TIMEOUT_MS)
    if (data?.active) {
      setStep('active')
      const active = {
        room, returnToken, reservationId: data.reservation?.id ?? resumedBooking?.reservationId, step: 'active' as const,
        createdAt: resumedBooking?.createdAt ?? Date.now(),
        startAt: data.reservation?.start_at ?? resumedBooking?.startAt, endAt: data.reservation?.end_at ?? resumedBooking?.endAt,
        tagDeadline: resumedBooking?.tagDeadline,
      }
      saveActiveBooking(active)
      onSessionChange(active)
      trackBookingEvent('tag_confirmed')
    }
  }

  async function recoverBooking() {
    if (!returnToken) return
    await checkActive()
  }

  async function importKioskBooking() {
    const data = await call('/booking/import-active', {
      student_id: studentId, corner_no: room.corner_no, room_no: number,
    }, 'import')
    if (data?.success && data.return_token) {
      const active = {
        room, returnToken: data.return_token, reservationId: data.reservation?.id, step: 'active' as const, createdAt: Date.now(),
        startAt: data.reservation?.start_at, endAt: data.reservation?.end_at,
      }
      setReturnToken(data.return_token)
      setStep('active')
      saveActiveBooking(active)
      onSessionChange(active)
      onChanged()
      trackBookingEvent('kiosk_booking_imported')
    }
  }

  async function returnRoom() {
    const data = await call('/booking/return', {
      student_id: studentId, corner_no: room.corner_no, return_token: returnToken,
    }, 'return')
    if (data?.success) {
      if (clearActiveBooking(returnToken)) onSessionChange(null)
      setStep('returned')
      onChanged()
      trackBookingEvent('booking_returned')
    }
  }

  async function cancelReservation() {
    if (!returnToken) return
    const data = await call('/booking/cancel', {
      student_id: studentId, corner_no: room.corner_no, return_token: returnToken,
    }, 'cancel')
    if (data?.success) {
      if (clearActiveBooking(returnToken)) onSessionChange(null)
      setStep('returned')
      setError(false)
      onChanged()
      trackBookingEvent('booking_cancelled')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={() => { if (!loading) onClose() }}>
      <div className="w-full max-w-md rounded-t-3xl bg-white px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+20px)]"
        role="dialog" aria-modal="true" aria-labelledby="booking-sheet-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className={`text-xs font-bold ${step === 'tag' ? 'text-amber-600' : displayedAvailable ? 'text-emerald-600' : 'text-rb-600'}`}>
              {step === 'tag' ? '예약 완료' : displayedAvailable ? '예약 가능' : '클릭 시 실시간 재확인'}
            </p>
            <h2 id="booking-sheet-title" className="mt-0.5 text-xl font-bold text-gray-900">{number}호 예약</h2>
            <p className="mt-1 text-xs text-gray-400">
              {step === 'tag'
                ? tagNotStarted
                  ? `${tagStartLabel}부터 태그 · ${tagDeadline ?? '시작 후 10분'}까지`
                  : `${tagDeadline ?? '10분 이내'}까지 태그`
                : displayedAvailable
                ? `${room.available_periods[0].start}~${room.available_periods[0].end}`
                : '화면 표시와 관계없이 키오스크 원본을 다시 확인합니다.'}
            </p>
          </div>
          <button onClick={() => { if (!loading) onClose() }} disabled={loading} aria-label="예약 창 닫기" className="h-11 w-11 rounded-full bg-gray-100 text-gray-500 text-xl">×</button>
        </div>

        {step === 'reserve' && <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-gray-600">예약 시간</span>
            <select disabled={loading || !!requestId} value={duration} onChange={(e) => setDuration(Number(e.target.value))}
              className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-base outline-none focus:border-rb-500">
              {durations.map((minutes) => <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes}분` : minutes === 60 ? '1시간' : minutes === 90 ? '1시간 30분' : '2시간'}
              </option>)}
            </select>
          </label>
          {dailyEnabled && <p className="text-xs leading-5 text-rose-700">21:50 이전에 시작한 이용 예약은 남은 시간과 관계없이 21:50부터 자동 반납돼요.</p>}
          <button onClick={reserve} disabled={loading}
            className="h-14 w-full rounded-2xl bg-rb-600 font-bold text-white disabled:opacity-50">
            {loadingAction === 'reserve' ? '실시간 확인·예약 중...' : displayedAvailable ? `${number}호 예약하기` : '실시간 확인 후 예약하기'}
          </button>
          {returnToken && <button onClick={recoverBooking} disabled={loading}
            className="h-12 w-full rounded-2xl border border-emerald-200 bg-emerald-50 font-bold text-emerald-700 disabled:opacity-50">
            {loadingAction === 'check' ? '예약 상태 확인 중...' : '이미 예약했다면 상태 확인·반납하기'}
          </button>}
          {!returnToken && <button onClick={importKioskBooking} disabled={loading}
            className="h-12 w-full rounded-2xl border border-blue-200 bg-blue-50 font-bold text-blue-700 disabled:opacity-50">
            {loadingAction === 'import' ? '키오스크 사용 상태 확인 중...' : '키오스크에서 이미 빌렸다면 불러오기'}
          </button>}
        </div>}

        {step === 'tag' && <div className="mt-5">
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4">
            <p className="font-bold text-amber-900">학생증 태그</p>
            <p className="mt-1 text-sm text-amber-700">
              {tagNotStarted && tagStartLabel
                ? `${tagStartLabel}부터 ${number}호 앞 단말기`
                : `${tagDeadline ?? '마감 전'}까지 ${number}호 앞 단말기`}
            </p>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={checkActive} disabled={loading || tagNotStarted}
              className="h-11 rounded-xl border border-gray-200 bg-white text-sm font-bold text-gray-700 disabled:opacity-50">
              {loadingAction === 'check' ? '확인 중...' : '상태 새로고침'}
            </button>
            <button onClick={cancelReservation} disabled={loading}
              className="h-11 rounded-xl border border-red-200 bg-red-50 text-sm font-bold text-red-600 disabled:opacity-50">
              {loadingAction === 'cancel' ? '취소 중...' : '예약 취소'}
            </button>
          </div>
        </div>}

        {step === 'active' && <div className="mt-5">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-center">
            <p className="font-bold text-emerald-800">✓ 태그 인증 완료</p>
            <p className="mt-1 text-sm text-emerald-700">연습이 끝나면 여기서 반납할 수 있어요.</p>
          </div>
          <button onClick={returnRoom} disabled={loading}
            className="mt-4 h-14 w-full rounded-2xl bg-red-500 font-bold text-white disabled:opacity-50">
            {loadingAction === 'return' ? '반납 중...' : '연습실 반납하기'}
          </button>
        </div>}

        {step === 'returned' && <div className="mt-5 text-center">
          <p className="text-4xl">✅</p><p className="mt-2 text-lg font-bold">처리 완료</p>
          <button onClick={() => { if (!loading) onClose() }} className="mt-5 h-12 w-full rounded-2xl bg-gray-900 font-bold text-white">닫기</button>
        </div>}

        {message && <p role="alert" aria-live="polite" className={`mt-3 rounded-xl px-3 py-2 text-center text-sm ${error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{message}</p>}
        <p className="mt-3 text-center text-[10px] text-gray-300">학번은 Google 계정당 하나로 고정되며 예약 처리에만 사용됩니다.</p>
      </div>
    </div>
  )
}
