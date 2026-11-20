import type { BrowserHandoffOutcome } from "./browserLive";

/**
 * "Sign in again" (2026-11-20): one click from a failed automation, an answer whose sign-in handoff ended without the
 * user, or a saved sign-in in Settings › Secrets sends an ordinary turn in a chat whose text the server writes from the
 * site's host (`Message.systemTurnKind`), asking the agent to open the site and hand the browser over; the handoff and
 * its save do the rest. The turn shows as a compact chip, never as the user's own words, and authorizes nothing beyond
 * opening the site and handing it over.
 */
export const BROWSER_SIGN_IN_TURN_KIND = "browser_sign_in_request";

/** How a sign-in handoff ended without the user, which offers Sign in again on its answer. */
export const BROWSER_SIGN_IN_AGAIN_OUTCOMES = Object.freeze(["timed_out", "not_answered", "cancelled"] as const satisfies
  readonly BrowserHandoffOutcome[]);

export function browserSignInAgainOutcome(outcome: BrowserHandoffOutcome): boolean {
  return (BROWSER_SIGN_IN_AGAIN_OUTCOMES as readonly string[]).includes(outcome);
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`, "u");

/**
 * A site's host as Sign in again names it: a lower-case DNS name with at least one dot, without a scheme, port, path or
 * trailing dot (an internationalized name in its `xn--` form); null for anything else.
 */
export function normalizeBrowserSignInHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/u, "");
  return HOST.test(host) ? host : null;
}

/** The host of an http(s) page address; null when it does not parse or names no usable host. */
export function browserSignInHostFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? normalizeBrowserSignInHost(url.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * A saved browser session's host, from its file name (`mail.example.com.json`, the name a sign-in Done saves it under);
 * null for an imported file whose name is not a host.
 */
export function browserSessionSignInHost(originalName: string | null | undefined): string | null {
  if (!originalName || !originalName.toLowerCase().endsWith(".json")) return null;
  return normalizeBrowserSignInHost(originalName.slice(0, -5));
}

const TITLE_PREFIX = "Sign in again to ";

/**
 * The turn's text, the server's own: its first line names the chat a Settings request starts
 * (`lib/server/chats/titlePolicy.ts`), the rest asks the agent to open the site and hand it over.
 */
export function browserSignInRequestText(host: string): string {
  return `${TITLE_PREFIX}${host}\n\n` +
    `The user pressed Sign in again for ${host}: their saved sign-in to this site has expired or is missing. ` +
    `Open https://${host}/ in the Workspace browser (the site may send you on to its sign-in page) and call \`browser_handoff\` ` +
    "with reason `sign_in` so they can sign in there; never ask for a password or code in the chat. After Done, look at the " +
    "page and say in one sentence whether they are signed in, then stop: do nothing else on the site. After Cancel, or if " +
    "nobody comes, say in one sentence that the sign-in was not made.";
}

/** The site a turn of this kind names, for its chip; null for other text. */
export function browserSignInRequestHost(text: string): string | null {
  const firstLine = text.trimStart().split("\n", 1)[0] ?? "";
  return firstLine.startsWith(TITLE_PREFIX) ? normalizeBrowserSignInHost(firstLine.slice(TITLE_PREFIX.length)) : null;
}
