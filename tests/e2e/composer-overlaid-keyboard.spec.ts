import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

/*
 * iOS Safari overlays the software keyboard and ignores
 * `interactive-widget`: the layout keeps its height and only the visual
 * viewport shrinks. New chat focuses the composer without scrolling, so the
 * blank chat's composer used to stay under the keyboard. Chromium resizes
 * the layout for a real keyboard instead, so the spec overlays one the way
 * iOS reports it, by shrinking the visual viewport alone.
 */

const VIEWPORTS = [
  { height: 844, keyboard: 336, name: "phone", width: 390 },
  { height: 390, keyboard: 170, name: "phone-landscape", width: 844 },
  { height: 1024, keyboard: 400, name: "tablet", width: 768 }
] as const;

const chatId = "chat-overlaid-keyboard";
const chat = {
  activeLeafMessageId: "assistant-keyboard",
  createdAt: "2026-10-19T00:00:00.000Z",
  defaultModelId: "gpt-5.5",
  defaultProvider: "openai",
  folderId: null,
  id: chatId,
  messageCount: 2,
  messages: [
    scrollMessage("user-keyboard", "user", "Earlier question", null),
    scrollMessage("assistant-keyboard", "assistant", "Earlier answer", "user-keyboard")
  ],
  pinned: false,
  title: "Overlaid keyboard",
  updatedAt: "2026-10-19T00:00:01.000Z",
  usageStats: null
};

async function overlayKeyboard(page: Page, height: number): Promise<void> {
  await page.evaluate((covered) => {
    (window as Window & { __overlaidKeyboard?: number }).__overlaidKeyboard = covered;
    window.visualViewport?.dispatchEvent(new Event("resize"));
  }, height);
}

async function bottomOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.y + box!.height;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const height = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height")!.get!;
    Object.defineProperty(VisualViewport.prototype, "height", {
      configurable: true,
      get(this: VisualViewport) {
        return height.call(this) - ((window as Window & { __overlaidKeyboard?: number }).__overlaidKeyboard ?? 0);
      }
    });
  });
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: New chat keeps the blank chat's composer above an overlaid keyboard`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await signIn(page, `/c/${chatId}`);
    const workspace = page.locator(".v2-live-workspace");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(page.getByText("Earlier answer")).toBeVisible();

    await page.getByRole("button", { name: "New chat", exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await expect(message).toBeFocused();
    const resting = await bottomOf(page.getByTestId("composer-v2"));

    const visible = viewport.height - viewport.keyboard;
    await overlayKeyboard(page, viewport.keyboard);
    await expect(workspace).toHaveAttribute("data-keyboard", "open");
    await expect.poll(() => bottomOf(page.getByTestId("composer-v2"))).toBeLessThanOrEqual(visible);
    expect((await message.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`blank-chat-keyboard-${viewport.name}.png`) });

    // The keyboard goes down: the composer returns to where it rested.
    await overlayKeyboard(page, 0);
    await expect(workspace).not.toHaveAttribute("data-keyboard");
    await expect.poll(() => bottomOf(page.getByTestId("composer-v2"))).toBeCloseTo(resting, 0);
  });

  test(`${viewport.name}: an open chat's docked composer stays above an overlaid keyboard`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await signIn(page, `/c/${chatId}`);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(page.getByText("Earlier answer")).toBeVisible();
    await message.focus();

    const visible = viewport.height - viewport.keyboard;
    await overlayKeyboard(page, viewport.keyboard);
    await expect.poll(() => bottomOf(page.getByTestId("composer-v2"))).toBeLessThanOrEqual(visible);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`open-chat-keyboard-${viewport.name}.png`) });
  });
}
