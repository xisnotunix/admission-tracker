/* Service worker: сайт открывается без интернета.
   - data/*.json и сама страница — сначала сеть, при ошибке — кэш (ответ помечается заголовком X-From-Cache);
   - статика (js, css, иконки) — сразу из кэша, параллельно обновляется из сети (stale-while-revalidate),
     поэтому новые версии подхватываются со следующего открытия без ручной смены версии.
   Запросы на другие сайты (Gemini, GitHub API, официальные сайты) не трогаем. */
const CACHE = "tracker-v1";
const PRECACHE = [
  "./", "index.html", "manifest.webmanifest", "assets/app.js", "assets/style.css",
  "assets/icon.svg", "assets/icon-192.png", "assets/icon-512.png",
  "data/programs.json", "data/changelog.json", "data/state.json", "data/sources.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheKey(request) {
  const url = new URL(request.url);
  url.search = "";  // ?t=… от app.js не должен плодить записи в кэше
  return url.href;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) cache.put(cacheKey(request), response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey(request)) || (request.mode === "navigate" && await cache.match(new URL("./", self.registration.scope).href));
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set("X-From-Cache", cached.headers.get("date") || "1");
    return new Response(await cached.blob(), { status: 200, headers });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey(request));
  const fresh = fetch(request).then((response) => {
    if (response.ok) cache.put(cacheKey(request), response.clone());
    return response;
  }).catch(() => cached);
  return cached || fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const path = new URL(request.url).pathname;
  if (request.mode === "navigate" || path.includes("/data/")) event.respondWith(networkFirst(request));
  else event.respondWith(staleWhileRevalidate(request));
});
