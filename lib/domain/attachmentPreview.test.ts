import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES } from "@/lib/contracts/imageGeneration";
import { attachmentPreviewKind, isPdfFileName, PDF_PREVIEW_MAX_BYTES, TEXT_PREVIEW_MAX_BYTES } from "./attachmentPreview";

describe("attachment preview eligibility", () => {
  const ready = { byteSize: 12, fileName: "result.bin", mimeType: "application/octet-stream", status: "ready" };

  it.each(["png", "jpeg", "webp", "gif"])("permits ready %s images within the shared byte bound", format => {
    const file = { ...ready, mimeType: `image/${format}`, byteSize: IMAGE_MAX_BYTES };
    expect(attachmentPreviewKind(file)).toBe("image");
    expect(attachmentPreviewKind({ ...file, byteSize: IMAGE_MAX_BYTES + 1 })).toBeNull();
    expect(attachmentPreviewKind({ ...file, status: "processing" })).toBeNull();
  });

  it.each(["txt", "MD", "markdown", "json", "csv", "html", "htm", "xml", "yaml", "yml", "toml", "ini", "log", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sh", "sql", "svg"])(
    "permits %s as bounded source text without expanding upload admission", extension => {
      const file = { ...ready, fileName: `result.${extension}`, byteSize: TEXT_PREVIEW_MAX_BYTES };
      expect(attachmentPreviewKind(file)).toBe("text");
      expect(attachmentPreviewKind({ ...file, byteSize: TEXT_PREVIEW_MAX_BYTES + 1 })).toBeNull();
    }
  );

  it("keeps active formats inert and rejects unsupported, invalid and unsettled files", () => {
    expect(attachmentPreviewKind({ ...ready, fileName: "page.html", mimeType: "text/html" })).toBe("text");
    expect(attachmentPreviewKind({ ...ready, fileName: "shape.svg", mimeType: "image/svg+xml" })).toBe("text");
    expect(attachmentPreviewKind({ ...ready, fileName: `${"記録".repeat(60)}.md` })).toBe("text");
    for (const fileName of ["report.docx", "report.xlsx", "report.pptx", "image.tiff", "unknown", "opaque.bin"]) {
      expect(attachmentPreviewKind({ ...ready, fileName })).toBeNull();
    }
    for (const byteSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(attachmentPreviewKind({ ...ready, fileName: "note.txt", byteSize })).toBeNull();
    }
    for (const status of ["pending", "processing", "failed"]) {
      expect(attachmentPreviewKind({ ...ready, fileName: "note.txt", status })).toBeNull();
    }
  });

  it("opens a PDF in its viewer by type or name, up to the hard upload ceiling", () => {
    expect(attachmentPreviewKind({ ...ready, fileName: "report.PDF" })).toBe("pdf");
    expect(attachmentPreviewKind({ ...ready, fileName: "report", mimeType: "application/pdf" })).toBe("pdf");
    expect(attachmentPreviewKind({ ...ready, fileName: "report.pdf", byteSize: PDF_PREVIEW_MAX_BYTES })).toBe("pdf");
    expect(attachmentPreviewKind({ ...ready, fileName: "report.pdf", byteSize: PDF_PREVIEW_MAX_BYTES + 1 })).toBeNull();
    expect(attachmentPreviewKind({ ...ready, fileName: "report.pdf", status: "processing" })).toBeNull();
    expect(isPdfFileName(".pdf")).toBe(false);
  });
});
