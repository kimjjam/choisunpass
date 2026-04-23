/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// 푸시 알림 수신
self.addEventListener('push', (event) => {
  if (!event.data) return

  const data = event.data.json() as { title: string; body?: string; url?: string }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body ?? '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      requireInteraction: false,
      data: { url: data.url ?? '/attend' },
    })
  )
})

// 알림 클릭 시 해당 페이지 열기
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string })?.url ?? '/attend'
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return (client as WindowClient).navigate(url).then(c => c?.focus())
      }
      return self.clients.openWindow(url)
    })
  )
})
