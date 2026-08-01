export const PUBLIC_SHARE_CACHE_CONTROL = "private, no-store, max-age=0";
export const PUBLIC_SHARE_ROBOTS_POLICY = "noindex, nofollow, noarchive";

export function applyPublicSharePrivacyHeaders(headers: Headers): void {
  headers.set("Cache-Control", PUBLIC_SHARE_CACHE_CONTROL);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", PUBLIC_SHARE_ROBOTS_POLICY);
}
