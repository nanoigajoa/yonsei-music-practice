'use client'

import { useState } from 'react'
import { Room } from '@/hooks/useRoomStatus'
import { auth } from '@/lib/firebase'

const API_URL = process.env.NEXT_PUBLIC_KIOSK_API_URL ?? 'http://localhost:8000'
type Step = 'reserve' | 'tag' | 'active' | 'returned'

function roomNumber(room: Room) {
  return room.name.match(/(\d+)호/)?.[1] ?? ''
}

function availableDurations(room: Room) {
  const period = room.available_periods[0]
  if (!period) return [30]
  const [sh, sm] = period.start.split(':').map(Number)
  const [eh, em] = period.end.split(':').map(Number)
  const available = (eh * 60 + em) - (sh * 60 + sm)
  return [30, 60, 90, 120].filter((minutes) => minutes <= available)
}

export function BookingSheet({ room, onClose, onChanged }: {
  room: Room
  onClose: () => void
  onChanged: () => void
}) {
  const [studentId, setStudentId] = useState('')
  const durations = availableDurations(room)
  const [duration, setDuration] = useState(() => durations.at(-1) ?? 30)
  const [step, setStep] = useState<Step>('reserve')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [returnToken, setReturnToken] = useState('')
  const number = roomNumber(room)

  async function call(path: string, body: Record<string, unknown>) {
    setLoading(true)
    setMessage('')
    try {
      const idToken = await auth.currentUser?.getIdToken()
      if (!idToken) throw new Error('로그인이 필요합니다.')
      const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? '요청에 실패했습니다.')
      setMessage(data.message)
      setError(!data.success)
      return data
    } catch (e) {
      setError(true)
      setMessage(e instanceof Error ? e.message : '서버 연결에 실패했습니다.')
      return null
    } finally {
      setLoading(false)
    }
  }

  async function reserve() {
    if (!/^\d{8,10}$/.test(studentId)) {
      setError(true); setMessage('학번을 정확히 입력해 주세요.'); return
    }
    const data = await call('/booking/reserve', {
      student_id: studentId, corner_no: room.corner_no, room_no: number, limit_time: duration,
    })
    if (data?.success && data.return_token) {
      setReturnToken(data.return_token)
      setStep('tag')
      onChanged()
    }
  }

  async function checkActive() {
    const data = await call('/booking/active', {
      student_id: studentId, corner_no: room.corner_no, return_token: returnToken,
    })
    if (data?.active) setStep('active')
  }

  async function returnRoom() {
    const data = await call('/booking/return', {
      student_id: studentId, corner_no: room.corner_no, return_token: returnToken,
    })
    if (data?.success) { setStep('returned'); onChanged() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-3xl bg-white px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+20px)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-bold text-emerald-600">예약 가능</p>
            <h2 className="mt-0.5 text-xl font-bold text-gray-900">{number}호 예약</h2>
            <p className="mt-1 text-xs text-gray-400">{room.available_periods[0]?.start}~{room.available_periods[0]?.end}</p>
          </div>
          <button onClick={onClose} className="h-8 w-8 rounded-full bg-gray-100 text-gray-500">×</button>
        </div>

        {step === 'reserve' && <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-gray-600">학번</span>
            <input value={studentId} onChange={(e) => setStudentId(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric" maxLength={10} placeholder="학번 입력"
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none focus:border-rb-500" />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-600">예약 시간</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}
              className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-base outline-none focus:border-rb-500">
              {durations.map((minutes) => <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes}분` : minutes === 60 ? '1시간' : minutes === 90 ? '1시간 30분' : '2시간'}
              </option>)}
            </select>
          </label>
          <button onClick={reserve} disabled={loading}
            className="h-14 w-full rounded-2xl bg-rb-600 font-bold text-white disabled:opacity-50">
            {loading ? '예약 중...' : `${number}호 예약하기`}
          </button>
        </div>}

        {step === 'tag' && <div className="mt-5">
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4">
            <p className="font-bold text-amber-900">10분 안에 학생증을 태그하세요</p>
            <p className="mt-1 text-sm leading-5 text-amber-700">{number}호 앞 단말기에 실물 학생증을 직접 태그한 뒤 아래 버튼을 눌러주세요.</p>
          </div>
          <button onClick={checkActive} disabled={loading}
            className="mt-4 h-14 w-full rounded-2xl bg-emerald-600 font-bold text-white disabled:opacity-50">
            {loading ? '확인 중...' : '태그 완료 확인'}
          </button>
        </div>}

        {step === 'active' && <div className="mt-5">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-center">
            <p className="font-bold text-emerald-800">✓ 태그 인증 완료</p>
            <p className="mt-1 text-sm text-emerald-700">연습이 끝나면 여기서 반납할 수 있어요.</p>
          </div>
          <button onClick={returnRoom} disabled={loading}
            className="mt-4 h-14 w-full rounded-2xl bg-red-500 font-bold text-white disabled:opacity-50">
            {loading ? '반납 중...' : '연습실 반납하기'}
          </button>
        </div>}

        {step === 'returned' && <div className="mt-5 text-center">
          <p className="text-4xl">✅</p><p className="mt-2 text-lg font-bold">반납 완료</p>
          <button onClick={onClose} className="mt-5 h-12 w-full rounded-2xl bg-gray-900 font-bold text-white">닫기</button>
        </div>}

        {message && <p className={`mt-3 rounded-xl px-3 py-2 text-center text-sm ${error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{message}</p>}
        <p className="mt-3 text-center text-[10px] text-gray-300">학번은 예약 처리에만 사용되며 앱에 저장되지 않습니다.</p>
      </div>
    </div>
  )
}
