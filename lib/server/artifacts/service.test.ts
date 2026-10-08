import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../uploads/storage";
import { createArtifactService } from "./service";
import type { ToolExecutionContext } from "../tools/types";
import { createHash } from "node:crypto";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { ARTIFACT_LIMITS, normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { artifactTool, describeArtifactTool } from "../tools/artifact";
import { buildArtifactBundle, decodeArtifactBundle } from "./bundle";
import { vendorArtifactResources } from "./vendoring";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inlinePage = { path: "index.html", mimeType: "text/html", text: "<p>Files</p>" };
/** Runs create_artifact up to persistence: every reference check and the build must pass to reach the transaction. */
function referenceHarness(rows: Array<Record<string, unknown>>, objects: Map<string, Buffer | Error>) {
  const findMany = vi.fn(async (_query: unknown) => rows);
  const getObject = vi.fn(async (key: string, _options?: unknown) => {
    const value = objects.get(key);
    if (value instanceof Error) throw value;
    if (!value) throw new Error("unexpected_object_read");
    return { body: Buffer.from(value), storageKey: key, contentType: "application/octet-stream" };
  });
  const transaction = vi.fn(async () => { throw new Error("stop_before_persistence"); });
  const db = { artifactVersion: { findFirst: async () => null, findUnique: async () => null }, chat: { findFirst: async () => ({ id: "chat" }) },
    attachment: { findMany }, $transaction: transaction } as unknown as PrismaClient;
  const service = createArtifactService(db, { getObject } as unknown as StorageAdapter);
  const run = (files: unknown[], extra: Record<string, unknown> = {}) => service.execute({ id: "call", name: "create_artifact", arguments: {
    intent: "create", kind: "html", title: "From files", entrypoint: "index.html", files, ...extra
  } }, { userId: "owner", runId: "run", persistedToolCallId: "persisted",
    request: { chatId: "chat", imageReferences: [{ attachmentId: "html" }, { attachmentId: "image" }] } } as unknown as ToolExecutionContext);
  return { findMany, getObject, transaction, run };
}

describe("artifact authorized projections", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("hydrates vendor code, keeps provenance private and duplicates exact owner blobs with downloads disabled", async () => {
    const external = "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js";
    const javascript = Buffer.from("\ufeffwindow.example = 42;");
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Synthetic", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: `<script src="${external}"></script>` }] });
    const vendors = await vendorArtifactResources(operation, { fetchResource: async () => ({ bytes: javascript, mimeType: "text/javascript", resolvedUrl: external }) });
    const built = buildArtifactBundle(operation, vendors.assets, vendors.files);
    const vendor = vendors.files[0]!;
    const stored = new Map<string, Buffer>([["bundle", built.bytes], ["blob", javascript]]);
    const row = { id: "version", artifactId: "artifact", status: "READY", checksum: built.checksum, byteSize: built.bytes.length,
      entrypoint: "index.html", kind: "html", title: "Synthetic", versionNumber: 1, createdAt: new Date(), readyAt: new Date(), bundleStorageKey: "bundle",
      manifest: { version: 1, kind: "html", title: "Synthetic", entrypoint: "index.html", files: [
        { path: "index.html", mimeType: "text/html", byteSize: operation.totalBytes, group: "authored" },
        { path: vendor.path, mimeType: "text/javascript", byteSize: javascript.length, group: "vendored", ...vendor.vendor }
      ] } };
    const blob = { id: "blob-id", ownerUserId: "owner", storageKey: "blob", byteSize: javascript.length, sha256: vendor.blob! };
    const reference = vi.fn(async () => [{ path: vendor.path, blob }]);
    const bind = vi.fn(async () => ({}));
    const writeVersion = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "copy-version", ...data }));
    const upsertBlob = vi.fn(async () => blob);
    const rawDb = {
      $queryRaw: async () => [],
      artifact: { findFirst: async () => ({ currentVersionId: row.id }), create: async () => ({ id: "copy", updatedAt: new Date() }), update: async () => ({}) },
      artifactVersion: { findFirst: async () => row, findUniqueOrThrow: async () => row, create: writeVersion, updateMany: async () => ({ count: 1 }) },
      artifactVersionBlob: { findMany: reference, create: bind }, artifactBlob: { upsert: upsertBlob },
      attachmentDeletionJob: { create: async () => ({}), upsert: async () => ({}) },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(rawDb)
    };
    const storage: StorageAdapter = {
      deleteObject: async (key) => { stored.delete(key); },
      getObject: async (key) => { const body = stored.get(key); if (!body) throw new Error("missing"); return { body, storageKey: key, contentType: "application/octet-stream" }; },
      putObject: async ({ body, storageKey }) => { stored.set(storageKey, Buffer.from(body)); }
    };
    const noFetch = vi.fn();
    const service = createArtifactService(rawDb as unknown as PrismaClient, storage, { fetchResource: noFetch });
    vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "off");
    const source = await service.source({ ownerUserId: "owner", artifactId: "artifact", versionId: "version" });
    expect(source?.files).toEqual([
      { path: "index.html", mimeType: "text/html", text: operation.files[0]!.text, group: "authored", byteSize: operation.totalBytes },
      { path: vendor.path, mimeType: "text/javascript", text: javascript.toString(), group: "vendored", byteSize: javascript.length }
    ]);
    expect(reference).toHaveBeenCalledWith({ where: { versionId: "version", blob: { ownerUserId: "owner" } }, include: { blob: true } });
    const projection = await service.getArtifactVersion({ ownerUserId: "owner", artifactId: "artifact" });
    expect(projection?.manifest.files[1]).toEqual({ path: vendor.path, mimeType: "text/javascript", byteSize: javascript.length, group: "vendored" });
    expect(JSON.stringify(projection?.manifest)).not.toContain("sourceUrl");
    const copied = await service.duplicate({ ownerUserId: "owner", artifactId: "artifact" });
    expect(copied.id).toBe("copy"); expect(noFetch).not.toHaveBeenCalled();
    expect(upsertBlob).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerUserId_sha256: { ownerUserId: "owner", sha256: blob.sha256 } } }));
    expect(bind).toHaveBeenCalledWith({ data: { versionId: "copy-version", blobId: "blob-id", path: vendor.path } });
    const copyData = writeVersion.mock.calls[0]![0].data;
    const copyBundle = decodeArtifactBundle(stored.get(String(copyData.bundleStorageKey))!);
    expect(copyBundle.files).toEqual(built.bundle.files);
  });
  it("persists complete paged read results including the tool envelope without losing the file tail", async () => {
    vi.stubEnv("AIQSA_AUTH_SESSION_SECRET", "artifact-pagination-test-secret");
    const source = "\\\"🙂".repeat(80_000);
    const body = Buffer.from(JSON.stringify({ version: 1, kind: "html", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: source }] }));
    const db = { artifactVersion: { findFirst: async () => ({ id: "version", byteSize: body.byteLength,
      checksum: createHash("sha256").update(body).digest("hex"), bundleStorageKey: "owned-bundle" }) } } as unknown as PrismaClient;
    const service = createArtifactService(db, { getObject: async () => ({ body }) } as unknown as StorageAdapter);
    const context = { userId: "owner", runId: "run", request: { artifactReferences: [{ artifactId: "artifact", versionId: "version" }] } } as unknown as ToolExecutionContext;
    let cursor: string | undefined, recovered = "", pages = 0;
    do {
      const result = await service.execute({ id: "c".repeat(512), name: "read_artifact", arguments: {
        artifact_id: "artifact", ...(cursor ? { cursor } : {})
      } }, context);
      expect(result.status).toBe("complete");
      expect(snapshotToolLoopJson(result, toolLoopPersistenceLimits.resultBytes)).not.toBeNull();
      const value = result.content[0]!.type === "json" ? result.content[0]!.value as { files: { text: string }[]; next_cursor?: string } : null;
      recovered += value!.files.map(file => file.text).join("");
      cursor = value!.next_cursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(recovered).toBe(source);
  });
  it("projects at most the first 256 KiB of each text file to the code view, never splitting a character", async () => {
    const long = `a${"🙂".repeat(80_000)}`;
    const short = "<p>Short</p>";
    const body = Buffer.from(JSON.stringify({ version: 2, kind: "html", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: short }, { path: "data.txt", mimeType: "text/plain", text: long }] }));
    const db = { artifactVersion: { findFirst: async () => ({ id: "version", byteSize: body.byteLength, checksum: sha(body), bundleStorageKey: "owned-bundle" }) } } as unknown as PrismaClient;
    const service = createArtifactService(db, { getObject: async () => ({ body }) } as unknown as StorageAdapter);
    const source = await service.source({ ownerUserId: "owner", artifactId: "artifact", versionId: "version" });
    expect(source?.files[0]).toEqual({ path: "index.html", mimeType: "text/html", group: "authored", byteSize: short.length, text: short });
    const shown = source!.files[1]!;
    expect(shown).toMatchObject({ path: "data.txt", group: "authored", byteSize: Buffer.byteLength(long), truncated: true });
    // 262144 bytes end inside an emoji: the cut steps back to the last whole character.
    expect(shown.text).toBe(`a${"🙂".repeat(65_535)}`);
    expect(Buffer.byteLength(shown.text!)).toBeLessThanOrEqual(ARTIFACT_LIMITS.maxReadBytes);
    expect(long.startsWith(shown.text!)).toBe(true);
  });
  it("delivers structural repair hints privately but propagates unexpected database failures", async () => {
    const findFirst = vi.fn(async () => null);
    const transaction = vi.fn();
    const db = { artifactVersion: { findFirst, findUnique: async () => null }, chat: { findFirst: async () => ({ id: "chat" }) }, $transaction: transaction } as unknown as PrismaClient;
    const service = createArtifactService(db, {} as StorageAdapter);
    const context = { userId: "owner", runId: "run", persistedToolCallId: "persisted-call", request: { chatId: "chat", artifactTool: true } } as unknown as ToolExecutionContext;
    const call = { id: "call", name: "create_artifact", arguments: { intent: "create", kind: "html", title: "Example", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: '<script src="https://example.com/private-canary.js"></script>' }] } };
    const result = await service.execute(call, context);
    expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: {
      error: "artifact_resource_host_not_allowed", path: "index.html", hint: expect.stringContaining("current library hosts")
    } }] });
    expect(JSON.stringify(result)).not.toContain("private-canary"); expect(transaction).not.toHaveBeenCalled();
    findFirst.mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(service.execute(call, context)).rejects.toThrow("database_unavailable");
  });
  it("advertises no array count bounds while execution still enforces ARTIFACT_LIMITS", async () => {
    // Gemini compiles advertised schemas under a forced tool choice and
    // rejects these bounded object arrays; the limits stay server-owned.
    const properties = artifactTool(describeArtifactTool()).inputSchema.properties as Record<string, Record<string, unknown>>;
    for (const name of ["files", "edits", "delete_paths"]) expect(properties[name]).not.toHaveProperty("maxItems");
    expect(describeArtifactTool()).toContain(`at most ${ARTIFACT_LIMITS.maxFiles} files, ${ARTIFACT_LIMITS.maxEdits} edits`);
    const transaction = vi.fn();
    const putObject = vi.fn();
    const db = { artifactVersion: { findFirst: async () => null, findUnique: async () => null }, $transaction: transaction } as unknown as PrismaClient;
    const service = createArtifactService(db, { putObject } as unknown as StorageAdapter);
    const result = await service.execute({ id: "call", name: "create_artifact", arguments: {
      intent: "create", kind: "html", title: "Too many files", entrypoint: "index.html",
      files: Array.from({ length: ARTIFACT_LIMITS.maxFiles + 1 }, (_, index) => ({
        path: index === 0 ? "index.html" : `page-${index}.html`, mimeType: "text/html", text: "<p>x</p>" }))
    } }, { userId: "owner", runId: "run", persistedToolCallId: "persisted", request: { chatId: "chat" } } as ToolExecutionContext);
    expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_file_count_exceeded" } }] });
    expect(transaction).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    const base = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Base", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: "<p>x</p>" }] });
    expect(() => normalizeArtifactOperation({ intent: "update", baseVersionId: "v1", edits: Array.from(
      { length: ARTIFACT_LIMITS.maxEdits + 1 }, () => ({ path: "index.html", old_string: "x", new_string: "y" })) }, base))
      .toThrow("artifact_edit_limit_exceeded");
    expect(() => normalizeArtifactOperation({ intent: "update", baseVersionId: "v1",
      delete_paths: Array.from({ length: ARTIFACT_LIMITS.maxFiles + 1 }, (_, index) => `file-${index}.txt`) }, base))
      .toThrow("artifact_path_invalid");
  });

  it.each([undefined, null, "missing.html"])("explains a missing startup file before allocating storage or a version: %s", async entrypoint => {
    const transaction = vi.fn();
    const putObject = vi.fn();
    const db = { artifactVersion: { findFirst: async () => null, findUnique: async () => null }, $transaction: transaction } as unknown as PrismaClient;
    const service = createArtifactService(db, { putObject } as unknown as StorageAdapter);
    const result = await service.execute({ id: "call", name: "create_artifact", arguments: {
      intent: "create", kind: "game", title: "Synthetic game", ...(entrypoint !== undefined ? { entrypoint } : {}),
      files: [{ path: "index.html", mimeType: "text/html", text: "<p>PRIVATE_FILE_CANARY</p>" }]
    } }, { userId: "owner", runId: "run", persistedToolCallId: "persisted", request: { chatId: "chat" } } as ToolExecutionContext);
    expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: {
      error: "artifact_entrypoint_missing", hint: expect.stringContaining("Set entrypoint to the exact files[].path")
    } }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FILE_CANARY");
    expect(transaction).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });
  it("reads anonymous page metadata without object storage or private projections", async () => {
    const findFirst = vi.fn(async () => ({ mode: "SINGLE", title: "Public example", kind: "html", expiresAt: null,
      artifactVersion: { id: "version", title: "Public example", kind: "html", versionNumber: 2, status: "READY" }, members: [] }));
    const getObject = vi.fn();
    const db = { artifactPublication: { findFirst }, $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db) };
    const service = createArtifactService(db as unknown as PrismaClient, { getObject } as unknown as StorageAdapter);
    await expect(service.publicMetadata("synthetic-token")).resolves.toEqual({ title: "Public example", kind: "html", expiresAt: null });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      status: "READY", revokedAt: null, artifact: { archivedAt: null, owner: { status: "active" } }, owner: { status: "active" }
    }) }));
    expect(getObject).not.toHaveBeenCalled();
  });
  it("resolves source chat visibility once for a complete library page", async () => {
    const sourceIds = ["visible", "archived", "foreign", "deleted", null, "visible"];
    const rows = sourceIds.map((sourceChatId, index) => ({
      id: `artifact-${index}`, sourceChatId, currentVersionId: `version-${index}`
    }));
    const findChats = vi.fn(async () => [{ id: "visible" }]);
    const db = {
      artifact: { findMany: vi.fn(async () => rows) },
      artifactVersion: { findMany: vi.fn(async () => rows.map((row) => ({ id: row.currentVersionId, status: "READY", versionNumber: 1 }))) },
      chat: { findMany: findChats }
    } as unknown as PrismaClient;
    const listed = await createArtifactService(db, {} as StorageAdapter).list("owner");
    expect(listed.map((row) => row.sourceChatId)).toEqual(["visible", null, null, null, null, "visible"]);
    expect(findChats).toHaveBeenCalledOnce();
    expect(findChats).toHaveBeenCalledWith({ where: {
      id: { in: ["visible", "archived", "foreign", "deleted", "visible"] },
      userId: "owner", projectId: null, archived: false, permanentDeletionAt: null
    }, select: { id: true } });
  });

  it("resolves references only under the run's chat authority and copies verified bytes whatever the extraction status", async () => {
    const page = Buffer.from("<h1>Uploaded page</h1>");
    const { findMany, getObject, run } = referenceHarness([
      { id: "html", mimeType: "TEXT/HTML; charset=utf-8", storageKey: "k-html", byteSize: page.length, checksum: sha(page), status: "failed" }
    ], new Map([["k-html", page]]));
    await expect(run([{ path: "index.html", mimeType: "text/html", asset_ref: "html" }, { path: "copy.html", mimeType: "text/html", asset_ref: "html" }]))
      .rejects.toThrow("stop_before_persistence");
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["html"] }, userId: "owner", projectId: null, chatId: "chat",
      OR: [{ id: { in: ["html", "image"] } }, { producerModelRunId: "run" }] },
    select: { id: true, mimeType: true, storageKey: true, byteSize: true, checksum: true, status: true } });
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(getObject).toHaveBeenCalledWith("k-html", { maxBytes: page.length });
  });

  it.each([
    ["an id outside the run's authority", [], [{ path: "index.html", mimeType: "text/html", asset_ref: "html" }], "artifact_asset_unavailable", "never invent"],
    ["a declared type that differs", [{ id: "html", mimeType: "application/pdf", byteSize: 10, checksum: "a".repeat(64), status: "ready" }],
      [{ path: "index.html", mimeType: "text/html", asset_ref: "html" }], "artifact_asset_mime_mismatch", '"application/pdf"'],
    ["a file without a stored checksum", [{ id: "doc", mimeType: "application/pdf", byteSize: 10, checksum: null, status: "ready" }],
      [inlinePage, { path: "doc.pdf", mimeType: "application/pdf", asset_ref: "doc" }], "artifact_asset_checksum_missing", "attach the file again"],
    ["a legacy image that is not ready", [{ id: "image", mimeType: "image/png", byteSize: 10, checksum: null, status: "processing" }],
      [inlinePage, { path: "photo.png", mimeType: "image/png", asset_ref: "image" }], "artifact_asset_checksum_missing", "attach the file again"],
    ["an empty file", [{ id: "doc", mimeType: "application/pdf", byteSize: 0, checksum: "a".repeat(64), status: "ready" }],
      [inlinePage, { path: "doc.pdf", mimeType: "application/pdf", asset_ref: "doc" }], "artifact_asset_invalid", "empty"],
    ["a file over the per-file limit", [{ id: "clip", mimeType: "video/mp4", byteSize: 25 * 1024 * 1024, checksum: "a".repeat(64), status: "ready" }],
      [inlinePage, { path: "clip.mp4", mimeType: "video/mp4", asset_ref: "clip" }], "artifact_asset_too_large", "25.0 MiB"],
    ["files over the bundle limit", ["one", "two"].map(id => ({ id, mimeType: "video/mp4", byteSize: 20 * 1024 * 1024, checksum: "a".repeat(64), status: "ready" })),
      [inlinePage, { path: "one.mp4", mimeType: "video/mp4", asset_ref: "one" }, { path: "two.mp4", mimeType: "video/mp4", asset_ref: "two" }], "artifact_bundle_limit_exceeded", "32 MiB"]
  ])("refuses %s before reading any object", async (_name, rows, files, code, hint) => {
    const { getObject, transaction, run } = referenceHarness(rows.map(row => ({ storageKey: `k-${String(row.id)}`, ...row })), new Map());
    const result = await run(files);
    expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: { error: code, path: expect.any(String), hint: expect.stringContaining(hint) } }] });
    expect(getObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses corrupted, truncated and missing objects but leaves storage outages unexpected", async () => {
    const bytes = Buffer.from("%PDF-1.7 synthetic");
    const row = { id: "doc", mimeType: "application/pdf", storageKey: "k-doc", byteSize: bytes.length, checksum: sha(bytes), status: "processing" };
    const files = [inlinePage, { path: "doc.pdf", mimeType: "application/pdf", asset_ref: "doc" }];
    const corrupted = Buffer.from(bytes); corrupted[0] = corrupted[0]! ^ 1;
    for (const stored of [corrupted, bytes.subarray(1), Object.assign(new Error("gone"), { code: "ENOENT" })]) {
      const result = await referenceHarness([row], new Map([["k-doc", stored]])).run(files);
      expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_asset_invalid", path: "doc.pdf" } }] });
    }
    await expect(referenceHarness([row], new Map([["k-doc", new Error("storage_unavailable")]])).run(files)).rejects.toThrow("storage_unavailable");
    await expect(referenceHarness([row], new Map([["k-doc", bytes]])).run(files)).rejects.toThrow("stop_before_persistence");
  });

  it("edits a referenced page before validation and locates markup it cannot accept", async () => {
    const page = Buffer.from(`<head>${"<!-- filler -->".repeat(50)}<meta http-equiv="refresh" content="1"></head><h1>Scene</h1>`);
    const harness = () => referenceHarness([{ id: "html", mimeType: "text/html", storageKey: "k-html", byteSize: page.length, checksum: sha(page), status: "ready" }],
      new Map([["k-html", page]]));
    const files = [{ path: "index.html", mimeType: "text/html", asset_ref: "html" }];
    const refused = await harness().run(files);
    expect(refused).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_element_unsupported", path: "index.html",
      excerpt: expect.stringContaining('<meta http-equiv="refresh" content="1">') } }] });
    await expect(harness().run(files, { edits: [{ path: "index.html", old_string: '<meta http-equiv="refresh" content="1">', new_string: "" }] }))
      .rejects.toThrow("stop_before_persistence");
    // A resource the server cannot vendor is located in a page the model has not seen.
    const tracked = Buffer.from(`<p>${"x".repeat(300)}</p><script src="https://example.com/tracker.js"></script><h1>Scene</h1>`);
    const external = await referenceHarness([{ id: "html", mimeType: "text/html", storageKey: "k-html", byteSize: tracked.length, checksum: sha(tracked), status: "ready" }],
      new Map([["k-html", tracked]])).run(files);
    expect(external).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_resource_host_not_allowed", path: "index.html",
      excerpt: expect.stringContaining('<script src="https://example.com/tracker.js">') } }] });
    const invalid = Buffer.from([0x3c, 0x70, 0x3e, 0xc0]);
    const undecodable = await referenceHarness([{ id: "html", mimeType: "text/html", storageKey: "k-html", byteSize: invalid.length, checksum: sha(invalid), status: "ready" }],
      new Map([["k-html", invalid]])).run(files);
    expect(undecodable).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_text_encoding_invalid", path: "index.html" } }] });
  });

  it("requires the owned chat binding and distinguishes stale owned versions from unavailable targets", async () => {
    const artifact = vi.fn(async (): Promise<{ id: string; currentVersionId: string } | null> => ({ id: "artifact", currentVersionId: "version" }));
    const binding = vi.fn(async (): Promise<{ versionId: string } | null> => ({ versionId: "version" }));
    const version = vi.fn(async (): Promise<{ id: string } | null> => ({ id: "version" }));
    const service = createArtifactService({ artifact: { findFirst: artifact }, artifactChatBinding: { findFirst: binding },
      artifactVersion: { findFirst: version } } as unknown as PrismaClient, {} as StorageAdapter);
    const input = { artifactId: "artifact", versionId: "version", chatId: "chat", ownerUserId: "owner" };
    await expect(service.validateEditTarget(input)).resolves.toEqual({ ok: true, artifactId: "artifact", versionId: "version" });
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      artifactId: "artifact", chatId: "chat", artifact: { ownerUserId: "owner", archivedAt: null },
      chat: { userId: "owner", projectId: null, memoryMode: { not: "TEMPORARY" }, archived: false, permanentDeletionAt: null }
    }) }));
    artifact.mockResolvedValueOnce(null);
    await expect(service.validateEditTarget(input)).resolves.toEqual({ ok: false, code: "artifact_edit_unavailable" });
    binding.mockResolvedValueOnce(null);
    await expect(service.validateEditTarget(input)).resolves.toEqual({ ok: false, code: "artifact_edit_unavailable" });
    version.mockResolvedValueOnce(null);
    await expect(service.validateEditTarget(input)).resolves.toEqual({ ok: false, code: "artifact_edit_unavailable" });
    artifact.mockResolvedValueOnce({ id: "artifact", currentVersionId: "new-version" });
    await expect(service.validateEditTarget(input)).resolves.toEqual({ ok: false, code: "artifact_version_conflict" });
  });
});
