'use client'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { getToken, deleteToken } from 'firebase/messaging'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { getMessagingInstance } from '@/lib/firebase'
import { communityRequest, NotificationSettings, NotificationState, watchKey } from '@/lib/community'
import type { Room } from '@/hooks/useRoomStatus'

function withTimeout<T>(task: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('알림 등록 응답이 늦습니다. 연결을 확인하고 다시 시도해 주세요.')), 20000)
    task.then(value => { clearTimeout(timer); resolve(value) }, cause => { clearTimeout(timer); reject(cause) })
  })
}
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : '잠시 후 다시 시도해 주세요.' }
function useCommunityState() {
  const { user } = useAnonymousAuth()
  const [data, setData] = useState<NotificationState | null>(null)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [supported, setSupported] = useState<boolean | null>(null)
  const [needsInstall, setNeedsInstall] = useState(false)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connected, setConnected] = useState(false)
  const registrationEpoch = useRef(0)
  const owner = useRef(user?.uid)
  useEffect(() => { owner.current = user?.uid }, [user?.uid])
  const storageKey = user ? `practice-push:${user.uid}` : ''
  const refresh = useCallback(async () => {
    if (!user) return
    try {
      const result = await communityRequest<NotificationState>('/notifications')
      if (owner.current !== user.uid) return
      setData(result)
      setConnected(true)
    } catch (cause) { if (owner.current === user.uid) { setConnected(false); setError(errorText(cause)) } }
  }, [user])

  useEffect(() => {
    let alive = true
    const check = () => {
      if (!alive) return
      setPermission(typeof Notification === 'undefined' ? 'default' : Notification.permission)
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
      setNeedsInstall(ios && !standalone)
    }
    check()
    void getMessagingInstance().then(m => { if (alive) setSupported(!!m) }).catch(() => { if (alive) setSupported(false) })
    window.addEventListener('focus', check)
    return () => { alive = false; window.removeEventListener('focus', check) }
  }, [])

  useEffect(() => {
    if (!user) return
    let alive = true
    const initial = setTimeout(() => {
      setData(null)
      try { setDeviceId(localStorage.getItem(storageKey)) } catch { setDeviceId(null) }
      void refresh()
    }, 0)
    const check = () => { if (document.visibilityState === 'visible' && alive) void refresh() }
    const pushed = (event: MessageEvent) => {
      if (event.data?.type === 'PRACTICE_PUSH') {
        setNotice(event.data.title ?? '알림이 도착했습니다.')
        void refresh()
      }
    }
    const interval = setInterval(check, 30000)
    document.addEventListener('visibilitychange', check)
    navigator.serviceWorker?.addEventListener('message', pushed)
    return () => { alive = false; clearTimeout(initial); clearInterval(interval); document.removeEventListener('visibilitychange', check); navigator.serviceWorker?.removeEventListener('message', pushed) }
  }, [user, storageKey, refresh])

  const registered = permission === 'granted' && !!deviceId && !!data?.devices.includes(deviceId)
  async function registerCurrentDevice(requestPermission: boolean) {
    if (!user) throw new Error('로그인이 필요합니다.')
    const epoch = registrationEpoch.current
    if (needsInstall) throw new Error('iPhone·iPad는 공유 → 홈 화면에 추가 후 앱 아이콘으로 열어 주세요.')
    if (typeof Notification === 'undefined') throw new Error('이 브라우저는 알림을 지원하지 않습니다.')
    const granted = requestPermission ? await Notification.requestPermission() : Notification.permission
    setPermission(granted)
    if (granted !== 'granted') throw new Error('브라우저의 사이트 설정에서 알림을 허용해 주세요.')
    const messaging = await getMessagingInstance()
    if (!messaging) throw new Error('이 브라우저에서는 푸시 알림을 사용할 수 없습니다.')
    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY
    if (!vapidKey) throw new Error('알림 설정을 불러오지 못했습니다. 운영자에게 문의해 주세요.')
    const registration = await withTimeout(navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' }))
    await withTimeout(navigator.serviceWorker.ready)
    const token = await withTimeout(getToken(messaging, { vapidKey, serviceWorkerRegistration: registration }))
    if (!token) throw new Error('알림 등록에 실패했습니다. 다시 시도해 주세요.')
    if (epoch !== registrationEpoch.current || owner.current !== user.uid) return
    const result = await communityRequest<{ device_id: string }>('/notifications/devices', 'POST', { token })
    if (epoch !== registrationEpoch.current) { await communityRequest(`/notifications/devices/${result.device_id}`, 'DELETE'); return }
    if (owner.current !== user.uid) return
    try { localStorage.setItem(storageKey, result.device_id) } catch { /* Current session still supports disabling this device. */ }
    setDeviceId(result.device_id)
    await refresh()
  }

  // Only a device explicitly enabled by this account is refreshed automatically.
  useEffect(() => {
    if (!user || !deviceId || permission !== 'granted') return
    let stopped = false
    const timer = setTimeout(() => {
      if (!stopped) void registerCurrentDevice(false).catch(cause => { if (!stopped) setError(errorText(cause)) })
    }, 0)
    return () => { stopped = true; clearTimeout(timer) }
    // Token refresh runs on account/device change, not on every server-state refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, deviceId, permission])

  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const enable = () => perform(async () => { await registerCurrentDevice(true); setNotice('이 기기에 알림을 등록했습니다. 테스트 알림으로 확인해 주세요.') })
  const disable = () => perform(async () => {
    registrationEpoch.current += 1
    if (deviceId) await communityRequest(`/notifications/devices/${deviceId}`, 'DELETE')
    try { localStorage.removeItem(storageKey) } catch { /* Server removal remains authoritative. */ }
    setDeviceId(null)
    const messaging = await getMessagingInstance()
    if (messaging) await deleteToken(messaging).catch(() => false)
    await refresh()
    setNotice('이 기기의 알림을 껐습니다. 브라우저의 허용 권한은 유지됩니다.')
  })
  const test = () => perform(async () => {
    const response = await communityRequest<{ message: string }>('/notifications/test', 'POST', { device_id: deviceId })
    setNotice(response.message)
    await refresh()
  })
  const saveSettings = (settings: NotificationSettings) => perform(async () => {
    const previous = data
    if (data) setData({ ...data, settings })
    try {
      await communityRequest('/notifications/settings', 'PUT', settings)
      await refresh()
      setNotice('알림 설정을 저장했습니다.')
    } catch (cause) { setData(previous); throw cause }
  })
  const toggleWatch = (room: Room) => perform(async () => {
    if (!data) throw new Error('알림 서버에 연결한 뒤 다시 시도해 주세요.')
    const key = watchKey(room)
    const watched = data.watches.some(w => w.room_key === key)
    if (watched) await communityRequest(`/watches/${key}`, 'DELETE')
    else await communityRequest('/watches', 'POST', { corner_no: room.corner_no, room_no: key.split(':')[1] })
    await refresh()
    setNotice(watched ? '찜을 해제했습니다.' : registered ? '찜했습니다. 다음 공실 전환을 알려드릴게요.' : '찜했습니다. 알림 설정에서 이 기기의 알림을 켜 주세요.')
  })
  const removeWatch = (key: string) => perform(async () => { await communityRequest(`/watches/${key}`, 'DELETE'); await refresh() })
  return { data, permission, supported, needsInstall, registered, connected, busy, error, notice, refresh, enable, disable, test, saveSettings, toggleWatch, removeWatch }
}
const CommunityContext = createContext<ReturnType<typeof useCommunityState> | null>(null)
export function CommunityProvider({ children }: { children: React.ReactNode }) {
  const value = useCommunityState()
  return <CommunityContext.Provider value={value}>{children}</CommunityContext.Provider>
}
export function useCommunity() {
  const value = useContext(CommunityContext)
  if (!value) throw new Error('CommunityProvider is required')
  return value
}
