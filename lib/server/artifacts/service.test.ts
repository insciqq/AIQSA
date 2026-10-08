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
import { writeZip } from "./zip";

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
    const bind = vi.fn(async () => ({ count: 1 }));
    const writeVersion = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "copy-version", ...data }));
    const createBlobs = vi.fn(async () => ({ count: 0 }));
    const rawDb = {
      $queryRaw: async () => [],
      artifact: { findFirst: async () => ({ currentVersionId: row.id }), create: async () => ({ id: "copy", updatedAt: new Date() }), update: async () => ({}) },
      artifactVersion: { findFirst: async () => row, findUniqueOrThrow: async () => row, create: writeVersion, updateMany: async () => ({ count: 1 }) },
      artifactVersionBlob: { findMany: reference, createMany: bind }, artifactBlob: { createMany: createBlobs, findMany: async () => [blob] },
      attachmentDeletionJob: { create: async () => ({}), upsert: async () => ({}), createMany: async () => ({ count: 0 }) },
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
    expect(createBlobs).toHaveBeenCalledWith({ skipDuplicates: true, data: [expect.objectContaining({ ownerUserId: "owner", sha256: blob.sha256, byteSize: javascript.length })] });
    expect(bind).toHaveBeenCalledWith({ data: [{ versionId: "copy-version", blobId: "blob-id", path: vendor.path }] });
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

const zip = (files: Record<string, string | Buffer>) => writeZip(Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/**
 * create_artifact through settlement on an in-memory database and store: every
 * reference check, the build, blob binding and the ready receipt run for real.
 */
function siteHarness(attachments: Array<{ id: string; bytes: Buffer; mimeType: string; byteSize?: number; stored?: boolean }>) {
  const objects = new Map<string, Buffer>(attachments.filter(file => file.stored !== false).map(file => [`k-${file.id}`, Buffer.from(file.bytes)]));
  const rows = attachments.map(file => ({ id: file.id, mimeType: file.mimeType, storageKey: `k-${file.id}`, byteSize: file.byteSize ?? file.bytes.length,
    checksum: sha(file.bytes), status: "ready" }));
  const versions = new Map<string, Record<string, unknown>>();
  const blobs: Array<{ id: string; ownerUserId: string; sha256: string; byteSize: number; storageKey: string }> = [];
  const bindings: Array<{ versionId: string; blobId: string; path: string }> = [];
  const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter(row => where.id.in.includes(row.id)));
  const getObject = vi.fn(async (key: string) => {
    const body = objects.get(key);
    if (!body) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { body: Buffer.from(body), storageKey: key, contentType: "application/octet-stream" };
  });
  const current = () => [...versions.values()].filter(row => row.status === "READY").at(-1)?.id ?? null;
  const db: Record<string, unknown> = {
    $queryRaw: async () => [{ id: "locked" }],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    chat: { findFirst: async () => ({ id: "chat" }) },
    attachment: { findMany },
    artifact: { create: async () => ({ id: "artifact", updatedAt: new Date() }), update: async () => ({}),
      findFirst: async () => ({ id: "artifact", currentVersionId: current() }) },
    artifactVersion: {
      findUnique: async () => null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => versions.get(where.id),
      // Recovery looks up the version of a persisted tool call; other lookups name a version id.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = where.sourceToolCallId !== undefined ? [...versions.values()].find(version => version.sourceToolCallId === where.sourceToolCallId)
          : typeof where.id === "string" ? versions.get(where.id) : undefined;
        return row && (where.status === undefined || row.status === where.status) ? row : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `version-${versions.size + 1}`, createdAt: new Date(), readyAt: null };
        versions.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }: { where: { id?: string; status?: string }; data: Record<string, unknown> }) => {
        const row = where.id ? versions.get(where.id) : undefined;
        if (!row || where.status && row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      aggregate: async () => ({ _max: { versionNumber: versions.size } })
    },
    artifactChatBinding: { updateMany: async () => ({ count: 0 }), upsert: async () => ({}) },
    attachmentDeletionJob: { create: async () => ({}), upsert: async () => ({}), createMany: async () => ({ count: 0 }) },
    artifactBlob: {
      createMany: async ({ data }: { data: Array<Omit<(typeof blobs)[number], "id">> }) => {
        const created = data.filter(row => !blobs.some(blob => blob.sha256 === row.sha256));
        for (const row of created) blobs.push({ id: `blob-${blobs.length}`, ...row });
        return { count: created.length };
      },
      findMany: async ({ where }: { where: { sha256: { in: string[] } } }) => blobs.filter(blob => where.sha256.in.includes(blob.sha256))
    },
    artifactVersionBlob: {
      createMany: async ({ data }: { data: Array<(typeof bindings)[number]> }) => { bindings.push(...data); return { count: data.length }; },
      deleteMany: async () => ({ count: 0 }),
      findMany: async ({ where }: { where: { versionId: string } }) => bindings.filter(binding => binding.versionId === where.versionId)
        .map(binding => ({ ...binding, blob: blobs.find(blob => blob.id === binding.blobId) }))
    }
  };
  const storage = { getObject, putObject: async ({ body, storageKey }: { body: Uint8Array; storageKey: string }) => { objects.set(storageKey, Buffer.from(body)); },
    deleteObject: async (key: string) => { objects.delete(key); } };
  const service = createArtifactService(db as unknown as PrismaClient, storage as unknown as StorageAdapter);
  let calls = 0;
  const run = (args: Record<string, unknown>, references: Array<{ artifactId: string; versionId: string }> = []) => {
    calls += 1;
    return service.execute({ id: `call-${calls}`, name: "create_artifact", arguments: { intent: "create", kind: "html", title: "Site", ...args } },
      { userId: "owner", runId: "run", persistedToolCallId: `persisted-${calls}`, request: { chatId: "chat",
        artifactReferences: references, fileReferences: attachments.map(file => ({ attachmentId: file.id })) } } as unknown as ToolExecutionContext);
  };
  const bundleOf = (versionId: string) => decodeArtifactBundle(objects.get(String(versions.get(versionId)!.bundleStorageKey))!);
  const manifestOf = (versionId: string) => versions.get(versionId)!.manifest as { files: Array<Record<string, unknown>>; report?: unknown };
  /** Crash recovery of the n-th call: the same lookup by persisted tool call. */
  const recover = (n: number) => service.restore({ id: `call-${n}`, name: "create_artifact", arguments: {} },
    { userId: "owner", runId: "run", persistedToolCallId: `persisted-${n}`, request: { chatId: "chat" } } as unknown as ToolExecutionContext);
  return { run, recover, service, versions, blobs, bindings, findMany, getObject, bundleOf, manifestOf };
}
const resultValue = (result: Awaited<ReturnType<ReturnType<typeof createArtifactService>["execute"]>>) =>
  (result.content[0] as { value: Record<string, unknown> }).value;

