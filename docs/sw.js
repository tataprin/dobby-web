// Dobby service worker (SPEC 9.7). It handles ONLY `push` and `notificationclick`.
// There is deliberately no `fetch` handler and no cache: every request goes to the network exactly as without a service
// worker, so the content-hash file addresses in index.html (tools/stamp_versions.py) stay the only cache rule.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Payload from the Edge Function `notify`: {title, body, tag, url, event, bot_id, ts} (also accepted: {notification: {...}}
// or plain text).
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { body: event.data.text() }; }
  }
  if (data && data.notification && typeof data.notification === 'object') data = { ...data.notification, ...data, notification: undefined };
  const title = data.title || 'Dobby';
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    lang: 'th',
    timestamp: data.ts && Number.isFinite(Date.parse(data.ts)) ? Date.parse(data.ts) : undefined,
    data: { url: data.url || './#/dashboard', event: data.event, bot_id: data.bot_id },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Open (or focus) the website at the page the notification points to.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        try { if ('navigate' in c) await c.navigate(target); } catch (e) { /* cross-origin or not controlled */ }
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
