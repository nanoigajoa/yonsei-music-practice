import type { Room } from '@/hooks/useRoomStatus'

const STUDENT_ID_KEY = 'practice-room-student-id'
const ACTIVE_BOOKING_KEY = 'practice-room-active-booking'
const PENDING_REQUEST_KEY = 'practice-room-pending-request'
const MAX_AGE_MS = 4 * 60 * 60 * 1000
const PENDING_TAG_GRACE_MS = 20 * 1000
// 학번 형식만 확인한다. 음악대학/대학원생 등 실제 이용 가능 여부는
// 학번 등록 시 학교 키오스크 로그인으로 최종 검증한다.
export const YONSEI_STUDENT_ID_PATTERN = /^20\d{8}$/

export type ActiveBookingStep = 'tag' | 'active'

export interface ActiveBooking {
  room: Room
  returnToken: string
  step: ActiveBookingStep
  createdAt: number
  startAt?: string
  endAt?: string
  tagDeadline?: string
}

export interface PendingBookingRequest {
  requestId: string
  cornerNo: number
  roomNo: string
  createdAt: number
}

export function getStudentId() {
  if (typeof window === 'undefined') return ''
  const value = localStorage.getItem(STUDENT_ID_KEY) ?? ''
  return YONSEI_STUDENT_ID_PATTERN.test(value) ? value : ''
}

export function saveStudentId(value: string) {
  if (!YONSEI_STUDENT_ID_PATTERN.test(value)) throw new Error('invalid student id')
  localStorage.setItem(STUDENT_ID_KEY, value)
}

export function clearStudentId() {
  localStorage.removeItem(STUDENT_ID_KEY)
  localStorage.removeItem(ACTIVE_BOOKING_KEY)
  localStorage.removeItem(PENDING_REQUEST_KEY)
}

export function getActiveBooking(): ActiveBooking | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(ACTIVE_BOOKING_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as ActiveBooking
    const tagDeadline = value.tagDeadline ? Date.parse(value.tagDeadline) : NaN
    const endAt = value.endAt ? Date.parse(value.endAt) : NaN
    // 태그 전 예약은 마감이 지나면 키오스크가 자동 취소한다. 종료 시각이 지난
    // 사용 기록도 키오스크의 강제 반납 뒤 다음 예약을 가로막는 낡은 화면이므로
    // 복원하지 않는다. 서버도 같은 기준으로 DB 기록을 정리한다.
    const expiredTag = value.step === 'tag' && Number.isFinite(tagDeadline) && tagDeadline + PENDING_TAG_GRACE_MS <= Date.now()
    const expiredActive = value.step === 'active' && Number.isFinite(endAt) && endAt <= Date.now()
    if (!value.returnToken || !value.room || Date.now() - value.createdAt > MAX_AGE_MS || expiredTag || expiredActive) {
      localStorage.removeItem(ACTIVE_BOOKING_KEY)
      return null
    }
    return value
  } catch {
    localStorage.removeItem(ACTIVE_BOOKING_KEY)
    return null
  }
}

export function saveActiveBooking(value: ActiveBooking) {
  localStorage.setItem(ACTIVE_BOOKING_KEY, JSON.stringify(value))
}

export function clearActiveBooking() {
  localStorage.removeItem(ACTIVE_BOOKING_KEY)
}

export function getPendingBookingRequest(): PendingBookingRequest | null {
  if (typeof window === 'undefined') return null
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_REQUEST_KEY) ?? '') as PendingBookingRequest
    if (!value.requestId || !value.roomNo || Date.now() - value.createdAt > 10 * 60 * 1000) {
      localStorage.removeItem(PENDING_REQUEST_KEY)
      return null
    }
    return value
  } catch {
    return null
  }
}

export function savePendingBookingRequest(value: PendingBookingRequest) {
  localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify(value))
}

export function clearPendingBookingRequest() {
  localStorage.removeItem(PENDING_REQUEST_KEY)
}
