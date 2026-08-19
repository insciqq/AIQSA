import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  UPLOAD_FORMAT_REGISTRY,
  normalizedUploadFileExtension,
  uploadAcceptFor,
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
      .toEqual(["attachment"]);
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
  });

  it("uses extension plus bounded MIME evidence and treats empty/octet-stream MIME as hints", () => {
    expect(uploadFormatFor("scan.PDF", "", "knowledge")?.id).toBe("pdf");
    expect(uploadFormatFor("scan.pdf", "application/octet-stream", "knowledge")?.id).toBe("pdf");
    expect(uploadFormatFor("notes.md", "text/plain; charset=utf-8", "knowledge")?.id)
      .toBe("markdown");
    expect(uploadFormatFor("scan.pdf", "text/plain", "knowledge")).toBeUndefined();
    expect(uploadFormatFor("animation.gif", "image/gif", "knowledge")).toBeUndefined();
    expect(uploadFormatFor("animation.gif", "image/gif", "attachment")?.id).toBe("gif");
  });

  it("rejects path-like, missing, and overlong basenames consistently", () => {
    expect(normalizedUploadFileExtension("../paper.pdf")).toBeUndefined();
    expect(normalizedUploadFileExtension("paper")).toBeUndefined();
    expect(normalizedUploadFileExtension("paper\0.pdf")).toBeUndefined();
    expect(normalizedUploadFileExtension(`${"a".repeat(252)}.pdf`)).toBeUndefined();
  });
});
