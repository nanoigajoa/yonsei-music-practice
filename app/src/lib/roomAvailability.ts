export interface AvailabilityRoom {
  occupied: boolean
  available_periods: Array<{ start: string; end: string }>
}

const MIN_RESERVATION_MINUTES = 30

function minutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function canFitMinimumReservation(period: { start: string; end: string }): boolean {
  const start = minutes(period.start)
  const end = minutes(period.end)
  if (start === null || end === null) return false
  // 학교는 22시 전에 시작한 마지막 예약이 22시 이후 끝나는 것을 허용한다.
  if (period.end === '22:00') return true
  const duration = end >= start ? end - start : end + 24 * 60 - start
  return duration >= MIN_RESERVATION_MINUTES
}

/** 최소 예약시간 30분을 실제로 확보할 수 있는 초록색 카드 판정이다. */
export function isCurrentlyAvailable(room: AvailabilityRoom): boolean {
  return !room.occupied && room.available_periods.some(canFitMinimumReservation)
}
