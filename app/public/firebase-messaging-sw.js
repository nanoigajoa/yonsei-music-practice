/* Native Push API: one handler for foreground/background, without duplicate Firebase display. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('push', event => {
  let payload
  try { payload = event.data?.json() ?? {} } catch { return }
  const data = payload.data ?? {}
  const title = data.title ?? payload.notification?.title ?? '음대 연습실'
  const body = data.body ?? payload.notification?.body ?? ''
  const rawUrl = data.url ?? data.click_action ?? '/alarm'
  let url = new URL('/alarm', self.location.origin)
  try { const candidate = new URL(rawUrl, self.location.origin); if (candidate.origin === self.location.origin) url = candidate } catch { /* same-origin fallback */ }
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, { body, tag: data.notification_id ?? payload.fcmMessageId, data: { url: url.href }, icon: '/icons/icon-192x192.png', badge: '/icons/icon-96x96.png' }),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.forEach(client => client.postMessage({ type: 'PRACTICE_PUSH', title }))),
  ]))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin)
  const url = target.origin === self.location.origin ? target.href : self.location.origin
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    const client = list.find(item => new URL(item.url).origin === self.location.origin)
    if (client) { await client.navigate(url); return client.focus() }
    return self.clients.openWindow(url)
  }))
})
