self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || "OnlySubs";
  const options = {
    body: payload.body || "There's an update for your game.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/", requestId: payload.requestId || null },
    actions: Array.isArray(payload.actions) ? payload.actions : [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  if (target.origin !== self.location.origin) return;

  if (
    event.action &&
    ["accept", "pass"].includes(event.action) &&
    event.notification.data?.requestId
  ) {
    event.waitUntil(
      fetch(
        `/api/sub-requests/${event.notification.data.requestId}/respond`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: event.action }),
        },
      )
        .then(async (response) => {
          const result = await response.json();
          const windows = await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          });
          for (const client of windows) {
            client.postMessage({
              type: "sub-request-response",
              ok: response.ok,
              result,
            });
            if (response.ok) await client.focus();
          }
          if (!windows.length || !response.ok) {
            await self.clients.openWindow(target.href);
          }
          if (!response.ok) {
            await self.registration.showNotification("OnlySubs", {
              body: result.error || "Could not respond to the sub request.",
              icon: "/icon-192.png",
            });
          }
        })
        .catch(() =>
          self.registration.showNotification("OnlySubs", {
            body: "Could not respond. Open OnlySubs to try again.",
            icon: "/icon-192.png",
          }),
        ),
    );
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clients) => {
        const existing = clients.find((client) => client.url.startsWith(self.location.origin));
        if (existing) return existing.navigate(target.href).then(() => existing.focus());
        return self.clients.openWindow(target.href);
      },
    ),
  );
});
