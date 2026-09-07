export interface AvailabilityRoom {
  occupied: boolean
  available_periods: unknown[]
}

/** 지금 바로 예약 가능한 초록색 카드와 같은 판정 기준이다. */
export function isCurrentlyAvailable(room: AvailabilityRoom): boolean {
  return !room.occupied && room.available_periods.length > 0
}

/** 서울 시각 기준으로 이용 종료까지 20분 이하 남은 사용 중인 방. */
export function isEndingSoon(
  room: { occupied: boolean; occupied_until: string | null; reservation_state?: string | null },
  now: number | null,
): boolean {
  if (!room.occupied || room.reservation_state === 'pending_tag' || now === null || !Number.isFinite(now)) return false
  const match = /^(\d{2}):(\d{2})$/.exec(room.occupied_until ?? '')
  if (!match) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return false
  const seoul = new Date(now + 9 * 60 * 60 * 1000)
  const currentMinutes = seoul.getUTCHours() * 60 + seoul.getUTCMinutes()
    + seoul.getUTCSeconds() / 60 + seoul.getUTCMilliseconds() / 60000
  const remaining = hour * 60 + minute - currentMinutes
  return remaining > 0 && remaining <= 20
}
