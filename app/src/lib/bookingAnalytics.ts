/**
 * Google Analytics에 예약 흐름의 운영 지표만 보낸다.
 *
 * 학번, Firebase UID, 방 번호, 예약 식별번호처럼 개인이나 특정 예약을
 * 식별할 수 있는 값은 절대 전송하지 않는다. Analytics 전송 실패는 예약
 * 처리와 무관하며, 화면 동작을 막지 않는다.
 */

type AnalyticsParameters = Record<string, string | number | boolean | undefined>

declare global {
  interface Window {
    gtag?: (command: 'event', eventName: string, parameters?: AnalyticsParameters) => void
  }
}

export type BookingFailureReason =
  | 'duplicate_booking'
  | 'room_unavailable'
  | 'duration_limit'
  | 'authentication'
  | 'network_or_server'
  | 'other'

export function bookingFailureReason(message?: string): BookingFailureReason {
  const value = message ?? ''
  if (/중복|이미 예약|이미.*사용 중/.test(value)) return 'duplicate_booking'
  if (/최대\s*120\s*분|최대.*사용/.test(value)) return 'duration_limit'
  if (/다른 이용자의 예약|예약 가능|시간선택/.test(value)) return 'room_unavailable'
  if (/로그인|인증|학번/.test(value)) return 'authentication'
  if (/연결|응답|네트워크|실패했습니다|처리하지 못/.test(value)) return 'network_or_server'
  return 'other'
}

export function trackBookingEvent(eventName: string, parameters: AnalyticsParameters = {}) {
  if (typeof window === 'undefined') return
  try {
    window.gtag?.('event', eventName, parameters)
  } catch {
    // 분석 도구 차단 또는 로드 실패가 예약 기능을 방해하면 안 된다.
  }
}
