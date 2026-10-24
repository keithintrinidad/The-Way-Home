// The Way Home — service worker tuned for low-connectivity spaces (churches, basements, weak signal).
//
// Strategy:
// - App shell (page, manifest, icons): served from cache instantly; refreshed quietly in the
//   background when the network allows (stale-while-revalidate). Startup never waits on the network.
// - Google Fonts: cache-first; precached best-effort at install. If unavailable, the app falls back
//   to system serif/sans fonts. Never blocks rendering.
// - Every network attempt is capped by a timeout so a weak signal can't stall the app.
// - Navigations always resolve to the cached page, whatever query string or path variant is used.
//
// Only the app's own files and fonts are cached. Your journey, notes and saints are never stored here.

const VERSION = 'wayhome-v1';
const SHELL_CACHE = VERSION + '-shell';
const FONT_CACHE = 'wayhome-fonts-v1';           // kept across app versions so fonts aren't refetched
const CORE = ['./', './index.html', './app.webmanifest'];
const EXTRAS = ['./icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Source+Sans+3:wght@400;600&display=swap';
const NET_TIMEOUT = 4000;   // ms before giving up on the network for a background or uncached fetch

function fetchWithTimeout(request, ms = NET_TIMEOUT, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Cache one URL, retrying once; returns true on success.
async function cacheOne(cache, url, ms = 15000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(new Request(url, { cache: 'reload' }), ms);
      if (res.ok) { await cache.put(url, res); return true; }
    } catch (_) {}
  }
  return false;
}

async function precacheFonts() {
  try {
    const cache = await caches.open(FONT_CACHE);
    if (await cache.match(FONT_CSS)) return;
    const res = await fetchWithTimeout(FONT_CSS, 15000);
    if (!res.ok) return;
    const css = await res.clone().text();
    await cache.put(FONT_CSS, res);
    const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
    await Promise.allSettled(urls.map(u => fetchWithTimeout(u, 15000, { mode: 'cors' }).then(r => r.ok && cache.put(u, r))));
  } catch (_) { /* fonts are optional */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Core files must succeed (with generous timeouts and a retry) for the install to complete.
    const core = await Promise.all(CORE.map(u => cacheOne(cache, u)));
    if (core.includes(false)) throw new Error('Core files unavailable; will retry install later');
    // Icons and fonts are best-effort: a slow connection mustn't block installation.
    await Promise.allSettled(EXTRAS.map(u => cacheOne(cache, u)));
    precacheFonts();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // All the apps share one origin (keithintrinidad.github.io), so only remove this app's own old caches
    await Promise.all(keys.filter(k => k.startsWith('wayhome-') && k !== SHELL_CACHE && k !== FONT_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Serve from cache now; refresh the cached copy in the background if the network cooperates.
async function staleWhileRevalidate(event, cacheKey) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  const refresh = fetchWithTimeout(event.request, cached ? 10000 : NET_TIMEOUT)
    .then(res => { if (res.ok) cache.put(cacheKey, res.clone()); return res; })
    .catch(() => null);
  if (cached) { event.waitUntil(refresh); return cached; }
  return (await refresh) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function navigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match('./index.html')) || (await cache.match('./'));
  const refresh = fetchWithTimeout(event.request, cached ? 10000 : NET_TIMEOUT)
    .then(res => { if (res.ok && res.type === 'basic') cache.put('./index.html', res.clone()); return res; })
    .catch(() => null);
  if (cached) { event.waitUntil(refresh); return cached; }
  return (await refresh) || new Response('<h1>The Way Home</h1><p>You appear to be offline. Open The Way Home once with a connection so it can be saved for offline use.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function fonts(event) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(event.request);
    if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
    return res;
  } catch (_) {
    // Fail fast and quietly: the page falls back to system fonts.
    return new Response('', { status: 503 });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fonts(event));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigation(event));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, req));
});
