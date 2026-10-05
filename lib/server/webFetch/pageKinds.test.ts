import { describe, expect, it } from "vitest";
import { declaredFetchedContentKind, fetchedContentKind, pageContentKind } from "./pageKinds";

const bytes = (value: string) => new TextEncoder().encode(value);
const pdf = bytes("%PDF-1.7\n%âã\n1 0 obj");

describe("fetched content kinds", () => {
  it("reads a declared PDF and sniffs the PDF signature for a missing or generic binary type", () => {
    expect(declaredFetchedContentKind("application/pdf")).toBe("pdf");
    expect(declaredFetchedContentKind("Application/PDF; name=paper.pdf")).toBe("pdf");
    expect(declaredFetchedContentKind("application/octet-stream")).toBe("pdf_sniff");
    expect(declaredFetchedContentKind(null)).toBe("sniff");
    expect(fetchedContentKind(bytes("<html>error page</html>"), "application/pdf")).toBe("pdf");
    expect(fetchedContentKind(pdf, null)).toBe("pdf");
    expect(fetchedContentKind(pdf, "application/octet-stream")).toBe("pdf");
    expect(fetchedContentKind(pdf, "binary/octet-stream")).toBe("pdf");
  });

  it("keeps other binaries refused and pages read as pages", () => {
    expect(fetchedContentKind(Uint8Array.from([0x50, 0x4b, 3, 4, 0]), "application/octet-stream")).toBeNull();
    expect(fetchedContentKind(bytes("plain words"), "application/octet-stream")).toBeNull();
    expect(fetchedContentKind(bytes(" %PDF-1.7"), "application/octet-stream")).toBeNull();
    expect(fetchedContentKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0]), null)).toBeNull();
    expect(fetchedContentKind(pdf, "image/png")).toBeNull();
    expect(fetchedContentKind(bytes("<!doctype html><p>x</p>"), null)).toBe("html");
    expect(fetchedContentKind(bytes("%PDF- is a signature"), "text/plain")).toBe("text");
    // The page parser never reads a PDF itself.
    expect(pageContentKind(pdf, "application/pdf")).toBeNull();
  });
});
