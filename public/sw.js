/*
 * AIQSA service worker: shows browser push notifications and opens their chat.
 * It caches nothing and handles no fetches. Messages are content-free
 * ({ v, title, body, tag, url }) and `url` is always a same-origin path.
 *
 * Every push shows its notification. Safari revokes a subscription after a
 * few pushes that show none, and installed web apps on iPhone report their
 * windows unreliably, so the server instead skips the device whose page
 * reported showing the answer.
 */

function pushMessage(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (!data || data.v !== 1 || typeof data.title !== "string" || typeof data.body !== "string" ||
      typeof data.tag !== "string" || typeof data.url !== "string") return null;
    const url = new URL(data.url, self.location.origin);
    if (url.origin !== self.location.origin) return null;
    return { body: data.body, tag: data.tag, title: data.title, url };
  } catch {
    return null;
  }
}

/** A window shows the target when the path matches and, for a target with a query (a Control Center section), the query too. */
function shows(client, target) {
  try {
    const url = new URL(client.url);
    return url.pathname === target.pathname && (!target.search || url.search === target.search);
  } catch {
    return false;
  }
}

async function showPush(event) {
  const message = pushMessage(event);
  if (!message) {
    // Browsers require a visible notification for every push.
    await self.registration.showNotification("AIQSA", { body: "Something finished in AIQSA.", tag: "aiqsa" });
    return;
  }
  await self.registration.showNotification(message.title, {
    badge: "/icon-192.png",
    body: message.body,
    data: { url: `${message.url.pathname}${message.url.search}` },
    icon: "/icon-192.png",
    tag: message.tag
  });
}

async function openTarget(path) {
  const target = new URL(typeof path === "string" ? path : "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const showing = windows.find((client) => shows(client, target));
  // Another open window keeps its own chat and draft; the target opens beside it.
  if (showing) await showing.focus();
  else await self.clients.openWindow(target.href);
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openTarget(event.notification.data && event.notification.data.url));
});
