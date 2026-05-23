importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey:            'AIzaSyBahgCa3UCxC4zoRiP2bgJ9lwh-x8riz9A',
  authDomain:        'yoneum-a8160.firebaseapp.com',
  projectId:         'yoneum-a8160',
  storageBucket:     'yoneum-a8160.firebasestorage.app',
  messagingSenderId: '826339630714',
  appId:             '1:826339630714:web:5b9a2fe4baaac34f3a25c3',
})

const messaging = firebase.messaging()

messaging.onBackgroundMessage((payload) => {
  const { title, body, icon } = payload.notification ?? {}
  self.registration.showNotification(title ?? '연습실 알림', {
    body:  body ?? '',
    icon:  icon ?? '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    data:  payload.data,
  })
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.click_action ?? '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow(url)
    }),
  )
})
