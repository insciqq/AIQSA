import { expect, test, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// A long paste becomes a text file through the real upload path, and "Paste
// as text" puts it back into the message.
const pasted = Array.from({ length: 160 }, (_, line) => `2026-10-24 12:${String(line % 60).padStart(2, "0")} INFO synthetic job ${line} finished`)
  .join("\n");

async function paste(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark", touch: false },
  { width: 768, height: 1024, theme: "light", touch: true },
  { width: 390, height: 844, theme: "dark", touch: true }
] as const) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch });

    test(`a long paste becomes Pasted text.txt and goes back as text at ${viewport.width}px`, async ({ context, page }, testInfo) => {
      // The first upload on a cold dev server also compiles its routes.
      test.slow();
      expect(pasted.length).toBeGreaterThanOrEqual(5_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await installMatrixCatalogFixture(page);
      await signInWithLocalToken(page);

      const composer = page.getByRole("textbox", { name: "Message" });
      const tray = page.getByRole("region", { name: "Attachments" });
      const row = tray.getByRole("listitem").filter({ hasText: "Pasted text.txt" });
      await composer.fill("Summarize this log: ");
      await composer.press("End");
      await paste(page, pasted);

      await expect(row).toBeVisible();
      await expect(composer).toHaveValue("Summarize this log: ");
      await expect(row).toHaveAttribute("data-attachment-status", "ready", { timeout: 60_000 });
      const pasteBack = row.getByRole("button", { name: "Paste as text: Pasted text.txt" });
      await expect(pasteBack).toBeVisible();
      const [rowBox, buttonBox] = await Promise.all([row.boundingBox(), pasteBack.boundingBox()]);
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
      if (viewport.touch) expect(buttonBox!.height).toBeGreaterThanOrEqual(40);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("long-paste-attached.png") });

      // A short paste stays text.
      await paste(page, "short");
      await expect(tray.getByRole("listitem")).toHaveCount(1);

      await pasteBack.click();
      await expect(row).toHaveCount(0);
      await expect(composer).toHaveValue(`Summarize this log: ${pasted}`);
      await expect(composer).toBeFocused();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("long-paste-back-as-text.png") });
    });
  });
}
