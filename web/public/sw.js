// Minimal service worker: exists to make the app installable and to receive
// Web Push while no tab is open. Deliberately does NOT cache the app shell
// for offline use — that's a separate, larger commitment (cache
// invalidation across deploys, handling the API being unreachable) that
// isn't part of this phase. See CLAUDE.md.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "New message", body: "" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload — fall back to the default title/body above.
  }

  const url = data.conversationId ? `/chat/${data.conversationId}` : "/chat";
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.conversationId ? `conversation-${data.conversationId}` : undefined,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/chat";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing tab and navigate it rather than always opening a
      // new one — a user with the app already open shouldn't accumulate tabs
      // every time a notification arrives.
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
