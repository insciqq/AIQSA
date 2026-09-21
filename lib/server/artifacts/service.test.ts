import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../uploads/storage";
import { createArtifactService } from "./service";
import type { ToolExecutionContext } from "../tools/types";
import { createHash } from "node:crypto";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle, decodeArtifactBundle } from "./bundle";
import { vendorArtifactResources } from "./vendoring";

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
