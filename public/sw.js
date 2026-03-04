// Service Worker Kill Switch - 모든 캐시를 삭제하고 자기 자신을 등록 해제함
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => {
      return self.registration.unregister();
    })
  );
});

// 모든 요청을 네트워크로 직접 보냄 (캐시 우회, 원본 요청 그대로 전달)
self.addEventListener('fetch', (e) => {
  // Do nothing. This ensures the browser handles the request natively.
});
