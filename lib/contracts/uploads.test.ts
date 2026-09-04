import { describe, expect, it } from "vitest";
import {
  decodeAttachmentLibraryResponse,
  decodePdfProcessing,
  decodeUploadAttachmentResponse,
  decodeUploadErrorResponse
} from "./uploads";

describe("upload wire decoders", () => {
  it("accepts only bounded sent-file navigation projections", () => {
    expect(decodeAttachmentLibraryResponse({
      files: [{
        byteSize: 1_024,
        chatId: "chat-1",
        chatTitle: "Research",
        createdAt: "2026-08-22T10:00:00.000Z",
        fileName: "notes.txt",
        id: "attachment-1",
        messageId: "message-1",
        privateStorageKey: "must-not-project",
        status: "ready"
      }]
    })).toEqual({
      files: [{
        byteSize: 1_024,
        chatId: "chat-1",
        chatTitle: "Research",
        createdAt: "2026-08-22T10:00:00.000Z",
        fileName: "notes.txt",
        id: "attachment-1",
        messageId: "message-1",
        status: "ready"
      }]
    });
    expect(decodeAttachmentLibraryResponse({
      files: [{
        byteSize: 1,
        chatId: "chat-1",
        chatTitle: "Research",
        createdAt: "invalid",
        fileName: "notes.txt",
        id: "attachment-1",
        messageId: "message-1",
        status: "ready"
      }]
    })).toBeNull();
  });

  it("projects only bounded, internally consistent PDF processing evidence", () => {
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 20_000,
        pageCount: 12,
        pagesProcessed: 7,
        privateChunks: ["do not project"],
        status: "partial",
        truncationReason: "text_limit"
      })
    ).toEqual({
      extractedCharacterCount: 20_000,
      pageCount: 12,
      pagesProcessed: 7,
      status: "partial",
      truncationReason: "text_limit"
    });
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 0,
        pageCount: 3,
        pagesProcessed: 3,
        status: "no_text"
      })
    ).toEqual({
      extractedCharacterCount: 0,
      pageCount: 3,
      pagesProcessed: 3,
      status: "no_text"
    });
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 128,
        pageCount: 1,
        pagesProcessed: 1,
        status: "complete"
      })
    ).toEqual({
      extractedCharacterCount: 128,
      pageCount: 1,
      pagesProcessed: 1,
      status: "complete"
    });
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 0,
        pageCount: 1,
        pagesProcessed: 1,
        status: "partial",
        truncationReason: "text_limit"
      })
    ).toEqual({
      extractedCharacterCount: 0,
      pageCount: 1,
      pagesProcessed: 1,
      status: "partial",
      truncationReason: "text_limit"
    });
  });

  it("rejects malformed or contradictory PDF processing evidence", () => {
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1,
        pageCount: 2,
        pagesProcessed: 3,
        status: "partial",
        truncationReason: "text_limit"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1_000_001,
        pageCount: 1,
        pagesProcessed: 1,
        status: "complete"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1,
        pageCount: 501,
        pagesProcessed: 501,
        status: "complete"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 2,
        status: "partial"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1,
        pageCount: 2,
        pagesProcessed: 2,
        status: "no_text"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1.5,
        pageCount: 2,
        pagesProcessed: 2,
        status: "complete"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 1,
        pageCount: 2,
        pagesProcessed: 1,
        status: "complete"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 0,
        pageCount: 1,
        pagesProcessed: 1,
        status: "complete"
      })
    ).toBeNull();
    expect(
      decodePdfProcessing({
        extractedCharacterCount: 0,
        pageCount: 0,
        pagesProcessed: 0,
        status: "partial",
        truncationReason: "text_limit"
      })
    ).toBeNull();
  });

  it("decodes a safe PDF processing projection without exposing server-only fields", () => {
    expect(
      decodeUploadAttachmentResponse({
        attachment: {
          byteSize: 1234,
          checksum: "private-checksum",
          extractedText: "bounded text",
          fileName: "notes.pdf",
          id: "attachment-1",
          kind: "pdf",
          metadata: { pdf: { chunks: ["server-only"] } },
          mimeType: "application/pdf",
          processing: {
            extractedCharacterCount: 12,
            pageCount: 4,
            pagesProcessed: 2,
            rawParserDetails: "private",
            status: "partial",
            truncationReason: "text_limit"
          },
          status: "ready",
          storageKey: "private/object"
        }
      })
    ).toEqual({
      attachment: {
        byteSize: 1234,
        extractedText: "bounded text",
        fileName: "notes.pdf",
        id: "attachment-1",
        kind: "pdf",
        mimeType: "application/pdf",
        processing: {
          extractedCharacterCount: 12,
          pageCount: 4,
          pagesProcessed: 2,
          status: "partial",
          truncationReason: "text_limit"
        },
        status: "ready"
      }
    });
  });

  it("rejects invalid processing projections and processing on non-PDF attachments", () => {
    const attachment = {
      fileName: "notes.pdf",
      id: "attachment-1",
      kind: "pdf",
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 1,
        status: "no_text"
      }
    };

    expect(decodeUploadAttachmentResponse({ attachment })).toBeNull();
    expect(
      decodeUploadAttachmentResponse({
        attachment: {
          ...attachment,
          kind: "document",
          processing: {
            extractedCharacterCount: 3,
            pageCount: 1,
            pagesProcessed: 1,
            status: "complete"
          }
        }
      })
    ).toBeNull();
  });

  it("accepts only closed lifecycle states and bounded safe processing codes", () => {
    expect(decodeUploadAttachmentResponse({
      attachment: {
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        processingErrorCode: "parser_unavailable",
        status: "failed",
        updatedAt: "2026-08-08T00:00:00.000Z"
      }
    })).toEqual({
      attachment: {
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        processingErrorCode: "parser_unavailable",
        status: "failed",
        updatedAt: "2026-08-08T00:00:00.000Z"
      }
    });
    expect(decodeUploadAttachmentResponse({
      attachment: {
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        status: "queued"
      }
    })).toBeNull();
    expect(decodeUploadAttachmentResponse({
      attachment: {
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        processingErrorCode: "private/path",
        status: "failed"
      }
    })).toBeNull();
  });

  it("accepts only known safe upload failures", () => {
    expect(decodeUploadErrorResponse({ error: "file_too_large", limit: 26_048_576 })).toEqual({
      error: "file_too_large",
      limit: 26_048_576
    });
    expect(decodeUploadErrorResponse({ error: "upload_busy" })).toEqual({ error: "upload_busy" });
    expect(decodeUploadErrorResponse({ error: "workspace_runtime_unavailable" })).toEqual({
      error: "workspace_runtime_unavailable"
    });
    expect(
      decodeUploadErrorResponse({
        error: "pdf_page_limit_exceeded",
        maxPages: 500,
        message: "This PDF has more than 500 pages.",
        parserMessage: "private"
      })
    ).toEqual({
      error: "pdf_page_limit_exceeded",
      maxPages: 500,
      message: "This PDF has more than 500 pages."
    });
    expect(
      decodeUploadErrorResponse({
        error: "pdf_password_required",
        message: "Password-protected PDFs are not supported."
      })
    ).toEqual({
      error: "pdf_password_required",
      message: "Password-protected PDFs are not supported."
    });
    expect(decodeUploadErrorResponse({ error: "storage_failed", message: "private" })).toBeNull();
    expect(
      decodeUploadErrorResponse({ error: "pdf_too_complex", message: "Private internal error." })
    ).toBeNull();
    expect(decodeUploadErrorResponse({ error: "file_too_large", limit: -1 })).toBeNull();
    expect(
      decodeUploadErrorResponse({
        error: "pdf_page_limit_exceeded",
        message: "Missing the required safe maximum."
      })
    ).toBeNull();
    expect(
      decodeUploadErrorResponse({
        error: "pdf_invalid",
        maxPages: 500,
        message: "This PDF is damaged or invalid."
      })
    ).toBeNull();
    expect(
      decodeUploadErrorResponse({
        error: "pdf_page_limit_exceeded",
        maxPages: 501,
        message: "Untrusted maximum."
      })
    ).toBeNull();
    expect(
      decodeUploadErrorResponse({
        error: "pdf_invalid",
        message: "raw parser detail\nprivate path"
      })
    ).toBeNull();
  });
});