describe("websites unpacked from a referenced archive", () => {
  const archive = { path: "site.zip", mimeType: "application/zip", asset_ref: "zip", unpack: true };
  const site = () => zip({
    "site/index.html": '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><h1>SITE_HOME</h1><img alt="Logo" src="img/logo.png"></body></html>',
    "site/about.html": "<p>About</p>", "site/css/site.css": "h1{color:red}", "site/img/logo.png": PNG, "site/img/copy.png": PNG,
    "site/css/empty.css": "", "site/img/.DS_Store": "x", "site/.htaccess": "deny", "__MACOSX/site/._index.html": "x"
  });

  it("unpacks the site at the bundle root, stores files as deduplicated blobs and renders its root index.html", async () => {
    const h = siteHarness([{ id: "zip", bytes: site(), mimeType: "application/zip" }]);
    const result = await h.run({ files: [archive] });
    expect(result.status).toBe("complete");
    expect(resultValue(result)).toMatchObject({ entrypoint: "index.html", unpacked: { root_folder: "site", skipped_entries: 3, skipped_files: ["site/.htaccess"],
      file_count: 6, paths: ["about.html", "css/empty.css", "css/site.css", "img/copy.png", "img/logo.png", "index.html"] } });
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "generated_artifact", payload: expect.not.objectContaining({ unpacked: expect.anything() }) } }]);
    const bundle = h.bundleOf("version-1");
    expect(bundle.files.map(file => [file.path, file.text ?? file.blob])).toEqual([
      ["about.html", sha(Buffer.from("<p>About</p>"))], ["css/empty.css", ""], ["css/site.css", sha(Buffer.from("h1{color:red}"))],
      ["img/copy.png", sha(PNG)], ["img/logo.png", sha(PNG)], ["index.html", expect.any(String)]]);
    // One owner blob serves both copies of the logo; the archive itself is not stored.
    expect(h.blobs.map(blob => blob.sha256).filter(value => value === sha(PNG))).toHaveLength(1);
    expect(h.bindings.filter(binding => binding.path.endsWith(".png")).map(binding => binding.blobId)).toEqual([h.blobs.find(blob => blob.sha256 === sha(PNG))!.id, h.blobs.find(blob => blob.sha256 === sha(PNG))!.id]);
    const manifest = h.manifestOf("version-1");
    expect(manifest.report).toEqual({ unpacked: { rootFolder: "site", skippedEntries: 3, skippedFiles: ["site/.htaccess"] } });
    expect(JSON.stringify(manifest)).not.toContain('"zip"');
    expect(manifest.files.find(file => file.path === "img/logo.png")).toMatchObject({ assetRef: expect.stringMatching(/^base:/u), byteSize: PNG.length });
    expect(h.findMany).toHaveBeenCalledOnce();
    const rendered = (await h.service.getPrivateBundle({ ownerUserId: "owner", artifactId: "artifact" }))!.body.toString();
    expect(rendered).toContain("SITE_HOME");
    expect(rendered).toContain("h1{color:red}");
    expect(rendered).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("lets files[] replace unpacked files, edits unpacked text and starts at the model's entry page", async () => {
    const h = siteHarness([{ id: "zip", bytes: site(), mimeType: "application/zip" }]);
    const result = await h.run({ entrypoint: "about.html", files: [archive, { path: "css/site.css", mimeType: "text/css", text: "h1{color:blue}" }],
      edits: [{ path: "about.html", old_string: "About", new_string: "About us" }] });
    expect(resultValue(result)).toMatchObject({ entrypoint: "about.html", unpacked: { file_count: 6 } });
    const files = new Map(h.bundleOf("version-1").files.map(file => [file.path, file]));
    expect(files.get("css/site.css")).toEqual({ path: "css/site.css", mimeType: "text/css", text: "h1{color:blue}" });
    expect(files.get("about.html")).toMatchObject({ blob: sha(Buffer.from("<p>About us</p>")) });
  });

  it("names the archive's HTML pages when it has no root index.html or the entry page is not HTML", async () => {
    const pages = zip({ "pages/a.html": "<p>a</p>", "pages/b.html": "<p>b</p>", "style.css": "p{}" });
    const missing = resultValue(await siteHarness([{ id: "zip", bytes: pages, mimeType: "application/zip" }]).run({ files: [archive] }));
    expect(missing).toEqual({ error: "artifact_entrypoint_missing", path: "index.html", hint: expect.stringContaining("pages/a.html, pages/b.html") });
    const notHtml = resultValue(await siteHarness([{ id: "zip", bytes: pages, mimeType: "application/zip" }]).run({ entrypoint: "style.css", files: [archive] }));
    expect(notHtml).toEqual({ error: "artifact_entrypoint_invalid", path: "style.css", hint: expect.stringContaining("must be HTML") });
  });

  it("checks the archive like any reference before reading it", async () => {
    const outside = siteHarness([{ id: "zip", bytes: site(), mimeType: "application/zip" }]);
    expect(resultValue(await outside.run({ files: [{ ...archive, asset_ref: "unknown" }] }))).toMatchObject({ error: "artifact_asset_unavailable", path: "site.zip" });
    const windows = siteHarness([{ id: "zip", bytes: site(), mimeType: "application/x-zip-compressed" }]);
    expect(resultValue(await windows.run({ files: [archive] }))).toMatchObject({ error: "artifact_asset_mime_mismatch", hint: expect.stringContaining("application/x-zip-compressed") });
    expect((await windows.run({ files: [{ ...archive, mimeType: "application/x-zip-compressed" }] })).status).toBe("complete");
    const large = siteHarness([{ id: "zip", bytes: site(), mimeType: "application/zip", byteSize: ARTIFACT_LIMITS.maxAssetBytes + 1, stored: false }]);
    expect(resultValue(await large.run({ files: [archive] }))).toMatchObject({ error: "artifact_asset_too_large", path: "site.zip" });
    for (const h of [outside, large]) expect(h.getObject).not.toHaveBeenCalled();
    expect(resultValue(await siteHarness([{ id: "zip", bytes: Buffer.from("not an archive"), mimeType: "application/zip" }]).run({ files: [archive] })))
      .toMatchObject({ error: "artifact_zip_invalid", path: "site.zip" });
  });

  it.each([
    ["an unsafe path", { "index.html": "<p>x</p>", "../escape.html": "x" }, { error: "artifact_zip_path_invalid", path: "../escape.html" }],
    ["a name pages cannot reference", { "site/index.html": "<p>x</p>", "site/my photo.png": PNG }, { error: "artifact_zip_path_unsupported", path: "site/my photo.png" }],
    ["text that is not UTF-8", { "index.html": "<p>x</p>", "old.css": Buffer.from([0x70, 0xe9]) }, { error: "artifact_text_encoding_invalid", path: "old.css" }],
    ["text with control characters", { "index.html": "<p>bell\u0007</p>" }, { error: "artifact_text_invalid", path: "index.html", excerpt: "<p>bell" }]
  ])("refuses an archive with %s as a typed error", async (_name, files, expected) => {
    const h = siteHarness([{ id: "zip", bytes: zip(files), mimeType: "application/zip" }]);
    expect(resultValue(await h.run({ files: [archive] }))).toMatchObject({ ...expected, hint: expect.any(String) });
    expect(h.versions.size).toBe(0);
  });

  it("counts unpacked bytes with the call's other files against the artifact limit before reading them", async () => {
    // 1 MiB entries stay under the compression-ratio floor, so zeros keep the archive tiny.
    const chunks = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`data/${index}.bin`, Buffer.alloc(1024 * 1024)]));
    const h = siteHarness([{ id: "zip", bytes: zip({ "index.html": "<p>x</p>", ...chunks }), mimeType: "application/zip" },
      { id: "clip", bytes: Buffer.from("video"), mimeType: "video/mp4", byteSize: ARTIFACT_LIMITS.maxAssetBytes, stored: false }]);
    expect(resultValue(await h.run({ files: [archive, { path: "clip.mp4", mimeType: "video/mp4", asset_ref: "clip" }] })))
      .toMatchObject({ error: "artifact_bundle_limit_exceeded", hint: expect.stringContaining("32 MiB") });
    expect(h.getObject.mock.calls.map(([key]) => key)).toEqual(["k-zip"]);
  });

  it("updates, edits and duplicates a 500-file site but refuses a 501st file", async () => {
    const texts = Object.fromEntries(Array.from({ length: ARTIFACT_LIMITS.maxBundleFiles - 1 }, (_, index) => [`notes/${String(index).padStart(3, "0")}.txt`, `note ${index}`]));
    const h = siteHarness([{ id: "zip", bytes: zip({ "index.html": "<h1>Large</h1>", ...texts }), mimeType: "application/zip" }]);
    const created = await h.run({ files: [archive] });
    expect(resultValue(created)).toMatchObject({ unpacked: { file_count: ARTIFACT_LIMITS.maxBundleFiles, more_paths: ARTIFACT_LIMITS.maxBundleFiles - 100 } });
    const reference = (versionId: string) => [{ artifactId: "artifact", versionId }];
    const edited = await h.run({ intent: "update", base_version_id: "version-1", edits: [{ path: "index.html", old_string: "Large", new_string: "Larger" }],
      files: [{ path: "notes/000.txt", mimeType: "text/plain", text: "replaced" }] }, reference("version-1"));
    expect(edited.status).toBe("complete");
    expect(resultValue(edited)).not.toHaveProperty("unpacked");
    const files = h.bundleOf("version-2").files;
    expect(files).toHaveLength(ARTIFACT_LIMITS.maxBundleFiles);
    expect(files.find(file => file.path === "notes/000.txt")).toMatchObject({ text: "replaced" });
    expect(files.find(file => file.path === "index.html")).toMatchObject({ blob: sha(Buffer.from("<h1>Larger</h1>")) });
    expect(files.find(file => file.path === "notes/498.txt")).toMatchObject({ blob: sha(Buffer.from("note 498")) });
    expect((await h.service.getPrivateBundle({ ownerUserId: "owner", artifactId: "artifact", versionId: "version-2" }))!.body.toString()).toContain("Larger");
    const refused = resultValue(await h.run({ intent: "update", base_version_id: "version-2", files: [{ path: "one-more.txt", mimeType: "text/plain", text: "x" }] }, reference("version-2")));
    expect(refused).toMatchObject({ error: "artifact_file_count_exceeded", hint: expect.stringContaining(`at most ${ARTIFACT_LIMITS.maxBundleFiles} files`) });
    const copy = await h.service.duplicate({ ownerUserId: "owner", artifactId: "artifact" });
    expect(h.bundleOf(copy.currentVersionId).files).toHaveLength(ARTIFACT_LIMITS.maxBundleFiles);
  });

  it("lists at most 32 files of an artifact in the chat context, entry page and other text first", async () => {
    const manifestFiles = [
      ...Array.from({ length: 30 }, (_, index) => ({ path: `img/${index}.png`, mimeType: "image/png", byteSize: 10, group: "authored", assetRef: `base:${index}` })),
      { path: "app.js", mimeType: "text/javascript", byteSize: 10, group: "authored" }, { path: "about.html", mimeType: "text/html", byteSize: 10, group: "authored" },
      ...Array.from({ length: 8 }, (_, index) => ({ path: `extra/${index}.txt`, mimeType: "text/plain", byteSize: 10, group: "authored" })),
      { path: "index.html", mimeType: "text/html", byteSize: 10, group: "authored" }
    ];
    const binding = { artifactId: "artifact", versionId: "version", artifact: { id: "artifact", kind: "html", title: "Site" },
      version: { id: "version", artifactId: "artifact", kind: "html", title: "Site", entrypoint: "index.html", versionNumber: 1, byteSize: 100, checksum: "x", bundleStorageKey: "b",
        manifest: { version: 1, kind: "html", title: "Site", entrypoint: "index.html", files: manifestFiles } } };
    const db = { artifactChatBinding: { findMany: async () => [binding] } } as unknown as PrismaClient;
    const [context] = await createArtifactService(db, {} as StorageAdapter).contextForChat({ ownerUserId: "owner", chatId: "chat", maxInlineSourceBytes: 0 });
    expect(context!.files).toHaveLength(32);
    expect(context!.files.slice(0, 12).map(file => file.path)).toEqual(["index.html", "about.html", "app.js", ...Array.from({ length: 8 }, (_, index) => `extra/${index}.txt`), "img/0.png"]);
    expect(context!.files[11]).toEqual({ path: "img/0.png", mimeType: "image/png", bytes: 10, binary: true, asset_ref: "base:0" });
    expect(context!.files_omitted).toBe(9);
  });
});

