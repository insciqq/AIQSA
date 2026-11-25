import { mcpSafeFetch, networkAddressScope } from "../mcp/safeFetch";
import { withProviderTransport } from "./providerObservability";

/**
 * Gemini Google Search cites every page through a Google redirect link
 * (`https://vertexaisearch.cloud.google.com/grounding-api-redirect/…`) titled
 * with the site's domain. One bounded request to that link reads its
 * `Location` without following it, so the model and the user get the page's
 * own address: the request goes only to Google, the provider the query
 * already went to, never to the cited site (task Decisions 2026-11-26).
 *
 * Concurrency, per-request and whole-resolution bounds: a search answers in
 * 19-30 s, and resolving its sources (one TLS request each, about a second)
 * adds a few seconds at most. A link that does not resolve within them stays
 * the redirect link, which still opens the page in a browser.
 */
export const GEMINI_GROUNDING_REDIRECT_LIMITS = Object.freeze({
  concurrency: 6,
  maxUrlLength: 2_048,
  requestTimeoutMs: 3_000,
  totalTimeoutMs: 5_000
});

const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const REDIRECT_PATH_PREFIX = "/grounding-api-redirect/";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One request to a redirect link; resolves to its response without following it. */
export type GeminiGroundingRedirectFetch = (url: string, signal: AbortSignal) => Promise<Response>;

export type ResolveGeminiGroundingRedirectsOptions = Readonly<{
  fetchRedirect?: GeminiGroundingRedirectFetch;
  limits?: Partial<typeof GEMINI_GROUNDING_REDIRECT_LIMITS>;
  signal?: AbortSignal;
}>;

/** Whether a cited URL is Google's grounding redirect, the only links this module requests. */
export function isGeminiGroundingRedirect(value: string): boolean {
  if (value.length > GEMINI_GROUNDING_REDIRECT_LIMITS.maxUrlLength) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === REDIRECT_HOST && url.port === "" &&
      !url.username && !url.password && !url.hash && url.pathname.startsWith(REDIRECT_PATH_PREFIX) &&
      url.pathname.length > REDIRECT_PATH_PREFIX.length;
  } catch {
    return false;
  }
}

/**
 * The pinned SSRF-safe transport with no redirects followed (`manual` returns
 * the redirect itself), public addresses only, HTTPS only, no cookies, no
 * credentials and no body: a `HEAD`, which Google answers with the same 302 as
 * a `GET` (checked 2026-11-26).
 */
export const fetchGeminiGroundingRedirect: GeminiGroundingRedirectFetch = (url, signal) =>
  withProviderTransport(() => mcpSafeFetch(url, {
    cache: "no-store",
    credentials: "omit",
    method: "HEAD",
    redirect: "manual",
    signal
  }, {
    addressAllowed: (address) => networkAddressScope(address.address) === "public",
    allowInsecureHttp: false,
    maxRedirects: 0
  }));

/** The page a redirect response names: an `https` URL without credentials on
 * another host than the redirect service, as printable ASCII. */
function redirectTarget(response: Response, from: string, maxUrlLength: number): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (!location || location.length > maxUrlLength) return null;
  try {
    const target = new URL(location, from);
    const href = target.toString();
    return target.protocol === "https:" && !target.username && !target.password &&
      target.hostname !== REDIRECT_HOST && href.length <= maxUrlLength && /^[\x21-\x7e]+$/u.test(href)
      ? href
      : null;
  } catch {
    return null;
  }
}

/** Settles when the request does or when its bound ends, whichever is first,
 * so a transport that ignores the signal still cannot hold the search. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("gemini_grounding_redirect_aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("gemini_grounding_redirect_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A HEAD carries no body; cleanup never decides the result.
  }
}

/**
 * Each distinct grounding redirect among `urls` mapped to its page address;
 * a link that is not a redirect, fails, times out or names no `https` page is
 * left out, so the caller keeps it as cited. Never throws, and no failure
 * detail leaves this function.
 */
export async function resolveGeminiGroundingRedirects(
  urls: readonly string[],
  options: ResolveGeminiGroundingRedirectsOptions = {}
): Promise<ReadonlyMap<string, string>> {
  const limits = { ...GEMINI_GROUNDING_REDIRECT_LIMITS, ...options.limits };
  const pending = [...new Set(urls.filter(isGeminiGroundingRedirect))];
  const resolved = new Map<string, string>();
  if (pending.length === 0 || options.signal?.aborted) return resolved;

  const fetchRedirect = options.fetchRedirect ?? fetchGeminiGroundingRedirect;
  const whole = new AbortController();
  const timer = setTimeout(() => whole.abort(), limits.totalTimeoutMs);
  const onAbort = () => whole.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function resolveOne(url: string): Promise<void> {
    const request = new AbortController();
    const requestTimer = setTimeout(() => request.abort(), limits.requestTimeoutMs);
    const onWholeAbort = () => request.abort();
    whole.signal.addEventListener("abort", onWholeAbort, { once: true });
    try {
      const response = await untilAborted(fetchRedirect(url, request.signal), request.signal);
      const target = redirectTarget(response, url, limits.maxUrlLength);
      void discard(response);
      if (target) resolved.set(url, target);
    } catch {
      // Kept as the redirect link.
    } finally {
      clearTimeout(requestTimer);
      whole.signal.removeEventListener("abort", onWholeAbort);
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length && !whole.signal.aborted) {
      const url = pending[next]!;
      next += 1;
      await resolveOne(url);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, pending.length) }, worker));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  return resolved;
}
