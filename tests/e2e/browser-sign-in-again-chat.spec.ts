import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { browserSignInRequestText } from "../../lib/contracts/browserSignIn";
import type { ChatMessageWire, ThreadToolActivity } from "../../lib/contracts/chats";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectSignInRequestSent, messagePosts, recordMessagePosts, signInChips } from "./support/browserSignInFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Sign in again under an answer whose sign-in handoffs ended without the user, on a synthetic chat: one row per site
 * worded by how its handoff ended, and its button sends the server-written request in this chat, which shows as a chip
 * naming the site, never as the user's words, and leaves the composer's draft alone. An earlier request of the chat
 * shows as the same chip after a reload. The chat comes from routed fixtures and the send from the gated stream; no
 * provider is involved.
 */

const chatId = "sign-in-again-chat";
const timestamp = "2026-11-20T09:00:00.000Z";
const answerId = "sign-in-again-answer";

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false, theme: "light" },
  { name: "tablet", width: 820, height: 1180, touch: true, theme: "light" },
  { name: "phone", width: 390, height: 844, touch: true, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark" }
] as const;

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: timestamp, status: "complete", citationMessageId: null, errorMessage: null,
    modelId: role === "assistant" ? "gpt-5.5" : null, modelRunId: role === "assistant" ? `${id}-run` : null,
    provider: role === "assistant" ? "openai" : null, ...extra };
}

/** Two sign-in handoffs that ended without the user: nobody came to the mail site, the shop's was cancelled. */
const endedHandoffs: ThreadToolActivity = { calls: [
  { origin: "tool", toolName: "browser_handoff", round: 1, status: "complete", durationMs: 120_000,
    browserHandoff: { host: "mail.example.com", outcome: "not_answered" } },
  { origin: "tool", toolName: "browser_handoff", round: 2, status: "complete", durationMs: 40_000,
    browserHandoff: { host: "shop.example", outcome: "cancelled" } }
] };

/** An earlier Sign in again that worked, then a question whose answer could not sign in to either site. */
const messages: ChatMessageWire[] = [
  message("sign-in-request-1", "user", browserSignInRequestText("portal.example.org"), null,
    { systemTurnKind: "browser_sign_in_request" }),
  message("sign-in-request-1-answer", "assistant", "You are signed in to portal.example.org.", "sign-in-request-1"),
  message("sign-in-question", "user", "Check my inbox at mail.example.com and the order status at shop.example.", "sign-in-request-1-answer"),
  message(answerId, "assistant", "I could not sign in to either site, so I could not check the inbox or the order.",
    "sign-in-question", { toolActivity: endedHandoffs })
];

/** A viewport shot (never an element shot taller than the viewport: Chromium then drops touch emulation) around `target`. */
async function shot(page: Page, testInfo: TestInfo, name: string, target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

    test(`Sign in again under an answer sends the request as a chip at ${viewport.width}x${viewport.height} ${viewport.theme}`,
      async ({ page, context }, testInfo) => {
        test.setTimeout(120_000);
        await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await installMatrixCatalogFixture(page, { folders: [], chats: [{
          id: chatId, title: "Inbox and order status", activeLeafMessageId: answerId, createdAt: timestamp, updatedAt: timestamp,
          defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: messages.length, messages
        }] });
        await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
        await page.route("**/api/model-runs/*", (route) => route.request().method() === "GET"
          ? route.fulfill({ json: { version: 1, run: { id: "sign-in-again-run", status: "streaming" } } }) : route.fallback());
        const stream = createGatedRunStreamFixture({ key: "sign-in-again-chat", abortMessage: "Synthetic stream stopped",
          notReadyError: "sign_in_again_stream_not_ready" });
        await stream.install(page, chatId);
        await recordMessagePosts(page);
        await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
          ? route.fulfill({ status: 409, json: { error: "unexpected_sign_in_again_run" } }) : route.fallback());
        await signInWithLocalToken(page, `/c/${chatId}`);

        // The earlier request reads as a chip naming its site, never as the server's words in a bubble.
        await expect(signInChips(page)).toHaveCount(1);
        await expect(signInChips(page).first()).toHaveText("Sign in again: portal.example.org");
        await expect(page.getByText("The user pressed Sign in again")).toHaveCount(0);

        // The latest answer lists each site its sign-in ended on, worded by how it ended, with its own button.
        const region = page.getByRole("region", { name: "Sign in again", exact: true });
        await expect(region).toBeVisible();
        const rows = region.getByRole("listitem");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("mail.example.com waited for you to sign in.");
        await expect(rows.nth(1)).toContainText("Signing in to shop.example was cancelled.");
        const mail = region.getByRole("button", { name: "Sign in again to mail.example.com", exact: true });
        const shop = region.getByRole("button", { name: "Sign in again to shop.example", exact: true });
        for (const [row, button] of [[rows.nth(0), mail], [rows.nth(1), shop]] as const) {
          await button.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
          await expectWithinViewport(page, button);
          await expectCenterUnobscured(button);
          await expect(button).toBeEnabled();
          const [rowBox, textBox, buttonBox] = await Promise.all([row.boundingBox(), row.locator("p").boundingBox(), button.boundingBox()]);
          expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
          if (viewport.width < 480) {
            // On a phone the button drops under the line at the row's width, so a long host never squeezes it.
            expect(buttonBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1);
            expect(buttonBox!.width).toBeGreaterThanOrEqual(rowBox!.width * 0.8);
          } else {
            expect(buttonBox!.x).toBeGreaterThanOrEqual(textBox!.x + textBox!.width - 1);
            expect(Math.abs((buttonBox!.y + buttonBox!.height / 2) - (rowBox!.y + rowBox!.height / 2))).toBeLessThanOrEqual(4);
          }
        }
        await mail.focus();
        await page.keyboard.press("Tab");
        await expect(shop).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-answer-${viewport.name}`, region);

        // Sign in again: the request goes to this chat after the answer, the draft stays, and the rows give way to the turn.
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("Unsent note about the invoices");
        await mail.click();
        await stream.waitForRequestCount(page, 1);
        await expectSignInRequestSent(page, chatId, "mail.example.com");
        const [post] = await messagePosts(page);
        expect(post!.body.expectedActiveLeafId).toBe(answerId);
        expect(post!.body.content).toBeUndefined();
        await expect(signInChips(page)).toHaveCount(2);
        await expect(region).toHaveCount(0);
        await expect(composer).toHaveValue("Unsent note about the invoices");
        await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId: "sign-in-again-run", status: "streaming" });
        await stream.emit(page, "message_start", { assistantMessageId: "sign-in-again-reply", userMessageId: "sign-in-request-2" });
        await stream.emit(page, "token", { delta: "Opening mail.example.com so you can sign in there." });
        await expect(page.getByText("Opening mail.example.com so you can sign in there.")).toBeVisible();
        await expect(signInChips(page).last()).toHaveText("Sign in again: mail.example.com");
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-chip-${viewport.name}`, signInChips(page).last());
      });
  });
}
