import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS, normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import {
  ARTIFACT_ERROR_EXCERPT_CHARACTERS,
  artifactErrorExcerpt,
  artifactExcerptBefore,
  artifactTextFromBytes,
  materializeArtifactReferences
} from "./referencedFiles";

const MIB = 1024 * 1024;
const lone = /[\uD800-\uDFFF]/u;

describe("bounded verbatim error excerpts", () => {
  it("keeps the failing construct with a little leading context", () => {
    const text = `${"a".repeat(500)}<meta http-equiv="refresh" content="0">${"b".repeat(500)}`;
    const start = text.indexOf("<meta");
    const excerpt = artifactErrorExcerpt(text, start, start + '<meta http-equiv="refresh" content="0">'.length);
    expect(excerpt.length).toBe(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
    expect(excerpt).toContain('<meta http-equiv="refresh" content="0">');
    expect(excerpt.startsWith("a".repeat(40) + "<meta")).toBe(true);
    expect(text).toContain(excerpt);
  });

  it("starts at a construct longer than the bound and clamps to the text", () => {
    const tag = `<iframe src="data:text/html,${"x".repeat(400)}">`;
    const text = `${"p".repeat(100)}${tag}`;
    const excerpt = artifactErrorExcerpt(text, 100, 100 + tag.length);
    expect(excerpt.startsWith("<iframe src=")).toBe(true);
    expect(excerpt.length).toBe(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
    expect(artifactErrorExcerpt("<p>", 0, 3)).toBe("<p>");
    expect(artifactErrorExcerpt("short", 99, 120)).toBe("");
  });

  it("never splits a surrogate pair at either edge", () => {
    const goose = "🪿";
    for (let shift = 0; shift < 4; shift++) {
      const text = `${"x".repeat(shift)}${goose.repeat(200)}`;
      for (const start of [41, 42, 43, 100, 101]) {
        const excerpt = artifactErrorExcerpt(text, start, start + 2);
        expect(lone.test(excerpt)).toBe(false);
        expect(text).toContain(excerpt);
        expect(excerpt.length).toBeLessThanOrEqual(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
      }
      for (const index of [201, 202, 250, 301]) {
        const before = artifactExcerptBefore(text, index);
        expect(lone.test(before)).toBe(false);
        expect(before.length).toBeLessThanOrEqual(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
        expect(text.slice(0, index)).toContain(before);
      }
    }
  });
});

describe("text supplied by reference", () => {
  it("decodes exact UTF-8, keeps a BOM and names the path of invalid bytes", () => {
    const bytes = Buffer.from("﻿<p>привет 🪿</p>", "utf8");
    const text = artifactTextFromBytes(bytes, "index.html");
    expect(Buffer.from(text, "utf8").equals(bytes)).toBe(true);
    expect(() => artifactTextFromBytes(Buffer.from([0x3c, 0x70, 0xff, 0x3e]), "legacy.html"))
      .toThrowError(expect.objectContaining({ code: "artifact_text_encoding_invalid", path: "legacy.html", hint: expect.stringContaining("UTF-8") }));
  });

  const operation = (edits?: unknown[]) => normalizeArtifactOperation({ intent: "create", kind: "html", title: "Ref", entrypoint: "index.html",
    files: [{ path: "index.html", mimeType: "text/html", assetRef: "html" }, { path: "clip.mp4", mimeType: "video/mp4", assetRef: "video" },
      { path: "style.css", mimeType: "text/css", text: "p{}" }], ...(edits ? { edits } : {}) });
  const assets = (html: string) => [
    { path: "index.html", mimeType: "text/html", bytes: Buffer.from(html, "utf8") },
    { path: "clip.mp4", mimeType: "video/mp4", bytes: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]) }
  ];

  it("applies deferred edits in order to the referenced text and leaves other bytes untouched", () => {
    const source = assets('<link rel="preload" href="x.js"><title>Old</title><p>Old</p>');
    const result = materializeArtifactReferences(operation([
      { path: "index.html", old_string: '<link rel="preload" href="x.js">', new_string: "" },
      { path: "index.html", old_string: "Old", new_string: "New", replace_all: true }
    ]), source);
    expect(result.texts.get("index.html")).toBe("<title>New</title><p>New</p>");
    expect(result.assets[0]!.bytes.toString("utf8")).toBe("<title>New</title><p>New</p>");
    expect(result.assets[1]).toBe(source[1]);
    expect([...result.edited]).toEqual(["index.html"]);
    expect(result.texts.has("clip.mp4")).toBe(false);
    const untouched = materializeArtifactReferences(operation(), source);
    expect(untouched.assets).toEqual(source);
    expect(untouched.edited.size).toBe(0);
    expect(untouched.texts.get("index.html")).toBe(source[0]!.bytes.toString("utf8"));
  });

  it.each([
    [[{ path: "index.html", old_string: "absent", new_string: "x" }], "artifact_edit_not_found"],
    [[{ path: "index.html", old_string: "p", new_string: "x" }], "artifact_edit_ambiguous"],
    [[{ path: "index.html", old_string: "<p>body</p>", new_string: "\ud800" }], "artifact_text_invalid"],
    [[{ path: "index.html", old_string: "<p>body</p>", new_string: "" }], "artifact_edit_invalid"]
  ])("refuses an edit that cannot apply or leaves invalid text: %j", (edits, code) => {
    expect(() => materializeArtifactReferences(operation(edits), assets("<p>body</p>")))
      .toThrowError(expect.objectContaining({ code, path: "index.html" }));
  });

  it("refuses non-UTF-8 referenced text before applying edits", () => {
    const source = [{ path: "index.html", mimeType: "text/html", bytes: Buffer.from([0xc3, 0x28]) }, assets("")[1]!];
    expect(() => materializeArtifactReferences(operation(), source)).toThrowError(expect.objectContaining({ code: "artifact_text_encoding_invalid", path: "index.html" }));
  });

  it("bounds edited text by the referenced-file limit and the bundle by its total", () => {
    const grown = `${"x".repeat(1023)}#`.repeat(12 * 1024);
    expect(() => materializeArtifactReferences(operation([{ path: "index.html", old_string: "#", new_string: "#".repeat(2048), replace_all: true }]), assets(grown)))
      .toThrowError(expect.objectContaining({ code: "artifact_text_limit_exceeded", path: "index.html", hint: expect.stringContaining(`${ARTIFACT_LIMITS.maxAssetBytes / MIB} MiB`) }));
    const half = `${"y".repeat(16 * MIB - 1)}#`;
    const pair = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Pair", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", assetRef: "a" }, { path: "other.txt", mimeType: "text/plain", assetRef: "b" }],
      edits: [{ path: "index.html", old_string: "#", new_string: "##" }] });
    expect(() => materializeArtifactReferences(pair, [
      { path: "index.html", mimeType: "text/html", bytes: Buffer.from(half) },
      { path: "other.txt", mimeType: "text/plain", bytes: Buffer.from(half) }
    ])).toThrowError(expect.objectContaining({ code: "artifact_bundle_limit_exceeded" }));
  });
});
