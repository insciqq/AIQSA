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
  const composer = page.getByRole("textbox", { name: "Сообщение" });
  const send = page.getByRole("button", { name: "Отправить сообщение" });
  await composer.fill("Keep this draft while the report is processed");
  await page.getByLabel("Прикрепить файлы").setInputFiles({
    buffer: Buffer.from("OOXML fixture routed by the browser contract"),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    name: "lifecycle-report.docx"
  });

  const chip = page.getByRole("region", { name: "Вложения" })
    .getByRole("listitem")
    .filter({ hasText: "lifecycle-report.docx" });
  await expect(chip).toContainText("Обработка…");
  await expect(chip).toHaveAttribute("data-attachment-status", "processing");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("Keep this draft while the report is processed");
  await expect(send).toBeDisabled();

  await failedPoll.promise;
  await expect(chip).toContainText("Обработка…");
  failedResult.resolve();
  await expect(chip).toContainText("Сервис обработки документов недоступен.");
  await expect(chip).toHaveAttribute("data-attachment-status", "failed");
  await expect(chip.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(chip.getByRole("button", { name: "Удалить lifecycle-report.docx" })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(send).toBeDisabled();

  await chip.getByRole("button", { name: "Повторить" }).click();
  await expect(chip).toContainText("Обработка…");
  await readyPoll.promise;
  await expect(send).toBeDisabled();
  readyResult.resolve();
  await expect(chip).toContainText("Готов");
  await expect(chip).toHaveAttribute("data-attachment-status", "ready");
  await expect(composer).toHaveValue("Keep this draft while the report is processed");
  await expect(send).toBeEnabled();

  await chip.getByRole("button", { name: "Удалить lifecycle-report.docx" }).click();
  await expect(chip).toHaveCount(0);
});
