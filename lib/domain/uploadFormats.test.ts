import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_UPLOAD_FORMAT_LABELS,
  KNOWLEDGE_UPLOAD_ACCEPT,
  UPLOAD_FORMAT_REGISTRY,
  normalizedUploadFileExtension,
  isSafeUploadFileName,
  normalizedRasterUploadFileName,
  uploadAcceptFor,
  uploadAdmissionFormatFor,
  uploadFormatFor
} from "./uploadFormats";

describe("canonical upload format registry", () => {
  it("keeps every Knowledge-admitted format connected to a parser route", () => {
    const knowledgeFormats = UPLOAD_FORMAT_REGISTRY.filter((format) =>
      format.scopes.includes("knowledge")
    );

    expect(knowledgeFormats.length).toBeGreaterThan(20);
    expect(knowledgeFormats.every((format) => format.parser !== null)).toBe(true);
    expect(knowledgeFormats.some((format) => format.id === "gif")).toBe(false);
    expect(UPLOAD_FORMAT_REGISTRY.find((format) => format.id === "gif")?.scopes)
      .toEqual(["attachment", "workspace"]);
  });

  it("derives browser filters from the same extensions and canonical MIME types", () => {
    const expected = UPLOAD_FORMAT_REGISTRY
      .filter((format) => format.scopes.includes("knowledge"))
      .flatMap((format) => [...format.extensions, format.canonicalMimeType]);

    for (const token of expected) {
      expect(KNOWLEDGE_UPLOAD_ACCEPT.split(",")).toContain(token);
    }
    expect(KNOWLEDGE_UPLOAD_ACCEPT).not.toContain(".gif");
    expect(uploadAcceptFor({ kinds: [], scope: "attachment" })).toBe("");
    expect(uploadAcceptFor({ scope: "workspace" })).toBe("");
  });

  it("derives attachment help labels from the registry attachment scope", () => {
    const expected = UPLOAD_FORMAT_REGISTRY
      .filter((format) => format.scopes.includes("attachment"))
      .map((format) => format.label);

    expect(expected.length).toBeGreaterThan(0);
    expect(ATTACHMENT_UPLOAD_FORMAT_LABELS).toEqual(expected);
    expect(Object.isFrozen(ATTACHMENT_UPLOAD_FORMAT_LABELS)).toBe(true);
  });

  it("uses extension plus bounded MIME evidence and treats empty/octet-stream MIME as hints", () => {
    expect(uploadFormatFor("scan.PDF", "", "knowledge")?.id).toBe("pdf");
    expect(uploadFormatFor("scan.pdf", "application/octet-stream", "knowledge")?.id).toBe("pdf");
    expect(uploadFormatFor("notes.md", "text/plain; charset=utf-8", "knowledge")?.id)
      .toBe("markdown");
    expect(uploadFormatFor("scan.pdf", "text/plain", "knowledge")).toBeUndefined();
    expect(uploadFormatFor("animation.gif", "image/gif", "knowledge")).toBeUndefined();
    expect(uploadFormatFor("animation.gif", "image/gif", "attachment")?.id).toBe("gif");
    expect(uploadFormatFor("book.epub", "application/epub+zip", "workspace")?.id).toBe("epub");
  });

  it("rejects path-like, missing, and overlong basenames consistently", () => {
    expect(normalizedUploadFileExtension("../paper.pdf")).toBeUndefined();
    expect(normalizedUploadFileExtension("paper")).toBeUndefined();
    expect(normalizedUploadFileExtension("paper\0.pdf")).toBeUndefined();
    expect(normalizedUploadFileExtension(`${"a".repeat(252)}.pdf`)).toBeUndefined();
    expect(isSafeUploadFileName("opaque-without-extension")).toBe(true);
    expect(isSafeUploadFileName("../opaque.bin")).toBe(false);
  });

  it("admits a static-raster extension with another raster MIME only for chat and Workspace uploads", () => {
    for (const scope of ["attachment", "workspace"] as const) {
      for (const mime of ["image/png", "image/jpeg", "image/jpg", "image/webp", "IMAGE/PNG; q=1", "", "not a mime", "application/octet-stream"]) {
        expect(uploadAdmissionFormatFor("synthetic.jpeg", mime, scope)?.id).toBe("jpeg");
        expect(uploadAdmissionFormatFor("synthetic.png", mime, scope)?.id).toBe("png");
        expect(uploadAdmissionFormatFor("synthetic.webp", mime, scope)?.id).toBe("webp");
      }
      expect(uploadAdmissionFormatFor("synthetic.jpeg", "image/gif", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("synthetic.jpeg", "image/svg+xml", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("synthetic.png", "text/plain", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("animation.gif", "image/png", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("synthetic", "image/png", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("notes.pdf", "image/png", scope)).toBeUndefined();
      expect(uploadAdmissionFormatFor("animation.gif", "image/gif", scope)?.id).toBe("gif");
    }
    expect(uploadAdmissionFormatFor("synthetic.jpeg", "image/png", "knowledge")).toBeUndefined();
    expect(uploadAdmissionFormatFor("scan.tif", "image/png", "knowledge")).toBeUndefined();
    expect(uploadAdmissionFormatFor("synthetic.jpeg", "image/jpeg", "knowledge")?.id).toBe("jpeg");
  });

  it("renames only the last extension of a verified raster and keeps names that already fit", () => {
    const format = (id: string) => UPLOAD_FORMAT_REGISTRY.find((candidate) => candidate.id === id)!;
    expect(normalizedRasterUploadFileName("synthetic.jpeg", format("png"))).toBe("synthetic.png");
    expect(normalizedRasterUploadFileName("archive.v2.PNG", format("jpeg"))).toBe("archive.v2.jpg");
    expect(normalizedRasterUploadFileName("photo.JPEG", format("jpeg"))).toBe("photo.JPEG");
    expect(normalizedRasterUploadFileName("photo.jpg", format("webp"))).toBe("photo.webp");
    expect(normalizedRasterUploadFileName(`${"a".repeat(251)}.png`, format("jpeg"))).toBe(`${"a".repeat(251)}.jpg`);
    expect(normalizedRasterUploadFileName(`${"a".repeat(251)}.png`, format("webp"))).toBeUndefined();
  });
});
