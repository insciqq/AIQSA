import { create } from "zustand";

/**
 * A Sign in again pressed outside the chat it goes to (Settings › Automations or Secrets): the chat to send it in
 * (`null`: the new chat Settings opens) and the site. Settings opens that chat and records the request; the shell sends
 * it once that chat is the open one and loaded (`PowerAppShellV2`). A request the shell never reaches in time is
 * dropped, so a later visit to that chat never sends it unasked.
 */
export type BrowserSignInRequest = Readonly<{ chatId: string | null; host: string; requestedAt: number }>;

/** How long a request waits for its chat to open before it is dropped. */
export const BROWSER_SIGN_IN_REQUEST_TTL_MS = 15_000;

type BrowserSignInRequestState = { request: BrowserSignInRequest | null };

export const useBrowserSignInRequestStore = create<BrowserSignInRequestState>(() => ({ request: null }));

export function requestBrowserSignIn(chatId: string | null, host: string, now: number = Date.now()): void {
  useBrowserSignInRequestStore.setState({ request: { chatId, host, requestedAt: now } });
}

/**
 * The request for the chat now open, taken once; null while the open chat is another, and a stale request is dropped.
 */
export function takeBrowserSignInRequest(activeChatId: string | null, now: number = Date.now()): string | null {
  const request = useBrowserSignInRequestStore.getState().request;
  if (!request) return null;
  if (now - request.requestedAt > BROWSER_SIGN_IN_REQUEST_TTL_MS) {
    useBrowserSignInRequestStore.setState({ request: null });
    return null;
  }
  if (request.chatId !== activeChatId) return null;
  useBrowserSignInRequestStore.setState({ request: null });
  return request.host;
}
