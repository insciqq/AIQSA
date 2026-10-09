import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { readArtifactTool } from "../tools/artifact";
import type { ArtifactBundle } from "./bundle";
import { artifactReadPage } from "./readPage";

type File = ArtifactBundle["files"][number];
const KIB = 1024;
const bundleOf = (files: File[]): ArtifactBundle => ({ version: 2, kind: "html", entrypoint: files[0]!.path, files });
const reader = (files: File[], maxBytes?: number) => {
  const input = { artifactId: "artifact", versionId: "version", ownerUserId: "owner", secret: "synthetic-test-secret", bundle: bundleOf(files), ...(maxBytes ? { maxBytes } : {}) };
  return (args: Record<string, unknown> = {}) => artifactReadPage({ ...input, args: { artifact_id: "artifact", ...args } });
};
type Page = { files: Array<{ path: string; offset: number; text?: string; bytes: number; length?: number; note?: string }>; truncated: boolean; next_cursor?: string };
type QueryPage = { query: string; matches: Array<{ path: string; offset: number; context_offset: number; context: string; cursor: string }>; truncated: boolean; next_cursor?: string };
const textBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
const wellFormed = (text: string) => !/\p{Cs}/u.test(text);

/** A referenced self-contained page: a small head, then mostly embedded data with multibyte runs. */
function largePage(bytes: number) {
  const head = "<!doctype html><html><head><title>Old title</title></head><body><img src=\"data:image/png;base64,";
  let body = "";
  const unit = "QUJDRA==🪿\"\\\n";
  while (Buffer.byteLength(head + body) < bytes) body += unit.repeat(256);
  return `${head}${body}"></body></html>`;
}

describe("read_artifact pages", () => {
  it("keeps the authored page size for a file within the authored limit", () => {
    const text = "a".repeat(ARTIFACT_LIMITS.maxTextFileBytes);
    const page = reader([{ path: "index.html", mimeType: "text/html", text }])() as Page;
    expect(Buffer.byteLength(page.files[0]!.text!)).toBeGreaterThan(ARTIFACT_LIMITS.maxReadBytes - KIB);
    expect(page.files[0]).not.toHaveProperty("note");
    expect(page.files[0]).not.toHaveProperty("length");
  });

  it("pages a large referenced file by the small cap, states its size and restores it exactly", () => {
    const text = largePage(ARTIFACT_LIMITS.maxTextFileBytes + 300 * KIB);
    const read = reader([{ path: "index.html", mimeType: "text/html", text }]);
    let restored = "";
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = read(cursor ? { cursor } : {}) as Page;
      const fragment = page.files[0]!;
      expect(page.files).toHaveLength(1);
      expect(fragment.offset).toBe(restored.length);
      expect(textBytes(fragment.text!)).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxLargeReadBytes);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxLargeReadBytes + 2 * KIB);
      expect(fragment).toMatchObject({ bytes: Buffer.byteLength(text), length: text.length });
      expect(fragment.note).toContain(`${Buffer.byteLength(text)} bytes`);
      expect(fragment.note).toContain("Large file supplied by reference");
      expect(wellFormed(fragment.text!)).toBe(true);
      restored += fragment.text;
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(restored).toBe(text);
    // Escaped quotes, backslashes and newlines count, so pages are smaller than the raw cap.
    expect(pages).toBeGreaterThan(Buffer.byteLength(text) / ARTIFACT_LIMITS.maxLargeReadBytes);
    expect(pages).toBeLessThan(3 * Buffer.byteLength(text) / ARTIFACT_LIMITS.maxLargeReadBytes);
    expect(restored.slice(0, 200)).toContain("<title>Old title</title>");
  });

  it("ends a page after one large-file page and continues with the following files", () => {
    const large = largePage(ARTIFACT_LIMITS.maxTextFileBytes + 40 * KIB);
    const read = reader([
      { path: "index.html", mimeType: "text/html", text: "<p>small</p>" },
      { path: "big.html", mimeType: "text/html", text: large },
      { path: "after.css", mimeType: "text/css", text: "p{color:red}" }
    ]);
    const seen: Record<string, string> = {};
    let cursor: string | undefined;
    const shapes: string[][] = [];
    do {
      const page = read(cursor ? { cursor } : {}) as Page;
      shapes.push(page.files.map(file => file.path));
      for (const file of page.files) seen[file.path] = (seen[file.path] ?? "") + file.text;
      expect(page.files.filter(file => file.path === "big.html").length).toBeLessThanOrEqual(1);
      cursor = page.next_cursor;
    } while (cursor);
    expect(shapes[0]).toEqual(["index.html", "big.html"]);
    expect(shapes.at(-1)).toEqual(["after.css"]);
    expect(seen).toEqual({ "index.html": "<p>small</p>", "big.html": large, "after.css": "p{color:red}" });
  });
});

