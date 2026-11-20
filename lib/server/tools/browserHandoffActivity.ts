import { BROWSER_HANDOFF_OUTCOMES, type BrowserHandoffOutcome } from "../../contracts/browserLive";
import { browserSignInHostFromUrl } from "../../contracts/browserSignIn";
import type { ThreadBrowserHandoffFacts } from "../../contracts/chats";
import { BROWSER_HANDOFF_SIGN_IN_REASONS, BROWSER_HANDOFF_TOOL_NAME } from "./browserHandoff";

const SIGN_IN_REASONS: ReadonlySet<string> = new Set<string>(BROWSER_HANDOFF_SIGN_IN_REASONS);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The browser-safe facts of a `browser_handoff` call that asked the user to sign in (a sign-in, a code or a check) and
 * ended: its outcome and the host of the page the browser showed then, from the call's own stored result, which only
 * the server writes. The answer offers Sign in again on them (`lib/contracts/browserSignIn.ts`); never the page's path,
 * title or anything the user typed.
 */
export function browserHandoffActivityFacts(toolName: string, argumentsValue: unknown, result: unknown):
  { browserHandoff?: ThreadBrowserHandoffFacts } {
  if (toolName !== BROWSER_HANDOFF_TOOL_NAME || !isRecord(argumentsValue) || typeof argumentsValue.reason !== "string" ||
    !SIGN_IN_REASONS.has(argumentsValue.reason)) return {};
  const content = isRecord(result) && Array.isArray(result.content) ? result.content as unknown[] : [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "json" || !isRecord(part.value)) continue;
    const { outcome, page } = part.value;
    if (typeof outcome !== "string" || !(BROWSER_HANDOFF_OUTCOMES as readonly string[]).includes(outcome)) continue;
    const host = isRecord(page) ? browserSignInHostFromUrl(page.url) : null;
    return host ? { browserHandoff: { host, outcome: outcome as BrowserHandoffOutcome } } : {};
  }
  return {};
}
