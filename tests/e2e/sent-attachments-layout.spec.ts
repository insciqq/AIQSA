import { expect, test, type Locator } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Files sent with a message sit above its bubble, right-aligned: cards with a
// name that stays inside them at any width, images as small thumbnails, and no
// empty bubble under a message that has only files.
const chatId = "sent-attachments-layout-chat";
const timestamp = "2026-10-24T10:00:00.000Z";
const longName = "result_Синтетический Пациент Тестович 105301234567 общий анализ крови и биохимия за весь прошедший год.pdf";
const files = ["09.09.2025-холестерин.pdf", "заметка.md", longName];
// A tall picture, so the thumbnail bound shows on its long side.
const tallImage = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"><rect width="400" height="1600" fill="#888"/></svg>`;

const userMessage = (id: string, text: string, blocks: readonly Record<string, unknown>[], parentMessageId: string | null) => ({
  id, role: "user", status: "complete", parentMessageId, createdAt: timestamp, errorMessage: null, citationMessageId: null,
  modelId: null, modelRunId: null, provider: null,
  content: { blocks: [...(text ? [{ type: "text", text }] : []), ...blocks] }
});
const fileBlocks = (id: string, names: readonly string[]) => names.map((fileName, index) => ({
  type: "file", attachmentId: `${id}-file-${index}`, fileName
}));

async function box(locator: Locator) {
  return (await locator.boundingBox())!;
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark", touch: false },
  { width: 768, height: 1024, theme: "light", touch: true },
  { width: 390, height: 844, theme: "dark", touch: true },
  { width: 844, height: 390, theme: "light", touch: true }
] as const) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch });

    test(`sent files sit above the bubble at ${viewport.width}px`, async ({ context, page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await installMatrixCatalogFixture(page, { folders: [], chats: [{
        id: chatId, title: "Sent attachments layout", activeLeafMessageId: "image-only",
        createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
        folderId: null, pinned: false, messageCount: 3,
        messages: [
          userMessage("with-text", "Synthetic question about these reports.", fileBlocks("with-text", files), null),
          userMessage("file-only", "", fileBlocks("file-only", ["a.pdf"]), "with-text"),
          userMessage("image-only", "", [{ type: "image", attachmentId: "sent-image", alt: "Синтетический снимок" }], "file-only")
        ]
      }] });
      await page.route(/\/api\/attachments\/sent-image\/content\?preview=image$/u, (route) => route.fulfill({
        body: tallImage, contentType: "image/svg+xml"
      }));
      await page.route(/\/api\/attachments\/with-text-file-1\/content\?preview=text$/u, (route) => route.fulfill({
        body: "# Синтетическая заметка", contentType: "text/plain; charset=utf-8"
      }));
      await signInWithLocalToken(page, `/c/${chatId}`);

      const lists = page.getByRole("list", { name: "Message attachments" });
      await expect(lists).toHaveCount(3);
      const turn = page.locator('[data-message-id="with-text"]');
      const bubble = turn.locator(".v2-conversation-turn-content");
      const first = lists.first();
      await expect(first.getByRole("listitem")).toHaveCount(3);

      // Above the bubble, outside it, and right-aligned with it.
      expect(await bubble.getByRole("listitem").count()).toBe(0);
      const [listBox, bubbleBox] = await Promise.all([box(first), box(bubble)]);
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(bubbleBox.y + 1);
      const lastCard = await box(first.getByRole("listitem").last());
      expect(Math.abs(lastCard.x + lastCard.width - (bubbleBox.x + bubbleBox.width))).toBeLessThanOrEqual(2);

      // A long Cyrillic name stays inside its card.
      const longCard = first.getByRole("button", { name: `Open ${longName}` });
      await expect(longCard).toBeVisible();
      const longBox = await box(longCard.locator("strong"));
      expect(longBox.x + longBox.width).toBeLessThanOrEqual(lastCard.x + lastCard.width);
      await expect(first.getByRole("button", { name: `More actions for ${longName}` })).toBeVisible();

      // A file-only message has no bubble: nothing under its card.
      const bubbleless = page.locator('[data-message-id="file-only"] .v2-conversation-turn-content');
      await expect(bubbleless).toHaveAttribute("data-bubbleless", "true");
      await expect(bubbleless).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.getByText("This message has no text.")).toHaveCount(0);

      // A tall image is a small thumbnail whose actions are in the viewer.
      const image = page.getByRole("button", { name: "Open image: Синтетический снимок" });
      await expect(image.getByRole("img")).toBeVisible();
      await expect.poll(async () => (await box(image)).height).toBeGreaterThan(40);
      const imageBox = await box(image);
      expect(imageBox.height).toBeLessThanOrEqual(242);
      expect(imageBox.width).toBeLessThanOrEqual(242);
      await expectNoHorizontalOverflow(page);
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("sent-attachments.png") });

      await image.scrollIntoViewIfNeeded();
      await image.click();
      const viewer = page.getByRole("dialog", { name: "Синтетический снимок" });
      await expect(viewer.getByRole("link", { name: "Download" })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Save to Files" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("image-viewer.png") });
      await viewer.getByRole("button", { name: "Close image" }).click();

      // A text file opens in the viewer, with its name and Download at hand.
      await first.getByRole("button", { name: "Open заметка.md" }).click();
      const preview = page.getByTestId("file-preview");
      await expect(preview.getByRole("heading", { name: "Синтетическая заметка" })).toBeVisible();
      await expect(preview.getByRole("link", { name: "Download заметка.md" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("text-viewer.png") });
      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(first.getByRole("button", { name: "Open заметка.md" })).toBeFocused();
    });
  });
}
