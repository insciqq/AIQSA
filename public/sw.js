/*
 * AIQSA service worker: shows browser push notifications and opens their chat.
 * It caches nothing and handles no fetches. Messages are content-free
 * ({ v, title, body, tag, url }) and `url` is always a same-origin path.
 */

const CHAT_PATH = /^\/c\/[^/]+$/u;

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

function pathOf(client) {
  try {
    return new URL(client.url).pathname;
  } catch {
    return "";
  }
}

/*
 * A focused window already showing this chat needs no notification. Chat ids
 * are unique across accounts and a signed-out session has no subscription
 * left, so a window of another account can never match.
 */
async function chatOnScreen(url) {
  if (!CHAT_PATH.test(url.pathname)) return false;
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  return windows.some((client) => client.focused && client.visibilityState === "visible" && pathOf(client) === url.pathname);
}

async function showPush(event) {
  const message = pushMessage(event);
  if (!message) {
    // Browsers require a visible notification for every push.
    await self.registration.showNotification("AIQSA", { body: "Something finished in AIQSA.", tag: "aiqsa" });
    return;
  }
  if (await chatOnScreen(message.url)) return;
  await self.registration.showNotification(message.title, {
    badge: "/icon-192.png",
    body: message.body,
    data: { url: message.url.pathname },
    icon: "/icon-192.png",
    tag: message.tag
  });
}

async function openTarget(path) {
  const target = new URL(typeof path === "string" ? path : "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const showing = windows.find((client) => pathOf(client) === target.pathname);
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
