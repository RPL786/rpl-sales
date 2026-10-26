/* RPL Sales service worker: lets the app open without signal and installs it like an app.
   API calls are never cached (data must be live); visits made offline are queued by the app itself. */
const CACHE = "rpl-sales-shell-v1";
const SHELL = ["/", "/index.html", "/logo.png", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const API_PREFIXES = ["/api", "/login", "/register", "/dashboard", "/form", "/data", "/forecast", "/admin", "/upload", "/reset", "/salesperson-insights", "/health"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/") || url.pathname.startsWith(p + "?"))) return;

  // Built files have content hashes in their names: cache-first is safe.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
      )
    );
    return;
  }

  // Pages: always try the network first so a new release shows up, fall back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put("/index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});
