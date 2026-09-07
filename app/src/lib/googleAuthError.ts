export type GoogleLinkResult =
  | 'linked'
  | 'restored'
  | 'cancelled'
  | 'unauthorized_domain'
  | 'provider_disabled'
  | 'popup_blocked'
  | 'network_error'
  | 'storage_unavailable'
  | 'redirecting'
  | 'error'

export function googleErrorResult(error: unknown): GoogleLinkResult {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  const message = error instanceof Error ? error.message : ''
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'cancelled'
  }
  if (code === 'auth/unauthorized-domain') return 'unauthorized_domain'
  if (code === 'auth/operation-not-allowed') return 'provider_disabled'
  if (code === 'auth/popup-blocked') return 'popup_blocked'
  if (code === 'auth/network-request-failed') return 'network_error'
  if (
    code === 'auth/missing-initial-state'
    || code === 'auth/web-storage-unsupported'
    || /missing initial state|sessionStorage|storage-partition/i.test(message)
  ) return 'storage_unavailable'
  return 'error'
}
