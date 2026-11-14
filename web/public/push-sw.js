/* DISCIPLE push alerts (lib/push.ts). Payload-less pushes: on each one, read the newest alert for this device and show
 * it. No fetch handler, so this worker never touches page loads. Registered with scope /push-sw/ by Settings. */
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let m = { title: "DISCIPLE", body: "Something happened on a rocket you follow.", url: "/logbook", id: "" };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch(`/api/push/latest?ep=${encodeURIComponent(sub.endpoint)}`, { cache: "no-store" });
        if (r.ok) m = await r.json();
      }
    } catch (e) { /* show the fallback */ }
    await self.registration.showNotification(m.title, { body: m.body, tag: m.id || undefined, icon: "/apple-touch-icon.png", badge: "/favicon-32.png", data: { url: m.url } });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) { await c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
