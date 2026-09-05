import { describe, expect, it } from "vitest";
import { decodeChatPdfPreparation } from "./chatPdfPreparation";

describe("PDF preparation projection", () => {
  const original = { completedPages: 0, limitedReadingQuality: true, longDocument: false,
    pageCount: 2, phase: "original_only", retryable: false, route: "local_text" };

  it("retains the settled original-only outcome without exposing failure details", () => {
    expect(decodeChatPdfPreparation({ ...original, errorCode: "private-code", storageKey: "private/original" }))
      .toEqual(original);
  });

  it("does not offer a preparation retry or original-only native PDF state", () => {
    expect(decodeChatPdfPreparation({ ...original, retryable: true })).toBeNull();
    expect(decodeChatPdfPreparation({ ...original, route: "direct_pdf", limitedReadingQuality: false })).toBeNull();
  });
});
