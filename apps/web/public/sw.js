// Web Push only (081 D11): no fetch handler and no caching, so deploys never serve a stale app shell.

const FALLBACK_TITLE = 'OpenAIdom';
// Fixed text (081 D5). The server payload never supplies the body, so message text cannot reach a notification.
const NOTIFICATION_BODY = 'You have a new message';
const APP_ORIGIN = self.location.origin;
const APP_ROOT = '/';

function notificationTitle(payload) {
  const title = payload && typeof payload.title === 'string' ? payload.title.trim() : '';
  return title === '' ? FALLBACK_TITLE : title.slice(0, 120);
}

/** Only same-origin targets are opened. Anything else, including protocol-relative URLs, goes to the app root. */
function safeTargetUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return APP_ROOT;
  let url;
  try {
    url = new URL(raw, APP_ORIGIN);
  } catch {
    return APP_ROOT;
  }
  if (url.origin !== APP_ORIGIN) return APP_ROOT;
  return url.pathname + url.search + url.hash;
}

function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

// Every push shows a visible notification. Silent pushes are not allowed (080 non-goals).
self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(notificationTitle(payload), {
      body: NOTIFICATION_BODY,
      data: { url: safeTargetUrl(payload?.url) },
    }),
  );
});

async function focusOrOpen(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => {
    try {
      return new URL(client.url).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  });
  if (!existing) {
    await self.clients.openWindow(target);
    return;
  }
  try {
    await existing.focus();
    await existing.navigate(target);
  } catch {
    await self.clients.openWindow(target);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeTargetUrl(event.notification.data ? event.notification.data.url : undefined);
  event.waitUntil(focusOrOpen(target));
});
