import { describe, expect, it } from "vitest";
import { attachmentAcceptForPolicy } from "./attachmentSelection";
import type { CatalogModel } from "./types";
import {
  attachmentBlocksSend,
  attachmentPolicyForModel,
  attachmentWarningsForModel,
  firstBlockingAttachmentWarning,
  imageRouteAvailable,
  imageRouteUnavailableMessage,
  partitionAttachmentsForModel,
  pdfProcessingForAttachment,
  unsupportedAttachmentMessage
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
  it("publishes PDF picker formats for a selected model with legacy capability metadata", () => {
    const accept = attachmentAcceptForPolicy(
      attachmentPolicyForModel(model("none", false))
    );

    expect(accept).toContain(".pdf");
    expect(accept).toContain("application/pdf");
  });

  it("reconciles staged files when a model changes", () => {
    expect(partitionAttachmentsForModel(attachments, model("none", true))).toEqual({
      supported: attachments,
      unsupported: []
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

  it("keeps direct PDF parser states sendable but blocks storage and integrity failures", () => {
    const directModel = model("native_pdf", false);
    const extractionModel = model("pdf_text_extraction", false);
    const processing = {
      fileName: "scan.pdf",
      id: "scan",
      kind: "pdf" as const,
      processingErrorCode: null,
      status: "processing" as const
    };
    const parserFailure = {
      ...processing,
      processingErrorCode: "parser_unavailable",
      status: "failed" as const
    };
    const storageFailure = {
      ...parserFailure,
      processingErrorCode: "attachment_checksum_mismatch"
    };

    expect(attachmentBlocksSend(processing, directModel)).toBe(false);
    expect(attachmentBlocksSend(parserFailure, directModel)).toBe(false);
    expect(attachmentBlocksSend(storageFailure, directModel)).toBe(true);
    expect(attachmentBlocksSend(processing, extractionModel)).toBe(true);
    expect(attachmentBlocksSend(parserFailure, extractionModel)).toBe(true);
  });

  it("accepts opaque files and ignores parser readiness only while Workspace is enabled", () => {
    const extractionModel = model("pdf_text_extraction", false);
    const opaque = {
      fileName: "dataset.custom",
      id: "opaque",
      kind: "file" as const,
      status: "ready" as const
    };
    const processing = {
      fileName: "scan.pdf",
      id: "scan",
      kind: "pdf" as const,
      status: "processing" as const
    };
    const parserFailure = {
      ...processing,
      processingErrorCode: "parser_unavailable",
      status: "failed" as const
    };
    const storageFailure = {
      ...parserFailure,
      processingErrorCode: "attachment_object_read_failed"
    };

    expect(attachmentPolicyForModel(undefined, true)).toEqual({
      documents: true,
      files: true,
      images: true,
      pdfs: true
    });
    expect(attachmentAcceptForPolicy(attachmentPolicyForModel(undefined, true))).toBe("");
    expect(partitionAttachmentsForModel([opaque], extractionModel)).toEqual({
      supported: [],
      unsupported: [opaque]
    });
    expect(partitionAttachmentsForModel([opaque], extractionModel, true)).toEqual({
      supported: [opaque],
      unsupported: []
    });
    expect(attachmentBlocksSend(processing, extractionModel, true)).toBe(false);
    expect(attachmentBlocksSend(parserFailure, extractionModel, true)).toBe(false);
    expect(attachmentBlocksSend(storageFailure, extractionModel, true)).toBe(true);
    expect(attachmentWarningsForModel([processing, parserFailure], extractionModel, true)).toEqual([]);
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

  it("warns about an incomplete non-PDF document without blocking it", () => {
    const document = (processing: Record<string, unknown>) => ({
      fileName: "large.txt",
      id: "large",
      kind: "document" as const,
      metadata: {
        document: {
          characterCount: 1_000_000,
          engine: "inline",
          extractedTextMaxChars: 1_000_000,
          ...processing
        }
      },
      status: "ready" as const
    });
    const selected = model("pdf_text_extraction", false);

    expect(attachmentWarningsForModel([
      document({ status: "partial", truncated: true, warnings: ["partial_parse", "truncated_oversized_section"] })
    ], selected)).toEqual([{
      attachmentId: "large",
      blocking: false,
      label: "Text limited",
      message: "Only the first 1,000,000 characters of text were extracted. The model is told the rest is missing."
    }]);
    expect(attachmentWarningsForModel([
      document({ status: "partial", truncated: false })
    ], selected)).toMatchObject([{ blocking: false, label: "Text limited" }]);
    expect(attachmentWarningsForModel([
      document({ status: "complete", truncated: false })
    ], selected)).toEqual([]);
    expect(attachmentWarningsForModel([
      document({ status: "complete", truncated: true })
    ], selected)).toEqual([]);
    expect(firstBlockingAttachmentWarning([
      document({ status: "partial", truncated: true })
    ], selected)).toBeNull();
  });

  describe("server PDF route preview", () => {
    const unavailable = { available: false, reasonCode: "pdf_processing_configuration_incomplete" } as const;
    const pdf = { fileName: "paper.pdf", id: "pdf", kind: "pdf" as const, status: "ready" as const };
    const noText = { ...pdf, id: "scan", processing: {
      extractedCharacterCount: 0, pageCount: 3, pagesProcessed: 3, status: "no_text" as const
    } };
    const others = [
      { fileName: "notes.txt", id: "document", kind: "document" as const, status: "ready" as const },
      { fileName: "image.png", id: "image", kind: "image" as const, status: "ready" as const },
      { fileName: "data.bin", id: "file", kind: "file" as const, status: "ready" as const }
    ];
    const routeWarning = (attachmentId: string) => ({
      attachmentId,
      blocking: true,
      code: "pdf_processing_configuration_incomplete",
      label: "Can't read PDF",
      message: "No PDF-reading model is configured for this installation."
    });

    it.each([
      ["a model without native PDF input", model("pdf_text_extraction", false), false],
      ["a native-PDF model", model("native_pdf", false), false],
      ["Workspace", model("pdf_text_extraction", false), true]
    ])("blocks every PDF with an honest reason when admission has no route for %s", (_label, selected, workspace) => {
      expect(attachmentWarningsForModel([pdf, noText, ...others], selected, workspace, unavailable))
        .toEqual([routeWarning("pdf"), routeWarning("scan")]);
      expect(firstBlockingAttachmentWarning([...others, pdf], selected, workspace, unavailable))
        .toEqual(routeWarning("pdf"));
      // The PDF stays attached and explained instead of being silently removed.
      expect(partitionAttachmentsForModel([pdf], selected, workspace)).toEqual({ supported: [pdf], unsupported: [] });
      expect(attachmentPolicyForModel(selected, workspace).pdfs).toBe(true);
    });

    it.each([
      ["direct_pdf", model("native_pdf", false)],
      ["system_pdf", model("pdf_text_extraction", false)],
      ["system_vision", model("pdf_text_extraction", false)]
    ] as const)("keeps a PDF ready when the %s route is available", (route, selected) => {
      const available = { available: true, route } as const;
      expect(attachmentWarningsForModel([pdf, ...others], selected, false, available)).toEqual([]);
      expect(firstBlockingAttachmentWarning([pdf], selected, false, available)).toBeNull();
      expect(attachmentWarningsForModel([pdf], selected, true, available)).toEqual([]);
    });

    describe("extraction state once a route reads the original", () => {
      const base = { fileName: "scan.pdf", id: "scan", kind: "pdf" as const };
      const states = {
        complete: { ...base, status: "ready" as const, processing: {
          extractedCharacterCount: 40, pageCount: 2, pagesProcessed: 2, status: "complete" as const } },
        failed: { ...base, processingErrorCode: "pdf_extraction_failed", status: "failed" as const },
        noText: { ...base, status: "ready" as const, processing: {
          extractedCharacterCount: 0, pageCount: 2, pagesProcessed: 2, status: "no_text" as const } },
        processing: { ...base, status: "processing" as const },
        zeroPartial: { ...base, status: "ready" as const, processing: {
          extractedCharacterCount: 0, pageCount: 9, pagesProcessed: 1, status: "partial" as const,
          truncationReason: "text_limit" as const } }
      };
      const extraction = model("pdf_text_extraction", false);
      const native = model("native_pdf", false);
      const blocked = (attachment: (typeof states)[keyof typeof states], selected: CatalogModel,
        route: Parameters<typeof attachmentBlocksSend>[3]) =>
        attachmentBlocksSend(attachment, selected, false, route) ||
        Boolean(firstBlockingAttachmentWarning([attachment], selected, false, route));

      it.each([
        ["direct_pdf", native],
        ["system_pdf", extraction],
        ["system_vision", extraction],
        ["system_vision", native]
      ] as const)("accepts every extraction state with the %s route", (route, selected) => {
        const available = { available: true, route } as const;
        for (const attachment of Object.values(states)) {
          expect(blocked(attachment, selected, available), attachment.status).toBe(false);
        }
        expect(attachmentWarningsForModel([states.noText], selected, false, available)).toEqual([
          expect.objectContaining({ blocking: false, label: "No text", message: route === "direct_pdf"
            ? "No extractable text was found. This model can use the original PDF."
            : "No extractable text was found. The assigned PDF reader will read the original PDF." })
        ]);
      });

      it("keeps storage and integrity failures blocking with a route", () => {
        const available = { available: true, route: "system_vision" } as const;
        for (const code of ["attachment_checksum_mismatch", "attachment_object_read_failed",
          "attachment_object_size_mismatch", "attachment_unavailable"]) {
          expect(attachmentBlocksSend({ ...states.failed, processingErrorCode: code }, extraction, false, available)).toBe(true);
        }
      });

      it("keeps today's behavior while the route is unknown or reads only local text", () => {
        for (const route of [null, { available: true, route: "local_text" } as const]) {
          expect(blocked(states.complete, extraction, route)).toBe(false);
          expect(blocked(states.processing, extraction, route)).toBe(true);
          expect(blocked(states.failed, extraction, route)).toBe(true);
          expect(blocked(states.noText, extraction, route)).toBe(true);
          expect(blocked(states.zeroPartial, extraction, route)).toBe(true);
        }
        for (const attachment of Object.values(states)) {
          expect(blocked(attachment, native, null), attachment.status).toBe(false);
        }
      });

      it("blocks every extraction state when no route exists", () => {
        const unavailable = { available: false, reasonCode: "pdf_processing_configuration_incomplete" } as const;
        for (const attachment of Object.values(states)) {
          expect(blocked(attachment, native, unavailable), attachment.status).toBe(true);
        }
      });
    });

    it("keeps only the local checks while the route is unknown", () => {
      const selected = model("pdf_text_extraction", false);
      expect(attachmentWarningsForModel([pdf], selected, false, null)).toEqual([]);
      expect(attachmentWarningsForModel([noText], selected, false, null))
        .toEqual([expect.objectContaining({ blocking: true, label: "No text" })]);
      expect(attachmentWarningsForModel([noText], selected, true, null)).toEqual([]);
    });
  });

  describe("server image-route projection", () => {
    const withRoutes = (imageInput: boolean, toolCalling: boolean, imageRoutes?: CatalogModel["capabilities"]["imageRoutes"]): CatalogModel => {
      const base = model("pdf_text_extraction", imageInput);
      return { ...base, displayName: "Text model", capabilities: { ...base.capabilities, toolCalling, ...(imageRoutes ? { imageRoutes } : {}) } };
    };
    const image = { fileName: "photo.webp", id: "photo", kind: "image" as const };

    it.each([
      ["the model's own image input", withRoutes(true, false), true],
      ["chat System Vision", withRoutes(false, true, { systemVision: true, imageEditing: false }), true],
      ["image-model editing", withRoutes(false, true, { systemVision: false, imageEditing: true }), true],
      ["no route", withRoutes(false, true, { systemVision: false, imageEditing: false }), false],
      ["an unknown projection", withRoutes(false, true), false]
    ])("admits images exactly when run admission would: %s", (_label, selected, admitted) => {
      expect(imageRouteAvailable(selected)).toBe(admitted);
      expect(attachmentPolicyForModel(selected).images).toBe(admitted);
      expect(attachmentAcceptForPolicy(attachmentPolicyForModel(selected)).includes(".webp")).toBe(admitted);
      expect(partitionAttachmentsForModel([image], selected).supported).toEqual(admitted ? [image] : []);
      // Workspace still takes every image.
      expect(attachmentPolicyForModel(selected, true).images).toBe(true);
    });

    it("explains a refused image and names the recovery that applies", () => {
      const toolModel = withRoutes(false, true, { systemVision: false, imageEditing: false });
      expect(unsupportedAttachmentMessage(["photo.webp"], toolModel)).toBe(
        "Text model does not support this attachment: photo.webp. Text model can't read images, and no Vision Model is available to analyze them. " +
        "To use images, choose a model that supports images or ask an administrator to assign the Vision Model.");
      expect(imageRouteUnavailableMessage(toolModel, true)).toBe("Text model can't read images, and no Vision Model is available to analyze them. " +
        "To use images, choose a model that supports images, turn on Workspace or ask an administrator to assign the Vision Model.");
      expect(unsupportedAttachmentMessage(["photo.png"], withRoutes(false, false), true)).toBe(
        "Removed an attachment unsupported by Text model: photo.png. Text model can't read images. To use images, choose a model that supports images.");
      // Other refusals and images a route accepts keep the plain message.
      expect(unsupportedAttachmentMessage(["data.bin"], toolModel)).toBe("Text model does not support this attachment: data.bin");
      expect(unsupportedAttachmentMessage(["photo.webp"], withRoutes(false, true, { systemVision: true, imageEditing: false })))
        .toBe("Text model does not support this attachment: photo.webp");
    });
  });
});
