'use client'
import type { User } from 'firebase/auth'
import { useCommunity } from '@/components/CommunityProvider'
/** Compatibility wrapper; registration and SW listeners have one shared owner. */
export function useFcmToken(_user: User | null) {
  void _user
  const n = useCommunity()
  return { permission: n.permission, requestAndRegister: async () => { await n.enable(); return Notification.permission }, disable: n.disable }
}
