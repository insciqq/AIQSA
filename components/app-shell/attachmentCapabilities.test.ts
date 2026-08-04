import { describe, expect, it } from "vitest";
import type { CatalogModel } from "./types";
import {
  attachmentWarningsForModel,
  firstBlockingAttachmentWarning,
  partitionAttachmentsForModel,
  pdfProcessingForAttachment
} from "./attachmentCapabilities";

function model(
  documentInputMode: CatalogModel["capabilities"]["documentInputMode"],
  imageInput: boolean
): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode,
      imageInput,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      toolCalling: false
    },
    contextWindow: 4096,
    defaultParams: {},
    displayName: "Test model",
    modelId: "test-model",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
      reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "test",
    searchStrategyIds: ["search-disabled"]
  };
}

const attachments = [
  { fileName: "notes.txt", id: "document", kind: "document" as const },
  { fileName: "image.png", id: "image", kind: "image" as const },
  { fileName: "paper.pdf", id: "pdf", kind: "pdf" as const }
];

describe("attachment capabilities", () => {
  it("reconciles staged files when a model changes", () => {
    expect(partitionAttachmentsForModel(attachments, model("none", true))).toEqual({
      supported: [attachments[0], attachments[1]],
      unsupported: [attachments[2]]
    });

    expect(
      partitionAttachmentsForModel(attachments, model("pdf_text_extraction", false))
    ).toEqual({
      supported: [attachments[0], attachments[2]],
      unsupported: [attachments[1]]
    });
  });

  it("keeps bounded partial PDFs sendable and reports their exact known progress", () => {
    const partial = {
      fileName: "limited.pdf",
      id: "limited",
      kind: "pdf" as const,
      processing: {
        extractedCharacterCount: 20_000,
        pageCount: 40,
        pagesProcessed: 7,
        status: "partial" as const,
        truncationReason: "text_limit" as const
      }
    };

    expect(attachmentWarningsForModel([partial], model("pdf_text_extraction", false))).toEqual([
      {
        attachmentId: "limited",
        blocking: false,
        label: "Text limited",
        message: "PDF text was limited after page 7 of 40. The available text will be used."
      }
    ]);
    expect(firstBlockingAttachmentWarning([partial], model("pdf_text_extraction", false))).toBeNull();
  });

  it("treats a Unicode-safe zero-text partial result as native-only", () => {
    const zeroTextPartial = {
      extractedText: null,
      fileName: "astral.pdf",
      id: "astral",
      kind: "pdf" as const,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 1,
        status: "partial" as const,
        truncationReason: "text_limit" as const
      }
    };

    expect(attachmentWarningsForModel([zeroTextPartial], model("native_pdf", false))).toEqual([
      {
        attachmentId: "astral",
        blocking: false,
        label: "Text limited",
        message: "PDF text exceeded the configured limit before any complete text could be retained. This model can use the original PDF."
      }
    ]);
    expect(
      attachmentWarningsForModel([zeroTextPartial], model("pdf_text_extraction", false))
    ).toEqual([
      {
        attachmentId: "astral",
        blocking: true,
        label: "Text limited",
        message: "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file."
      }
    ]);
  });

  it("updates no-text compatibility when the selected PDF mode changes without removing the file", () => {
    const noText = {
      fileName: "scan.pdf",
      id: "scan",
      kind: "pdf" as const,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 12,
        pagesProcessed: 12,
        status: "no_text" as const
      }
    };

    expect(attachmentWarningsForModel([noText], model("native_pdf", false))).toEqual([
      expect.objectContaining({
        attachmentId: "scan",
        blocking: false,
        message: "No extractable text was found. This model can use the original PDF."
      })
    ]);
    expect(attachmentWarningsForModel([noText], model("pdf_text_extraction", false))).toEqual([
      expect.objectContaining({
        attachmentId: "scan",
        blocking: true,
        message: "No extractable text was found. Choose a model with native PDF support or remove this file."
      })
    ]);
    expect(partitionAttachmentsForModel([noText], model("pdf_text_extraction", false))).toEqual({
      supported: [noText],
      unsupported: []
    });
  });

  it("ignores malformed processing metadata in browser-side decisions", () => {
    const malformed = {
      fileName: "untrusted.pdf",
      id: "untrusted",
      kind: "pdf" as const,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 99,
        status: "no_text" as const
      }
    };

    expect(pdfProcessingForAttachment(malformed)).toBeNull();
    expect(attachmentWarningsForModel([malformed], model("pdf_text_extraction", false))).toEqual([]);
    expect(pdfProcessingForAttachment({
      ...malformed,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 2,
        status: "complete"
      }
    })).toBeNull();
    expect(pdfProcessingForAttachment({
      ...malformed,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 0,
        status: "partial",
        truncationReason: "text_limit"
      }
    })).toBeNull();
  });
});
