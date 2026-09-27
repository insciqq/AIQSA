import { expect, test } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function attachment(status: "failed" | "processing" | "ready") {
  return {
    attachment: {
      byteSize: 128,
      extractedText: status === "ready" ? "Processed report text" : null,
      fileName: "lifecycle-report.docx",
      id: "attachment-lifecycle-e2e",
      kind: "document",
      metadata: status === "ready" ? { document: { engine: "docling" } } : {},
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      processingErrorCode: status === "failed" ? "parser_unavailable" : null,
      status,
      updatedAt: "2026-08-08T05:30:00.000Z"
    }
  };
}

test("keeps the draft editable and gates send across attachment processing, retry, and readiness", async ({
  page
}) => {
  const failedPoll = deferred();
  const failedResult = deferred();
  const readyPoll = deferred();
  const readyResult = deferred();
  let statusReads = 0;

  await installMatrixCatalogFixture(page);
  await page.route("**/api/uploads", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: attachment("processing"),
      status: 201
    });
  });
  await page.route("**/api/uploads/attachment-lifecycle-e2e", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        json: attachment("processing")
      });
      return;
    }

    statusReads += 1;
    if (statusReads === 1) {
      failedPoll.resolve();
      await failedResult.promise;
      await route.fulfill({ contentType: "application/json", json: attachment("failed") });
      return;
    }

    readyPoll.resolve();
    await readyResult.promise;
    await route.fulfill({ contentType: "application/json", json: attachment("ready") });
  });

  await signInWithLocalToken(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send message" });
  await composer.fill("Keep this draft while the report is processed");
  await page.getByLabel("Attach files").setInputFiles({
    buffer: Buffer.from("OOXML fixture routed by the browser contract"),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    name: "lifecycle-report.docx"
  });

  const chip = page.getByRole("region", { name: "Attachments" })
    .getByRole("listitem")
    .filter({ hasText: "lifecycle-report.docx" });
  await expect(chip).toContainText("Processing…");
  await expect(chip).toHaveAttribute("data-attachment-status", "processing");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("Keep this draft while the report is processed");
  await expect(send).toBeDisabled();

  await failedPoll.promise;
  await expect(chip).toContainText("Processing…");
  failedResult.resolve();
  await expect(chip).toContainText("The document processing service is unavailable.");
  await expect(chip).toHaveAttribute("data-attachment-status", "failed");
  await expect(chip.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(chip.getByRole("button", { name: "Remove lifecycle-report.docx" })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(send).toBeDisabled();

  await chip.getByRole("button", { name: "Retry" }).click();
  await expect(chip).toContainText("Processing…");
  await readyPoll.promise;
  await expect(send).toBeDisabled();
  readyResult.resolve();
  await expect(chip).toContainText("Ready");
  await expect(chip).toHaveAttribute("data-attachment-status", "ready");
  await expect(composer).toHaveValue("Keep this draft while the report is processed");
  await expect(send).toBeEnabled();

  await chip.getByRole("button", { name: "Remove lifecycle-report.docx" }).click();
  await expect(chip).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`truncated text keeps Send reachable in a short landscape viewport · ${theme}`, async ({ page, context, baseURL }, testInfo) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: baseURL! }]);
    await installMatrixCatalogFixture(page);
    const ready = { attachment: { ...attachment("ready").attachment, metadata: { document: {
      engine: "inline", status: "partial", truncated: true, characterCount: 1_000_000,
      extractedTextMaxChars: 1_000_000, warnings: ["partial_parse", "truncated_oversized_section"]
    } } } };
    await page.route("**/api/uploads", route => route.fulfill({ status: 201, json: ready }));
    await signInWithLocalToken(page);
    await page.getByRole("textbox", { name: "Message" }).fill("Summarize the available document text.");
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("Synthetic limited-text fixture"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: ready.attachment.fileName
    });
    const chip = page.getByRole("region", { name: "Attachments" }).getByRole("listitem");
    await expect(chip).toContainText("Text limited");
    await expect(chip).toContainText("The model is told the rest is missing.");
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toBeEnabled();
    await send.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const box = await send.boundingBox();
      return Boolean(box && box.y >= 0 && box.y + box.height <= 390);
    }).toBe(true);
    // A scroll event must not snap the empty conversation back to its heading.
    await page.waitForTimeout(100);
    await expect.poll(() => page.locator(".v2-conversation-scroll").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await send.click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath(`truncated-text-landscape-${theme}.png`) });
    await chip.getByRole("button", { name: `Remove ${ready.attachment.fileName}` }).click();
    await expect(chip).toHaveCount(0);
  });
}
