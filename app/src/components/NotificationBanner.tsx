'use client'
import Link from 'next/link'
import type { User } from 'firebase/auth'
import { useCommunity } from './CommunityProvider'
export function NotificationBanner({ user }: { user: User | null }) {
  const n = useCommunity()
  if (!user) return null
  return <Link href="/alarm" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-2xl bg-rb-50 border border-rb-100 px-4 py-3">
    <div><p className="text-sm font-bold text-rb-800">{n.registered ? '이 기기의 알림이 켜져 있어요' : '찜한 방이 비면 알려드릴게요'}</p><p className="text-xs text-rb-700 mt-1">{n.registered ? '찜한 방 · 태그 · 반납 알림 확인' : '알림 권한과 기기 등록을 확인해 주세요'}</p></div><span className="text-sm font-bold text-rb-700 shrink-0">설정 ›</span>
  </Link>
}
