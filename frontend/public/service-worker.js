self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { body: event.data?.text() ?? "Your order is ready to collect." }; }
  event.waitUntil(self.registration.showNotification(message.title || "Your order is ready to collect!", {
    body: message.body || "Show your pickup number at the canteen counter.",
    icon: "/cedarbite-icon.svg",
    badge: "/cedarbite-icon.svg",
    tag: message.tag || "cedarbite-order-ready",
    data: { url: message.url || "/my-orders" },
    renotify: true,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/my-orders", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});
