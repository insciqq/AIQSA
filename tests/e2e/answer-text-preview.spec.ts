import { expect, test, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * A text file the agent made opens in the Files viewer from its card in the answer (operator request 2026-11-20: a
 * cookies .txt had only Download): plain text and CSV as highlighted source with one-click Copy, Markdown rendered with
 * its source a click away and Copy in both. The chat is synthetic and the authorized text preview route answers as
 * scripted; the route itself and the component have their own tests.
 */

const chatId = "answer-text-preview-chat";
const timestamp = "2026-11-20T10:00:00.000Z";
const cookies = "# Netscape HTTP Cookie File\n" + Array.from({ length: 40 }, (_, index) =>
  `.example.com\tTRUE\t/\tTRUE\t1795191526\tsynthetic_cookie_${index}\t${"v".repeat(24 + (index % 5) * 30)}`).join("\n");
const notes = "# Release notes\n\n- First **point** with `code`.\n- A [link](https://example.com/docs).\n\n" +
  "| Column | Value |\n| --- | --- |\n| One | 1 |\n\n" +
  Array.from({ length: 40 }, (_, index) => `## Section ${index + 1}\n\n${"Paragraph text that goes on for a while. ".repeat(6)}`).join("\n\n");
const table = "name,amount\n" + Array.from({ length: 30 }, (_, index) => `row ${index},${index * 10}`).join("\n");
const files = [
  { attachmentId: "text-cookies", byteSize: cookies.length, fileName: "cookies.txt", mimeType: "text/plain", relativePath: "cookies.txt", body: cookies },
  { attachmentId: "text-notes", byteSize: notes.length, fileName: "notes.md", mimeType: "text/markdown", relativePath: "notes.md", body: notes },
  { attachmentId: "text-table", byteSize: table.length, fileName: "amounts.csv", mimeType: "text/csv", relativePath: "amounts.csv", body: table }
];

async function openChat(page: Page) {
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, title: "Text outputs", activeLeafMessageId: "answer", createdAt: timestamp, updatedAt: timestamp,
    defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: 2,
    messages: [
      { id: "question", role: "user", status: "complete", parentMessageId: null, createdAt: timestamp, content: "Make the files.",
        errorMessage: null, citationMessageId: null, modelId: null, modelRunId: null, provider: null },
      { id: "answer", role: "assistant", status: "complete", parentMessageId: "question", createdAt: timestamp,
        content: "Here are the files.", errorMessage: null, citationMessageId: null, modelId: "gpt-5.5", modelRunId: "run", provider: "openai",
        artifactSummary: { citations: [], reasoningText: [], sources: [],
          generatedFiles: files.map(({ body: _body, ...file }) => file) } }
    ]
  }] });
  await page.route(/\/api\/attachments\/text-[a-z]+\/content\?preview=text$/u, async (route) => {
    const file = files.find(candidate => route.request().url().includes(`/${candidate.attachmentId}/`));
    await route.fulfill({ body: file!.body, headers: { "cache-control": "private, no-store, max-age=0",
      "content-type": "text/plain; charset=utf-8" } });
  });
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByRole("region", { name: "Generated files" })).toBeVisible();
}

test.describe("text files in an answer", () => {
  test.describe.configure({ timeout: 120_000 });

  test("open in the viewer with one-click Copy, Markdown rendered with its source, at every size", async ({ context, page }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openChat(page);
    const region = page.getByRole("region", { name: "Generated files" });

    const name = region.getByRole("button", { name: "cookies.txt", exact: true });
    // The card reads as a link, not a magnifier, and its type tile opens the same viewer (operator request 2026-11-20).
    const tile = region.locator("li", { hasText: "cookies.txt" }).locator("button.v2-generated-file-tile");
    expect(await name.evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
    await tile.hover();
    expect(await tile.evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
    await page.screenshot({ clip: (await region.boundingBox())!, path: testInfo.outputPath("answer-text-preview-tile-hover.png") });
    await captureState(page, testInfo, "answer-text-preview-cards", { anchor: region, settleMs: 200, atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expectWithinViewport(page, region.locator("li", { hasText: "amounts.csv" }));
    } });
    await tile.click();
    const fromTile = page.getByRole("dialog", { name: "File preview: cookies.txt" });
    await expect(fromTile.getByText("# Netscape HTTP Cookie File")).toBeVisible();
    await fromTile.getByRole("button", { name: "Close preview" }).click();
    await expect(page.getByTestId("file-preview")).toHaveCount(0);
    await expect(name).toBeFocused();

    await name.click();
    const text = page.getByRole("dialog", { name: "File preview: cookies.txt" });
    await expect(text.getByText("# Netscape HTTP Cookie File")).toBeVisible();
    await text.getByRole("button", { name: "Copy" }).click();
    await expect(text.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cookies);
    await captureState(page, testInfo, "answer-text-preview-txt", { anchor: text, settleMs: 300, atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expectWithinViewport(page, text.getByRole("button", { name: /^Cop(y|ied)$/u }));
      await expectWithinViewport(page, text.getByRole("button", { name: "Close preview" }));
    } });
    await text.getByRole("button", { name: "Close preview" }).click();
    await expect(page.getByTestId("file-preview")).toHaveCount(0);
    await expect(name).toBeFocused();

    await region.getByRole("button", { name: "notes.md", exact: true }).click();
    const markdown = page.getByRole("dialog", { name: "File preview: notes.md" });
    await expect(markdown.getByRole("heading", { name: "Release notes" })).toBeVisible();
    await expect(markdown.getByRole("radio", { name: "Rendered" })).toBeChecked();
    await markdown.getByRole("button", { name: "Copy" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(notes);
    await captureState(page, testInfo, "answer-text-preview-md", { anchor: markdown, settleMs: 300, atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expectWithinViewport(page, markdown.getByRole("button", { name: /^Cop(y|ied)$/u }));
      await expectWithinViewport(page, markdown.getByRole("radio", { name: "Source" }));
    } });
    // The rendered view scrolls by itself under its Copy bar.
    const rendered = markdown.locator(".v2-file-preview-markdown");
    const scrolled = await rendered.evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
    expect(scrolled).toBeGreaterThan(0);
    await markdown.getByRole("radio", { name: "Source" }).click();
    await expect(markdown.getByText("First **point** with `code`.")).toBeVisible();
    await markdown.getByRole("button", { name: "Close preview" }).click();

    await region.getByRole("button", { name: "amounts.csv", exact: true }).click();
    const csv = page.getByRole("dialog", { name: "File preview: amounts.csv" });
    await expect(csv.getByText("name,amount")).toBeVisible();
    await expect(csv.getByRole("button", { name: "Copy" })).toBeVisible();
    await csv.getByRole("button", { name: "Close preview" }).click();
  });
});
