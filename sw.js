/**
 * 寻穴 AcuPoint AR —— Service Worker
 * 策略：
 *  - App 壳（页面/JS/CSS/图标）：网络优先，失败回退缓存（保证发版新鲜度 + 离线可用）
 *  - 大文件（AI 模型 .task / WASM 运行时）：缓存优先，首次用到即缓存（约 60MB，装一次永久离线）
 * 版本号变更即整体换缓存。
 */
const VERSION = 'v1.1.0';
const CACHE = `acupoint-ar-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/data.js',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 网络优先 + 缓存回退（App 壳） */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match('./index.html');
      if (index) return index;
    }
    throw err;
  }
}

/** 缓存优先 + 运行时回填（模型/WASM，体积大且随版本不变） */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html');
  e.respondWith(isDoc || isCode ? networkFirst(req) : cacheFirst(req));
});