describe("read_artifact query", () => {
  const text = largePage(ARTIFACT_LIMITS.maxTextFileBytes + 64 * KIB);
  const files: File[] = [
    { path: "index.html", mimeType: "text/html", text },
    { path: "image.png", mimeType: "image/png", base64: "AAAA" },
    { path: "notes.txt", mimeType: "text/plain", text: "QUJDRA== then caption QUJDRA==" }
  ];

  it("finds a tag in a large file with context and a cursor that reads from there", () => {
    const read = reader(files);
    const result = read({ query: "<title>" }) as QueryPage;
    expect(result).toMatchObject({ query: "<title>", truncated: false });
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match).toMatchObject({ path: "index.html", offset: text.indexOf("<title>"), context_offset: 0 });
    const end = match!.offset + "<title>".length + ARTIFACT_LIMITS.readQueryContextChars;
    expect(text.startsWith(match!.context)).toBe(true);
    expect(match!.context.length - end).toBeGreaterThanOrEqual(0);
    expect(match!.context.length - end).toBeLessThanOrEqual(1);
    const page = read({ cursor: match!.cursor }) as Page;
    expect(page.files[0]).toMatchObject({ path: "index.html", offset: 0 });
    expect(page.files[0]!.text).toContain("<title>Old title</title>");
  });

  it("returns at most five occurrences, continues from the first one left out and searches the following files", () => {
    const read = reader(files);
    const all: Array<{ path: string; offset: number }> = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const result = read({ query: "QUJDRA==", ...(cursor ? { cursor } : {}) }) as QueryPage;
      expect(result.matches.length).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxReadQueryMatches);
      for (const match of result.matches) {
        const source = files.find(file => file.path === match.path)!.text!;
        expect(source.slice(match.offset, match.offset + 8)).toBe("QUJDRA==");
        expect(source.slice(match.context_offset, match.context_offset + match.context.length)).toBe(match.context);
        expect(match.context_offset).toBeLessThanOrEqual(match.offset);
        expect(match.offset - match.context_offset).toBeLessThanOrEqual(ARTIFACT_LIMITS.readQueryContextChars + 1);
        expect(match.context.length).toBeLessThanOrEqual(2 * ARTIFACT_LIMITS.readQueryContextChars + 8 + 2);
        all.push({ path: match.path, offset: match.offset });
      }
      cursor = result.next_cursor;
      expect(result.truncated).toBe(cursor !== undefined);
      calls++;
    } while (cursor && calls < 3);
    expect(all).toHaveLength(3 * ARTIFACT_LIMITS.maxReadQueryMatches);
    expect(new Set(all.map(match => `${match.path}:${match.offset}`)).size).toBe(all.length);
    expect(all.slice(0, 3).map(match => match.offset)).toEqual([
      text.indexOf("QUJDRA=="), text.indexOf("QUJDRA==", text.indexOf("QUJDRA==") + 8), text.indexOf("QUJDRA==", text.indexOf("QUJDRA==", text.indexOf("QUJDRA==") + 8) + 8)]);
    // Searching only the small file finds both of its occurrences.
    const small = reader(files)({ query: "QUJDRA==", paths: ["notes.txt"] }) as QueryPage;
    expect(small.matches.map(match => [match.path, match.offset])).toEqual([["notes.txt", 0], ["notes.txt", 22]]);
    expect(small.truncated).toBe(false);
    // The search passes the binary file and reaches the next text file.
    expect((reader(files)({ query: "caption" }) as QueryPage).matches.map(match => [match.path, match.offset])).toEqual([["notes.txt", 14]]);
  });

  it("reports no matches, and keeps fewer occurrences under a small result budget", () => {
    expect(reader(files)({ query: "<h1>" })).toMatchObject({ matches: [], truncated: false });
    expect(reader(files)({ query: "<h1>" })).not.toHaveProperty("next_cursor");
    const budget = reader(files, 3 * KIB);
    const result = budget({ query: "QUJDRA==" }) as QueryPage;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(3 * KIB);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(ARTIFACT_LIMITS.maxReadQueryMatches);
    const next = budget({ query: "QUJDRA==", cursor: result.next_cursor }) as QueryPage;
    expect(next.matches[0]!.offset).toBeGreaterThan(result.matches.at(-1)!.offset);
  });

  it("never splits a surrogate pair at the context edges", () => {
    const geese = "🪿".repeat(400);
    for (const pad of ["", "x"]) {
      const source = `${geese}${pad}NEEDLE${pad}${geese}`;
      const read = reader([{ path: "index.html", mimeType: "text/html", text: source }]);
      const [match] = (read({ query: "NEEDLE" }) as QueryPage).matches;
      expect(match!.offset).toBe(source.indexOf("NEEDLE"));
      expect(wellFormed(match!.context)).toBe(true);
      expect(source.slice(match!.context_offset, match!.context_offset + match!.context.length)).toBe(match!.context);
      expect((read({ cursor: match!.cursor }) as Page).files[0]!.offset).toBe(match!.context_offset);
    }
    const goose = reader([{ path: "index.html", mimeType: "text/html", text: `a${geese}` }])({ query: "🪿🪿" }) as QueryPage;
    expect(goose.matches.map(match => match.offset)).toEqual([1, 5, 9, 13, 17]);
  });

  it("rejects an empty, oversized, malformed or non-string query", () => {
    const read = reader(files);
    for (const query of ["", "x".repeat(ARTIFACT_LIMITS.maxReadQueryLength + 1), "\uDEBF", "a\uD83E", 42]) {
      expect(() => read({ query })).toThrow("artifact_read_query_invalid");
    }
    expect(() => read({ query: "x".repeat(ARTIFACT_LIMITS.maxReadQueryLength) })).not.toThrow();
  });

  it("advertises the query argument and the large-file page size", () => {
    const tool = readArtifactTool();
    expect((tool.inputSchema.properties as Record<string, unknown>).query).toEqual({ type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxReadQueryLength });
    expect(tool.description).toContain("pages hold at most 32 KiB");
    expect(tool.description).toContain("query finds literal, case-sensitive text");
  });
});
