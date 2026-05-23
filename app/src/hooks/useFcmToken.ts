'use client'
import { useEffect, useCallback, useState } from 'react'
import { User } from 'firebase/auth'
import { getToken } from 'firebase/messaging'
import { getMessagingInstance } from '@/lib/firebase'

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY!

async function registerToken(user: User): Promise<boolean> {
  const messaging = await getMessagingInstance()
  if (!messaging) return false

  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY })
    const idToken = await user.getIdToken()
    const res = await fetch('/api/fcm/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ token }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function unregisterToken(user: User): Promise<void> {
  const messaging = await getMessagingInstance()
  if (!messaging) return

  try {
    const { deleteToken } = await import('firebase/messaging')
    const token = await getToken(messaging, { vapidKey: VAPID_KEY })
    const idToken = await user.getIdToken()
    await Promise.all([
      deleteToken(messaging),
      fetch('/api/fcm/register', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ token }),
      }),
    ])
  } catch {
    // 토큰 없으면 무시
  }
}

export function useFcmToken(user: User | null) {
  const [permission, setPermission] = useState<NotificationPermission>('default')

  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      setPermission(Notification.permission)
    }
  }, [])

  // 이미 권한 있으면 앱 로드 시 자동 등록
  useEffect(() => {
    if (permission === 'granted' && user) {
      registerToken(user)
    }
  }, [permission, user])

  const requestAndRegister = useCallback(async (): Promise<NotificationPermission> => {
    if (typeof Notification === 'undefined') return 'denied'
    const perm = await Notification.requestPermission()
    setPermission(perm)
    if (perm === 'granted' && user) {
      await registerToken(user)
    }
    return perm
  }, [user])

  const disable = useCallback(async () => {
    if (user) await unregisterToken(user)
    setPermission('default')
  }, [user])

  return { permission, requestAndRegister, disable }
}
