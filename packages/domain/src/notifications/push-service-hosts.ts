/**
 * Browser push services the server may post to (081 W6). Owner confirmation is tracked in 081 Outstanding Issues.
 * `exact` matches the whole host name. `suffixes` match a host that ends with the suffix at a label boundary.
 */
export const ALLOWED_PUSH_SERVICE_HOSTS = {
  exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'],
  suffixes: ['.push.apple.com', '.notify.windows.com'],
};

/** Expects a lowercase host name without a trailing dot, as returned by `URL.hostname`. */
export function isAllowedPushServiceHost(hostname: string): boolean {
  if (ALLOWED_PUSH_SERVICE_HOSTS.exact.some((host) => host === hostname)) return true;
  return ALLOWED_PUSH_SERVICE_HOSTS.suffixes.some((suffix) => hostname.endsWith(suffix));
}
