export function bookingApiErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '예약 서버 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.'
  }
  if (error instanceof TypeError) {
    return '예약 서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
  }
  if (error instanceof Error) return error.message
  return '요청을 처리하지 못했어요. 다시 시도해 주세요.'
}
