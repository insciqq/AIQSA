import { describe, expect, it } from "vitest";
import { defaultUploadMaxBytes, validateUpload } from "./validation";

const magicFixtures = [
  {
    bytes: Buffer.from("%PDF-1.4\n"),
    fileName: "brief.pdf",
    kind: "pdf",
    mimeType: "application/pdf"
  },
  {
    bytes: Buffer.from("plain text"),
    fileName: "notes.txt",
    kind: "document",
    mimeType: "text/plain"
  },
  {
    bytes: Buffer.from("GIF89a"),
    fileName: "image.gif",
    kind: "image",
    mimeType: "image/gif"
  },
  {
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    fileName: "image.jpg",
    kind: "image",
    mimeType: "image/jpeg"
  },
  {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    fileName: "image.png",
    kind: "image",
    mimeType: "image/png"
  },
  {
    bytes: Buffer.from("RIFF\x00\x00\x00\x00WEBP", "binary"),
    fileName: "image.webp",
    kind: "image",
    mimeType: "image/webp"
  }
] as const;

describe("upload validation", () => {
  it("reads the canonical upload-size setting and falls back safely", () => {
    expect(defaultUploadMaxBytes({ AIQSA_UPLOAD_MAX_BYTES: "1048576" })).toBe(1_048_576);
    expect(defaultUploadMaxBytes({ AIQSA_UPLOAD_MAX_BYTES: "invalid" })).toBe(25_000_000);
    expect(defaultUploadMaxBytes({})).toBe(25_000_000);
  });

  it("accepts allowed PDF, image, and text document types by MIME and extension", () => {
    expect(
      validateUpload({
        byteSize: 128,
        fileName: "brief.pdf",
        maxBytes: 1024,
        mimeType: "application/pdf"
      })
    ).toEqual({ kind: "pdf", mimeType: "application/pdf", ok: true });
    expect(
      validateUpload({
        byteSize: 128,
        fileName: "image.png",
        maxBytes: 1024,
        mimeType: "image/png"
      })
    ).toEqual({ kind: "image", mimeType: "image/png", ok: true });

    for (const fixture of [
      { fileName: "notes.txt", mimeType: "text/plain" },
      { fileName: "notes.md", mimeType: "text/plain" },
      { fileName: "notes.markdown", mimeType: "text/markdown" },
      { fileName: "rows.csv", mimeType: "text/csv" },
      { fileName: "payload.json", mimeType: "application/json" },
      { fileName: "page.html", mimeType: "text/html" },
      { fileName: "page.htm", mimeType: "text/html" }
    ]) {
      const result = validateUpload({
        byteSize: 128,
        fileName: fixture.fileName,
        maxBytes: 1024,
        mimeType: fixture.mimeType
      });

      expect(result).toMatchObject({ kind: "document", ok: true });
    }
  });

  it("rejects unsupported and oversized files", () => {
    expect(
      validateUpload({
        byteSize: 128,
        fileName: "notes.docx",
        maxBytes: 1024,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ).toEqual({ code: "unsupported_type", ok: false });
    expect(
      validateUpload({
        byteSize: 128,
        fileName: "clip.mp4",
        maxBytes: 1024,
        mimeType: "video/mp4"
      })
    ).toEqual({ code: "unsupported_type", ok: false });
    expect(
      validateUpload({
        byteSize: 2048,
        fileName: "brief.pdf",
        maxBytes: 1024,
        mimeType: "application/pdf"
      })
    ).toEqual({ code: "file_too_large", ok: false });
  });

  it("accepts allowed types only when magic bytes match", () => {
    for (const fixture of magicFixtures) {
      expect(
        validateUpload({
          byteSize: fixture.bytes.byteLength,
          bytes: fixture.bytes,
          fileName: fixture.fileName,
          maxBytes: 1024,
          mimeType: fixture.mimeType
        })
      ).toMatchObject({ kind: fixture.kind, ok: true });
    }
  });

  it("derives canonical MIME types from the validated extension", () => {
    expect(
      validateUpload({
        byteSize: 128,
        bytes: Buffer.from("# Heading"),
        fileName: "notes.md",
        maxBytes: 1024,
        mimeType: "text/plain"
      })
    ).toEqual({ kind: "document", mimeType: "text/markdown", ok: true });
  });

  it("rejects spoofed and truncated magic bytes", () => {
    expect(
      validateUpload({
        byteSize: 9,
        bytes: Buffer.from("%PDF-1.4\n"),
        fileName: "spoof.png",
        maxBytes: 1024,
        mimeType: "image/png"
      })
    ).toEqual({ code: "unsupported_type", ok: false });

    expect(
      validateUpload({
        byteSize: 4,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        fileName: "truncated.png",
        maxBytes: 1024,
        mimeType: "image/png"
      })
    ).toEqual({ code: "unsupported_type", ok: false });

    expect(
      validateUpload({
        byteSize: 5,
        bytes: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
        fileName: "spoof.txt",
        maxBytes: 1024,
        mimeType: "text/plain"
      })
    ).toEqual({ code: "unsupported_type", ok: false });
  });
});
