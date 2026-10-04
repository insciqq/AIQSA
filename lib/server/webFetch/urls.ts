import { createHash } from "node:crypto";
import { domainToUnicode } from "node:url";
import { FETCH_URL_TARGET_MAX_LENGTH } from "../../contracts/fetchUrlActivity";

/**
 * Page addresses for `fetch_url`: one comparison form for provenance and
 * transport, digests for frozen authority, and the display form of activity.
 * Pure helpers; no I/O.
 */
export const FETCH_URL_MAX_LENGTH = 2_048;
/** URLs one text contributes; beyond it the newest text wins at the caller. */
const URLS_PER_TEXT = 200;
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", "\"", "»", "”", "’", "。", "，", "、", "…"]);
const CLOSER_OF: ReadonlyMap<string, string> = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
/** The longest raw text normalization accepts; trailing punctuation included. */
const CANDIDATE_MAX_LENGTH = FETCH_URL_MAX_LENGTH * 3;

/**
 * The comparison and request form of a page URL, or null: a WHATWG-parsed
 * http(s) URL with lowercase scheme and host, an IDNA (punycode) host, the
 * default port dropped, the fragment removed and percent escapes in upper
 * case. Userinfo and other ports are kept, so the transport refuses them with
 * their own codes instead of treating them as a different address.
 */
export function normalizeFetchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CANDIDATE_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  url.hash = "";
  const normalized = url.href.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
  return normalized.length <= FETCH_URL_MAX_LENGTH ? normalized : null;
}

/** The frozen authority form of a normalized URL: its SHA-256, hex. */
export function fetchUrlDigest(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
}

export function isFetchUrlDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/**
 * Drops prose punctuation and unbalanced closing brackets after a URL. The
 * bracket balance is counted once and kept as characters leave, so the work
 * stays linear in the candidate.
 */
function trimTrailing(candidate: string): string {
  const unbalanced = new Map([[")", 0], ["]", 0], ["}", 0]]);
  for (const character of candidate) {
    const closer = CLOSER_OF.get(character);
    if (unbalanced.has(character)) unbalanced.set(character, unbalanced.get(character)! + 1);
    else if (closer) unbalanced.set(closer, unbalanced.get(closer)! - 1);
  }
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1]!;
    const excess = unbalanced.get(last) ?? 0;
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
    } else if (excess > 0) {
      unbalanced.set(last, excess - 1);
      end -= 1;
    } else {
      break;
    }
  }
  return candidate.slice(0, end);
}

/**
 * The normalized http(s) URLs written in one text, in order of appearance and
 * without duplicates. Only explicit `http://` and `https://` addresses count;
 * a bare domain is not a URL the user supplied.
 */
export function extractFetchUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    // Longer candidates cannot normalize to an allowed URL; skip them before any work.
    if (match[0].length > CANDIDATE_MAX_LENGTH) continue;
    const normalized = normalizeFetchUrl(trimTrailing(match[0]));
    if (normalized) found.add(normalized);
    if (found.size >= URLS_PER_TEXT) break;
  }
  return [...found];
}

/** Digests of every URL the texts contain, deduplicated, at most `limit`, earlier texts first. */
export function fetchUrlDigestsOf(texts: readonly string[], limit: number): string[] {
  const digests = new Set<string>();
  for (const text of texts) {
    for (const url of extractFetchUrls(text)) {
      if (digests.size >= limit) return [...digests];
      digests.add(fetchUrlDigest(url));
    }
  }
  return [...digests];
}

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * The activity row's "host/path" for a URL: the Unicode host and decoded path
 * without scheme, query or fragment, bounded with an ellipsis. Null when the
 * value is no http(s) URL.
 */
export function fetchUrlDisplayTarget(value: unknown): string | null {
  const normalized = normalizeFetchUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = domainToUnicode(url.hostname) || url.hostname;
  const path = url.pathname === "/" ? "" : decodedPath(url.pathname);
  const target = `${host}${url.port ? `:${url.port}` : ""}${path}`.replace(/[\u0000-\u001f\u007f\s]+/gu, " ");
  return target.length > FETCH_URL_TARGET_MAX_LENGTH ? `${target.slice(0, FETCH_URL_TARGET_MAX_LENGTH - 1)}…` : target;
}