describe("render notes in the tool result", () => {
  it("reports the build's notes for an ordinary create, keeps them out of the card and recovers the identical receipt", async () => {
    const h = siteHarness([]);
    const result = await h.run({ entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: '<link rel="preload" href="app.js"><a href="about.html">About</a><a href="gone.html">Gone</a>' },
      { path: "about.html", mimeType: "text/html", text: "<p>About</p><iframe></iframe>" }
    ] });
    expect(result.status).toBe("complete");
    const renderNotes = { removedLinks: [{ page: "index.html", rel: "preload", href: "app.js" }], missingLinks: [{ page: "index.html", href: "gone.html", path: "gone.html" }],
      invalidPages: [{ page: "about.html", code: "artifact_element_unsupported" }], omitted: 0, unvalidatedPages: 0 };
    expect(resultValue(result).render_notes).toEqual({ removed_links: renderNotes.removedLinks, missing_links: renderNotes.missingLinks,
      invalid_pages: renderNotes.invalidPages, hint: expect.stringContaining("invalid_pages") });
    expect(resultValue(result)).not.toHaveProperty("unpacked");
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "generated_artifact", payload: expect.not.objectContaining({ render_notes: expect.anything() }) } }]);
    expect(h.manifestOf("version-1").report).toEqual({ renderNotes });
    expect(await h.recover(1)).toEqual(result);
    // A clean build stores no report and keeps the compact receipt.
    const clean = await h.run({ entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "<p>Clean</p>" }] });
    expect(resultValue(clean)).not.toHaveProperty("render_notes");
    expect(h.manifestOf("version-2")).not.toHaveProperty("report");
  });

  it("joins render notes with an unpacked site's report", async () => {
    const archive = zip({ ".gitignore": "x", "site/index.html": '<a href="missing.html">Missing</a>' });
    const h = siteHarness([{ id: "zip", bytes: archive, mimeType: "application/zip" }]);
    const result = await h.run({ files: [{ path: "site.zip", mimeType: "application/zip", asset_ref: "zip", unpack: true }] });
    expect(resultValue(result)).toMatchObject({ unpacked: { root_folder: "site", skipped_files: [".gitignore"], paths: ["index.html"] },
      render_notes: { missing_links: [{ page: "index.html", href: "missing.html", path: "missing.html" }], hint: expect.stringContaining("missing_links") } });
    expect(await h.recover(1)).toEqual(result);
  });
});
