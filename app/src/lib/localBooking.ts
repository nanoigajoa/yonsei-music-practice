import type { Room } from '@/hooks/useRoomStatus'

const STUDENT_ID_KEY = 'practice-room-student-id'
const ACTIVE_BOOKING_KEY = 'practice-room-active-booking'
const MAX_AGE_MS = 4 * 60 * 60 * 1000

export type ActiveBookingStep = 'tag' | 'active'

export interface ActiveBooking {
  room: Room
  returnToken: string
  step: ActiveBookingStep
  createdAt: number
}

export function getStudentId() {
  if (typeof window === 'undefined') return ''
  const value = localStorage.getItem(STUDENT_ID_KEY) ?? ''
  return /^\d{8,10}$/.test(value) ? value : ''
}

export function saveStudentId(value: string) {
  if (!/^\d{8,10}$/.test(value)) throw new Error('invalid student id')
  localStorage.setItem(STUDENT_ID_KEY, value)
}

export function clearStudentId() {
  localStorage.removeItem(STUDENT_ID_KEY)
  localStorage.removeItem(ACTIVE_BOOKING_KEY)
}

export function getActiveBooking(): ActiveBooking | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(ACTIVE_BOOKING_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as ActiveBooking
    if (!value.returnToken || !value.room || Date.now() - value.createdAt > MAX_AGE_MS) {
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
