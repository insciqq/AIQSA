import { expect, type Page } from "@playwright/test";

/**
 * Shared pieces of the Sign in again specs (`lib/contracts/browserSignIn.ts`): a record of the message sends a page
 * makes, and the chip the server-written turn shows as in the chat.
 */

export type MessagePost = Readonly<{ body: Record<string, unknown>; path: string }>;

type MessagePostWindow = typeof window & { __messagePosts?: MessagePost[] };

/**
 * Records the body of every message send before passing it on. Install it after the gated run streams, so it wraps
 * them: their `fetch` answers the send in the page, and `page.route` never sees it.
 */
export async function recordMessagePosts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorder = window as MessagePostWindow;
    recorder.__messagePosts = [];
    const passOn = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const path = new URL(url, window.location.href).pathname;
      if (method === "POST" && /^\/api\/chats\/[^/]+\/messages$/u.test(path) && typeof init?.body === "string") {
        recorder.__messagePosts!.push({ body: JSON.parse(init.body) as Record<string, unknown>, path });
      }
      return passOn(input, init);
    };
  });
}

export function messagePosts(page: Page): Promise<MessagePost[]> {
  return page.evaluate(() => [...((window as MessagePostWindow).__messagePosts ?? [])]);
}

/** The server-written Sign in again turns of the open chat, oldest first. */
export function signInChips(page: Page) {
  return page.getByRole("article", { name: "Sign in again", exact: true });
}

/**
 * The send a Sign in again made: one message send to `chatId` naming the site and the turn's kind, never words of its
 * own as the user's; the chat shows it as the chip naming the site, never the request's text.
 */
export async function expectSignInRequestSent(page: Page, chatId: string, host: string): Promise<void> {
  await expect.poll(async () => (await messagePosts(page)).length).toBe(1);
  const [post] = await messagePosts(page);
  expect(post!.path).toBe(`/api/chats/${chatId}/messages`);
  expect(post!.body.systemTurn).toEqual({ host, kind: "browser_sign_in_request" });
  const chip = signInChips(page).last();
  await expect(chip).toHaveText(`Sign in again: ${host}`);
  await expect(chip).toHaveAttribute("data-system-turn", "browser_sign_in_request");
  await expect(page.getByText("The user pressed Sign in again")).toHaveCount(0);
  const [box, viewport] = await Promise.all([chip.locator(".v2-system-turn-chip").boundingBox(), page.viewportSize()]);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}
