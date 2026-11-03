import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

const MAX_COOKIE_BYTES = 4_096;
const MAX_JAR_BYTES = 8_192;
const MAX_COOKIES = 32;
const MAX_RESPONSE_COOKIES = 64;

type Cookie = Readonly<{
  name: string;
  value: string;
  domain: string;
  site: string | null;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires: number;
  bytes: number;
}>;

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function defaultPath(url: URL): string {
  return url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
}

function parseCookie(raw: string, origin: URL, now: number): Cookie | null {
  // Bound before splitting; cookie values remain opaque ASCII and never become errors.
  if (raw.length > MAX_COOKIE_BYTES || Buffer.byteLength(raw) > MAX_COOKIE_BYTES || /[\x00-\x1f\x7f]/u.test(raw)) return null;
  const [pair, ...attributes] = raw.split(";");
  const equal = pair!.indexOf("=");
  if (equal < 1) return null;
  const name = pair!.slice(0, equal).trim();
  const value = pair!.slice(equal + 1).trim();
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(unquoted)) return null;
  let domain = origin.hostname;
  const site = getDomain(origin.hostname, { allowPrivateDomains: true });
  let hostOnly = true;
  let path = defaultPath(origin);
  let explicitRootPath = false;
  let secure = false;
  let expires = Infinity;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const content = separator < 0 ? "" : attribute.slice(separator + 1).trim();
    if (key === "domain") {
      const candidate = domainToASCII(content.replace(/^\./u, "")).toLowerCase();
      // Public AND private suffixes are boundaries; an IP or unknown site stays host-only.
      if (!candidate || candidate.endsWith(".") || isIP(candidate) || !site ||
        !domainMatches(origin.hostname, candidate) || getDomain(candidate, { allowPrivateDomains: true }) !== site) return null;
      domain = candidate;
      hostOnly = false;
    } else if (key === "path" && content.startsWith("/")) {
      path = content;
      explicitRootPath = content === "/";
    } else if (key === "secure") secure = true;
    else if (key === "max-age" && /^-?\d+$/u.test(content)) maxAge = Number(content);
    else if (key === "expires") {
      const date = Date.parse(content);
      if (Number.isFinite(date)) expires = date;
    }
  }
  if (maxAge !== undefined) expires = maxAge <= 0 ? 0 : Math.min(now + maxAge * 1000, 8.64e15);
  if (secure && origin.protocol !== "https:") return null;
  if (name.startsWith("__Secure-") && !secure) return null;
  if (name.startsWith("__Host-") && (!secure || !hostOnly || !explicitRootPath)) return null;
  return { name, value, domain, site, hostOnly, path, secure, expires,
    bytes: Buffer.byteLength(`${name}=${value}; ${domain}; ${site ?? ""}; ${path}`) };
}

/** One redirect chain only. Private fields cannot leak through JSON or error inspection. */
export class RedirectCookieJar {
  #cookies: Cookie[] = [];

  store(origin: URL, headers: Headers, now = Date.now()): void {
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires > now);
    // getSetCookie preserves Expires commas and separate Set-Cookie fields.
    for (const raw of headers.getSetCookie().slice(0, MAX_RESPONSE_COOKIES)) {
      const cookie = parseCookie(raw, origin, now);
      if (!cookie || cookie.bytes > MAX_JAR_BYTES) continue;
      if (origin.protocol !== "https:" && this.#cookies.some((old) => old.secure && old.name === cookie.name &&
        (domainMatches(old.domain, cookie.domain) || domainMatches(cookie.domain, old.domain)))) continue;
      const index = this.#cookies.findIndex((old) => old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path);
      if (index >= 0) this.#cookies.splice(index, 1);
      if (cookie.expires <= now) continue;
      while (this.#cookies.length >= MAX_COOKIES || this.#cookies.reduce((bytes, entry) => bytes + entry.bytes, 0) + cookie.bytes > MAX_JAR_BYTES) {
        this.#cookies.shift();
      }
      this.#cookies.push(cookie);
    }
  }

  header(target: URL, now = Date.now()): string | null {
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires > now);
    const site = getDomain(target.hostname, { allowPrivateDomains: true });
    const matches = this.#cookies.filter((cookie) => {
      if (cookie.secure && target.protocol !== "https:") return false;
      if (cookie.hostOnly ? target.hostname !== cookie.domain : !domainMatches(target.hostname, cookie.domain)) return false;
      if (site !== cookie.site) return false;
      return target.pathname === cookie.path || (target.pathname.startsWith(cookie.path) &&
        (cookie.path.endsWith("/") || target.pathname[cookie.path.length] === "/"));
    });
    return matches.sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") || null;
  }

  clear(): void {
    this.#cookies = [];
  }
}
