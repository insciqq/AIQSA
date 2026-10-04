import { describe, expect, it } from "vitest";
import { decodeChatPdfPreparation, decodeChatPdfRouteAvailability } from "./chatPdfPreparation";

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

describe("PDF route preview", () => {
  it("decodes an available route or the definite missing-route refusal only", () => {
    expect(decodeChatPdfRouteAvailability(200, { route: "system_pdf", version: 1 }))
      .toEqual({ available: true, route: "system_pdf" });
    expect(decodeChatPdfRouteAvailability(422, { error: "pdf_processing_configuration_incomplete" }))
      .toEqual({ available: false, reasonCode: "pdf_processing_configuration_incomplete" });
    for (const [status, body] of [
      [200, { route: "unknown", version: 1 }], [200, { route: "direct_pdf", version: 2 }],
      [422, { error: "invalid_request" }], [409, { error: "pdf_processing_configuration_incomplete" }],
      [404, { error: "model_not_available" }], [200, null], [200, []]
    ] as const) expect(decodeChatPdfRouteAvailability(status, body)).toBeNull();
  });
});
