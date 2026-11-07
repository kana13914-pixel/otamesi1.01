// フェーズ0用の最小Service Worker。オフラインでも画面が開けるよう、静的ファイルをキャッシュする。
// ファイルを更新したら CACHE_VERSION を上げること（古いキャッシュが残るのを防ぐ）。
const CACHE_VERSION = 'phase0-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './audio/test-chime.wav',
  './send.html',
  './send.js',
  './settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先、失敗時はキャッシュ。検証中は最新ファイルを優先したいため。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return; // 送信サーバー等の外部APIはキャッシュしない
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

// ---- Web Push ----
// 送信サーバー（worker/worker.js）から {title, body, url} が届く
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (_) { msg = { body: event.data && event.data.text() }; }
  const url = msg.url || new URL('index.html?source=webpush', self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(msg.title || 'キィニチくん', {
      body: msg.body || '',
      icon: 'icons/icon-192.png',
      tag: 'kiinichi-phase0',
      data: { url },
    })
  );
});

// 通知タップ：開いている画面があれば前面に出して移動、なければホーム画面のアプリとして開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || new URL('index.html?source=webpush', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if ('navigate' in c) await c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
