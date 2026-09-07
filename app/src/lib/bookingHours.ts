/** 화면 조회는 24시간, 신규 예약 접수만 서울 시각 07:00~22:00. */
export function canStartBooking(now: Date = new Date()): boolean {
  const minute = (now.getUTCHours() * 60 + now.getUTCMinutes() + 9 * 60) % (24 * 60)
  return minute >= 7 * 60 && minute < 22 * 60
}
