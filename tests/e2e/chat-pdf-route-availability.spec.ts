import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Browser contract for the composer's PDF route preview. The upload and the
// server-owned route preview are fulfilled by the browser fixture, so this
// spec owns no database state; the real admission route and the Ready send
// with an installation PDF reader stay covered by workspace.spec.ts.
const pdf = {
  attachment: {
    byteSize: 512,
    extractedText: null,
    fileName: "route-check.pdf",
    id: "pdf-route-availability-e2e",
    kind: "pdf",
    metadata: {},
    mimeType: "application/pdf",
    pageCount: 1,
    processingErrorCode: null,
    status: "ready",
    updatedAt: "2026-10-03T00:00:00.000Z"
  }
};

test.use({ hasTouch: true });

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 820, height: 1180, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
  { width: 844, height: 390, theme: "light" }
] as const) {
  test(`a PDF without a reading route is blocked at attach time at ${viewport.width}x${viewport.height}`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: baseURL! }]);
    await installMatrixCatalogFixture(page);
    await page.route("**/api/uploads", (route) => route.fulfill({ json: pdf, status: 201 }));
    let routeAvailable = false;
    const previewTargets: unknown[] = [];
    await page.route("**/api/uploads/pdf-route", async (route) => {
      previewTargets.push(route.request().postDataJSON());
      await route.fulfill(routeAvailable
        ? { headers: { "Cache-Control": "no-store" }, json: { route: "system_vision", version: 1 } }
        : { json: { error: "pdf_processing_configuration_incomplete" }, status: 422 });
    });

    await signInWithLocalToken(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    const send = page.getByRole("button", { name: "Send message" });
    await composer.fill("Summarize the attached PDF.");
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("%PDF-1.4 synthetic route fixture"),
      mimeType: "application/pdf",
      name: pdf.attachment.fileName
    });

    const chip = page.getByRole("region", { name: "Attachments" })
      .getByRole("listitem").filter({ hasText: pdf.attachment.fileName });
    await expect(chip).toContainText("Can't read PDF");
    await expect(chip).toContainText("No PDF-reading model is configured for this installation.");
    await expect(chip).toHaveAttribute("data-warning-blocking", "true");
    // The local token user is an administrator, so the hint is a settings link.
    await expect(chip.getByRole("link", { name: "Set up PDF processing" }))
      .toHaveAttribute("href", "/admin?section=roles&resource=chat_pdf");
    await expect(send).toBeDisabled();
    await expect(composer).toHaveValue("Summarize the attached PDF.");
    expect(previewTargets[0]).toMatchObject({ projectId: null, providerConnectionId: "openai", providerModelId: "gpt-5.5" });
    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, chip);
    await page.screenshot({ path: testInfo.outputPath(`pdf-route-blocked-${viewport.width}x${viewport.height}.png`) });

    // An administrator assigns a page-image reader; the next refresh (window
    // focus, or the 30-second poll) re-evaluates the chip without reattaching.
    routeAvailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(chip).toContainText("Ready");
    await expect(chip).not.toContainText("Can't read PDF");
    await expect(chip).toHaveAttribute("data-attachment-status", "ready");
    await expect(send).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`pdf-route-ready-${viewport.width}x${viewport.height}.png`) });

    await chip.getByRole("button", { name: `Remove ${pdf.attachment.fileName}` }).click();
    await expect(chip).toHaveCount(0);
  });
}

for (const viewport of [
  { width: 1440, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" }
] as const) {
  test(`a scanned PDF is sendable once the assigned reader can read it at ${viewport.width}x${viewport.height}`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: baseURL! }]);
    await installMatrixCatalogFixture(page);
    const scan = { attachment: { ...pdf.attachment, fileName: "scanned-pages.pdf", id: "pdf-route-scan-e2e",
      processing: { extractedCharacterCount: 0, pageCount: 1, pagesProcessed: 1, status: "no_text" } } };
    await page.route("**/api/uploads", (route) => route.fulfill({ json: scan, status: 201 }));
    let routeKnown = false;
    await page.route("**/api/uploads/pdf-route", (route) => route.fulfill(routeKnown
      ? { headers: { "Cache-Control": "no-store" }, json: { route: "system_vision", version: 1 } }
      : { json: { error: "model_not_available" }, status: 409 }));

    await signInWithLocalToken(page);
    const send = page.getByRole("button", { name: "Send message" });
    await page.getByRole("textbox", { name: "Message" }).fill("Read the scanned pages.");
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("%PDF-1.4 synthetic scanned fixture"),
      mimeType: "application/pdf",
      name: scan.attachment.fileName
    });
    const chip = page.getByRole("region", { name: "Attachments" })
      .getByRole("listitem").filter({ hasText: scan.attachment.fileName });
    // Unknown route: the local no-text block stays as before.
    await expect(chip).toContainText("Choose a model with native PDF support or remove this file.");
    await expect(send).toBeDisabled();

    routeKnown = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(chip).toContainText("The assigned PDF reader will read the original PDF.");
    await expect(chip).not.toHaveAttribute("data-warning-blocking", "true");
    await expect(send).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, chip);
    await page.screenshot({ path: testInfo.outputPath(`pdf-route-scan-ready-${viewport.width}x${viewport.height}.png`) });
  });
}
