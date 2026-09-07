import { auth } from '@/lib/firebase'
export const COMMUNITY_API = (process.env.NEXT_PUBLIC_BOOKING_API_URL
  ?? process.env.NEXT_PUBLIC_KIOSK_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
export const SUPPORT_URL = 'https://open.kakao.com/o/suKUBswi'
export async function communityRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const user = auth.currentUser
  if (!user) throw new Error('로그인이 필요합니다.')
  const token = await user.getIdToken()
  const response = await fetch(`${COMMUNITY_API}/community${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '연결하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  return data as T
}
export interface NotificationSettings { room_alerts: boolean; tag_reminders: boolean; return_reminders: boolean }
export interface NotificationState {
  settings: NotificationSettings
  devices: string[]
  watches: { room_key: string; name: string }[]
  history: { id: string; title: string; body: string; url: string; created: number; status: string }[]
}
export function watchKey(room: { corner_no: number; name: string }) {
  return `${room.corner_no}:${room.name.match(/(\d{3})호/)?.[1] ?? ''}`
}
