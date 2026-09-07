export interface AvailabilityRoom {
  occupied: boolean
  available_periods: unknown[]
}

/** 지금 바로 예약 가능한 초록색 카드와 같은 판정 기준이다. */
export function isCurrentlyAvailable(room: AvailabilityRoom): boolean {
  return !room.occupied && room.available_periods.length > 0
}

