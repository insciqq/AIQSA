import { expect, test, type Locator } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Files sent with a message read as one tidy list: one per line, aligned with
// the message text, every "⋯" in one column, and the bubble no wider than its
// longest line.
const chatId = "sent-attachments-layout-chat";
const timestamp = "2026-10-24T10:00:00.000Z";
const files = [
  "09.09.2025-холестерин.pdf",
  "09.12.2025-холестерин.pdf",
  "22.02.2026-холестерин.pdf",
  "result_Синтетический Пациент Тестович 105301234567 общий анализ крови.pdf"
];

const userMessage = (id: string, text: string, names: readonly string[], parentMessageId: string | null) => ({
  id, role: "user", status: "complete", parentMessageId, createdAt: timestamp, errorMessage: null, citationMessageId: null,
  modelId: null, modelRunId: null, provider: null,
  content: { blocks: [{ type: "text", text }, ...names.map((fileName, index) => ({
    type: "file", attachmentId: `${id}-file-${index}`, fileName
  }))] }
});

async function box(locator: Locator) {
  return (await locator.boundingBox())!;
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark", touch: false },
  { width: 768, height: 1024, theme: "light", touch: true },
  { width: 390, height: 844, theme: "dark", touch: true }
] as const) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch });

    test(`sent files form one aligned list at ${viewport.width}px`, async ({ context, page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await installMatrixCatalogFixture(page, { folders: [], chats: [{
        id: chatId, title: "Sent attachments layout", activeLeafMessageId: "short-question",
        createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
        folderId: null, pinned: false, messageCount: 2,
        messages: [
          userMessage("long-question", "Synthetic question about four lab reports.\nThe second line of the question is a little longer.", files, null),
          userMessage("short-question", "Two files", ["a.pdf", "b.pdf"], "long-question")
        ]
      }] });
      await signInWithLocalToken(page, `/c/${chatId}`);

      const lists = page.getByRole("list", { name: "Message attachments" });
      await expect(lists).toHaveCount(2);
      const rows = lists.first().getByRole("listitem");
      await expect(rows).toHaveCount(4);
      const rowBoxes = await Promise.all([0, 1, 2, 3].map((index) => box(rows.nth(index))));
      const menuBoxes = await Promise.all([0, 1, 2, 3].map((index) =>
        box(rows.nth(index).getByRole("button", { name: `More actions for ${files[index]}` }))));
      for (let index = 1; index < 4; index++) {
        // One per line, starting at the same edge, with the "⋯" in one column.
        expect(rowBoxes[index]!.y).toBeGreaterThanOrEqual(rowBoxes[index - 1]!.y + rowBoxes[index - 1]!.height - 1);
        expect(Math.abs(rowBoxes[index]!.x - rowBoxes[0]!.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(menuBoxes[index]!.x + menuBoxes[index]!.width - menuBoxes[0]!.x - menuBoxes[0]!.width)).toBeLessThanOrEqual(1);
      }
      // The list starts where the message text starts.
      const text = page.getByText("Synthetic question about four lab reports.", { exact: false }).first();
      expect(Math.abs((await box(text)).x - rowBoxes[0]!.x)).toBeLessThanOrEqual(2);
      // A short message with short files keeps a narrow bubble.
      const [longList, shortList] = await Promise.all([box(lists.first()), box(lists.nth(1))]);
      expect(shortList.width).toBeLessThan(longList.width);
      await expectNoHorizontalOverflow(page);
      await lists.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("sent-attachments.png") });
    });
  });
}
