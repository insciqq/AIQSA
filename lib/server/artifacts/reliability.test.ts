import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { ARTIFACT_LIMITS, normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { ARTIFACT_GENERATION_LIMITS, decodeArtifactGenerationEvent, type ArtifactGenerationEvent } from "@/lib/contracts/artifactGeneration";
import { parseArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { artifactReadPage } from "./readPage";
import { ArtifactArgumentPreview } from "./argumentPreview";
import { artifactDownloadDisposition, artifactDownloadName } from "./downloadName";
import { createArtifactGeneration } from "./generation";
import { decodeArtifactBundle, renderArtifactBundle } from "./bundle";
import { artifactToolError } from "./errors";
import { ArtifactPublicBusyError, boundedArtifactWork } from "./objects";

describe("artifact patch, privacy and bounded output", () => {
  const base = normalizeArtifactOperation({ intent: "create", title: "Original", kind: "html", entrypoint: "index.html", files: [
    { path: "index.html", mimeType: "text/html", text: "<p>one one</p>" },
    { path: "image.png", mimeType: "image/png", assetRef: "image" },
    { path: "other.txt", mimeType: "text/plain", text: "unused" }
  ] });
  it("applies sequential exact patches while preserving omitted binary files and defaults", () => {
    const next = normalizeArtifactOperation({ intent: "update", baseVersionId: "v1", edits: [
      { path: "index.html", old_string: "one", new_string: "two", replace_all: true },
      { path: "index.html", old_string: "two two", new_string: "three" }
    ], delete_paths: ["other.txt"] }, base);
    expect(next).toMatchObject({ title: "Original", kind: "html", entrypoint: "index.html" });
    expect(next.files).toEqual([expect.objectContaining({ text: "<p>three</p>" }), expect.objectContaining({ assetRef: "image" })]);
    expect(() => normalizeArtifactOperation({ intent: "update", baseVersionId: "v1", edits: [{ path: "index.html", old_string: "one", new_string: "two" }] }, base)).toThrow("artifact_edit_ambiguous");
    expect(() => normalizeArtifactOperation({ intent: "update", baseVersionId: "v1", delete_paths: ["index.html"] }, base)).toThrow("artifact_delete_entrypoint");
    expect(() => normalizeArtifactOperation({ intent: "create", kind: "html", title: "Bad", files: [], edits: [] })).toThrow("artifact_operation_invalid");
    try {
      normalizeArtifactOperation({ intent: "update", baseVersionId: "v1", edits: [{ path: "index.html", old_string: "one", new_string: "x".repeat(ARTIFACT_LIMITS.maxTextFileBytes + 1) }] }, base);
      throw new Error("expected rejection");
    } catch (error) {
      expect(artifactToolError(error)).toMatchObject({ code: "artifact_edit_limit_exceeded", path: "index.html", hint: expect.stringContaining("Edit 1:") });
    }
  });
  it("pages a 512 KiB multibyte file exactly, including serialized metadata and signed selection", () => {
    const text = "🪿".repeat(ARTIFACT_LIMITS.maxTextFileBytes / 4 - 1) + "TAIL";
    const input = { artifactId: "artifact", versionId: "version", ownerUserId: "owner", secret: "synthetic-test-secret",
      bundle: { version: 2 as const, kind: "html" as const, entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text }] } };
    let next: string | undefined; let restored = ""; let firstCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = artifactReadPage({ ...input, args: { artifact_id: "artifact", ...(next ? { cursor: next } : {}) } });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxReadBytes);
      expect(page.files[0]!.offset).toBe(restored.length);
      restored += page.files.map(file => file.text ?? "").join("");
      next = page.next_cursor; firstCursor ??= next;
      if (!page.truncated) break;
    }
    expect(restored).toBe(text); expect(next).toBeUndefined();
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Large", entrypoint: "index.html", files: input.bundle.files });
    const edited = normalizeArtifactOperation({ intent: "update", baseVersionId: "version", edits: [{ path: "index.html", old_string: restored.slice(-4), new_string: "DONE" }] }, operation);
    expect(edited.files[0]!.text).toBe(text.slice(0, -4) + "DONE");
    expect(() => artifactReadPage({ ...input, args: { artifact_id: "artifact", cursor: firstCursor!.slice(0, -2) + "ab" } })).toThrow("artifact_read_cursor_invalid");
    expect(() => artifactReadPage({ ...input, versionId: "different", args: { artifact_id: "artifact", cursor: firstCursor } })).toThrow("artifact_read_cursor_invalid");
  });
  it("extracts only root files text across every JSON character boundary", () => {
    const text = '<main title="x">🪿\n\\end</main>';
    const input = JSON.stringify({ secret: "NEVER_PUBLIC", nested: { files: [{ text: "NEVER_PUBLIC" }] }, title: "Example", files: [{ text, path: "index.html", asset_ref: "NEVER_PUBLIC" }], kind: "html" });
    const preview = new ArtifactArgumentPreview("draft");
    const events = Array.from(input).flatMap(character => preview.feed(character));
    expect(events.filter(event => event.phase === "file").map(event => event.phase === "file" ? event.text : "").join("")).toBe(text);
    expect(JSON.stringify(events)).not.toContain("NEVER_PUBLIC");
    expect(events.every(event => decodeArtifactGenerationEvent(event) !== null)).toBe(true);
    for (const data of events) expect(projectRunOutputArtifactEvent({ type: "artifact_generation", data })).toBeNull();
    const escaped = new ArtifactArgumentPreview("escaped");
    const output = '{"files":[{"text":"\\uD83E\\uDEBF"}]}'.split("").flatMap(character => escaped.feed(character));
    expect(output.filter(event => event.phase === "file").map(event => event.phase === "file" ? event.text : "").join("")).toBe("🪿");
    expect(preview.feed('{"files":[]}')).toEqual([{ phase: "reset", draftId: "draft" }]);
  });
  it("keeps pending fallback factual and correlates authoritative settlement", async () => {
    const events: ArtifactGenerationEvent[] = [];
    const generation = createArtifactGeneration("run", async event => { events.push(event); });
    const call = { id: "private-provider-id", name: "create_artifact", arguments: { title: "Example", kind: "html" } };
    await generation.requested(1, [call]);
    expect(events.map(event => event.phase)).toEqual(["started", "metadata"]);
    await generation.settled(call.id, { callId: call.id, name: call.name, status: "complete", content: [], artifacts: [{ type: "artifact", data: {
      artifactType: "generated_artifact", payload: { artifact_id: "a", version_id: "v", version_number: 1, title: "Example", kind: "html", entrypoint: "index.html" }
    } }] });
    await generation.stop("failed");
    expect(events.at(-1)).toMatchObject({ phase: "settled", status: "ready", artifact: { versionId: "v" } });
    expect(events).toHaveLength(3); expect(JSON.stringify(events)).not.toContain(call.id);
  });
  it("keeps v1 readable and emits safe Unicode download filenames", () => {
    expect(decodeArtifactBundle(Buffer.from(JSON.stringify({ version: 1, kind: "image", entrypoint: null, files: [{ path: "a.png", mimeType: "image/png", base64: "aGk=" }] })))).toMatchObject({ version: 1 });
    expect(artifactDownloadName("Гусь-рокер — страница", "zip")).toMatchObject({ ascii: "artifact.zip", utf8: "Гусь-рокер — страница.zip" });
    expect(artifactDownloadDisposition('..🪿 / "\r\nname..', "html")).not.toMatch(/[\r\n]/u);
    expect(artifactDownloadName("x".repeat(100), "zip").utf8).toBe("x".repeat(80) + ".zip");
    const svg = { version: 2 as const, kind: "svg" as const, entrypoint: "image.svg", files: [{ path: "image.svg", mimeType: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>' }] };
    expect(renderArtifactBundle(svg, true)).toMatchObject({ contentType: "image/svg+xml; charset=utf-8", fileName: "image.svg", body: Buffer.from(svg.files[0]!.text) });
    expect(renderArtifactBundle(svg).contentType).toBe("text/html; charset=utf-8");
  });
  it("bounds preview across drafts, resets malformed JSON, and settles cancellation once", async () => {
    const events: ArtifactGenerationEvent[] = [];
    const generation = createArtifactGeneration("run", async event => { events.push(event); });
    for (let callIndex = 0; callIndex < 6; callIndex++) await generation.observe(1, { callIndex, callId: `call-${callIndex}`, name: "create_artifact",
      delta: JSON.stringify({ files: [{ path: "index.html", text: "x".repeat(ARTIFACT_LIMITS.maxTextFileBytes) }] }) });
    expect(events.reduce((total, event) => total + (event.phase === "file" ? Buffer.byteLength(event.text) : 0), 0)).toBeLessThanOrEqual(ARTIFACT_GENERATION_LIMITS.maxPreviewBytes);
    await generation.stop("cancelled"); await generation.stop("failed");
    expect(events.filter(event => event.phase === "settled")).toHaveLength(6);
    expect(events.filter(event => event.phase === "settled").every(event => event.phase === "settled" && event.status === "cancelled")).toBe(true);
    const preview = new ArtifactArgumentPreview("broken");
    expect(preview.feed('{"files":[{"text":"x","text":"duplicate"}]}')).toEqual([{ draftId: "broken", phase: "reset" }]);
    expect(preview.feed('{"files":[{"text":"later"}]}')).toEqual([]);
  });
  it("refuses excess rendering work and releases permits after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = Array.from({ length: 4 }, () => boundedArtifactWork(() => gate));
    try { await expect(boundedArtifactWork(async () => "extra")).rejects.toBeInstanceOf(ArtifactPublicBusyError); }
    finally { release(); await Promise.all(active); }
    await expect(boundedArtifactWork(async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
    await expect(boundedArtifactWork(async () => "available")).resolves.toBe("available");
  });
  it("accepts only bounded runtime details and origin-only CSP resource identities", () => {
    const error = { type: "aiqsa_artifact_runtime_error", kind: "error", message: "Missing value", line: 3, column: 7 };
    expect(parseArtifactRuntimeError({ ...error, stack: "private" })).toEqual({ kind: "error", message: "Missing value", line: 3, column: 7 });
    expect(parseArtifactRuntimeError({ ...error, message: "x".repeat(301) })).toBeNull();
    expect(parseArtifactRuntimeError({ ...error, kind: "csp", directive: "connect-src", blocked: "https://example.com/private" })).toBeNull();
    expect(parseArtifactRuntimeError({ ...error, kind: { toString: () => { throw new Error("hostile"); } } })).toBeNull();
  });
  it.each(["error", "unhandledrejection", "securitypolicyviolation"])("reports only the first %s with sanitized bounded details", name => {
    const rendered = renderArtifactBundle({ version: 2, kind: "html", entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "<p>Example</p>" }] });
    const bridge = new DOMParser().parseFromString(rendered.body.toString(), "text/html").querySelector("script")!.textContent!;
    const listeners = new Map<string, (event: object) => void>(); const messages: unknown[] = [];
    runInNewContext(bridge, { URL, DOMException, document: { addEventListener: () => undefined },
      window: { addEventListener: (event: string, handler: (event: object) => void) => listeners.set(event, handler) }, parent: { postMessage: (message: unknown) => messages.push(message) } });
    listeners.get(name)!({ message: "x\n".repeat(200), lineno: 7, colno: 4, reason: { message: "rejection", stack: "private stack" },
      effectiveDirective: "connect-src", blockedURI: "https://example.com/private-canary", lineNumber: 2, columnNumber: 3 });
    listeners.get("error")!({ message: "second error" });
    expect(messages).toHaveLength(1);
    expect(parseArtifactRuntimeError(messages[0])).not.toBeNull();
    expect(JSON.stringify(messages)).not.toMatch(/private-canary|private stack|second error/u);
    if (name === "securitypolicyviolation") expect(messages[0]).toMatchObject({ kind: "csp", blocked: "https://example.com", directive: "connect-src" });
  });
});
