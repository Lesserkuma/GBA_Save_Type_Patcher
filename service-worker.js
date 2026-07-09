self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isSameOriginJavaScript = url.origin === self.location.origin && url.pathname.endsWith(".js");
  const isDocumentNavigation = url.origin === self.location.origin && event.request.mode === "navigate";

  if (!isSameOriginJavaScript && !isDocumentNavigation) return;

  event.respondWith(fetch(event.request, { cache: "no-store" }));
});
