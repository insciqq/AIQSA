// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { DocumentParserError } from "../parsing";
import {
  AttachmentProcessingError,
  createAttachmentProcessor,
  type AttachmentProcessingRecord
} from "./processing";

function createTinyPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length + 35} >>\nstream\nBT /F1 12 Tf 40 140 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function record(
  bytes: Buffer,
  overrides: Partial<AttachmentProcessingRecord> = {}
): AttachmentProcessingRecord {
  return {
    attemptCount: 1,
    byteSize: bytes.byteLength,
    checksum: null,
    claimToken: "lease-1",
    fileName: "notes.txt",
    id: "attachment-1",
    jobId: "job-1",
    kind: "document",
    mimeType: "text/plain",
    storageKey: "private/object",
    ...overrides
  };
}

function storage(bytes: Buffer) {
  return {
    getObject: vi.fn(async (storageKey: string) => ({
      body: bytes,
      contentType: "application/octet-stream",
      storageKey
    }))
  };
}

describe("attachment processor", () => {
  it("extracts current inline document types from settled private storage", async () => {
    const bytes = Buffer.from("# Runbook\r\nUse search.\r\n");
    const objectStorage = storage(bytes);
    const process = createAttachmentProcessor({ storage: objectStorage });

    const result = await process(record(bytes, {
      fileName: "runbook.md",
      mimeType: "text/markdown"
    }));

    expect(result.extractedText).toBe("# Runbook\nUse search.\n");
    expect(result.metadata).toMatchObject({
      document: {
        engine: "inline",
        status: "complete"
      }
    });
    expect(objectStorage.getObject).toHaveBeenCalledWith("private/object", {
      maxBytes: bytes.byteLength
    });
  });

  it("stores normalized sidecar evidence for Office documents", async () => {
    const bytes = Buffer.from("PK\u0003\u0004docx");
    const parser = {
      parse: vi.fn(async () => ({
        blocks: [],
        engine: "docling" as const,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: 2,
        status: "complete" as const,
        text: "Structured document text"
      }))
    };
    const process = createAttachmentProcessor({ parser, storage: storage(bytes) });

    const result = await process(record(bytes, {
      fileName: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));

    expect(result).toMatchObject({
      extractedText: "Structured document text",
      metadata: {
        document: {
          engine: "docling",
          pageCount: 2,
          parserStatus: "complete",
          status: "complete"
        }
      }
    });
  });

  it("falls back to bounded local PDF extraction when sidecars are stopped", async () => {
    const bytes = createTinyPdf("Fallback PDF text");
    const parser = {
      parse: vi.fn(async () => { throw new DocumentParserError("parser_unavailable"); })
    };
    const process = createAttachmentProcessor({ parser, storage: storage(bytes) });

    const result = await process(record(bytes, {
      fileName: "paper.pdf",
      kind: "pdf",
      mimeType: "application/pdf"
    }));

    expect(result).toMatchObject({
      extractedText: "Fallback PDF text",
      metadata: {
        pdf: {
          pageCount: 1,
          parserEngine: "unpdf",
          status: "complete"
        }
      }
    });
  });

  it("returns a clear retryable parser code for DOCX when sidecars are stopped", async () => {
    const bytes = Buffer.from("PK\u0003\u0004docx");
    const parser = {
      parse: vi.fn(async () => { throw new DocumentParserError("parser_unavailable"); })
    };
    const process = createAttachmentProcessor({ parser, storage: storage(bytes) });

    await expect(process(record(bytes, {
      fileName: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }))).rejects.toEqual(expect.objectContaining({
      code: "parser_unavailable",
      retryable: true
    } satisfies Partial<AttachmentProcessingError>));
  });

  it("fails closed on object-size disagreement before parsing", async () => {
    const bytes = Buffer.from("short");
    const parser = { parse: vi.fn() };
    const process = createAttachmentProcessor({ parser, storage: storage(bytes) });

    await expect(process(record(bytes, { byteSize: bytes.byteLength + 1 })))
      .rejects.toMatchObject({ code: "attachment_object_size_mismatch", retryable: false });
    expect(parser.parse).not.toHaveBeenCalled();
  });
});
