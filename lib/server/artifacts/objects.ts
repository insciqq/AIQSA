import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../uploads/storage";
import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { ARTIFACT_MAX_RENDER_BYTES, ARTIFACT_RENDERER_VERSION, decodeArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle, type ArtifactBundle, type ArtifactBundleAsset } from "./bundle";
import { ARTIFACT_RESOURCE_LIMITS } from "./resourcePolicy";

export const artifactChecksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type BundleRow = { id: string; bundleStorageKey: string; byteSize: number; checksum: string };
let activeHeavyReads = 0;
export class ArtifactPublicBusyError extends Error { constructor() { super("artifact_public_busy"); } }
export async function boundedArtifactWork<T>(work: () => Promise<T>): Promise<T> {
  if (activeHeavyReads >= 4) throw new ArtifactPublicBusyError();
  activeHeavyReads += 1;
  try { return await work(); } finally { activeHeavyReads -= 1; }
}

export function createArtifactObjects(db: PrismaClient, storage: StorageAdapter) {
  async function readBundle(row: BundleRow): Promise<ArtifactBundle> {
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || artifactChecksum(object.body) !== row.checksum) throw new Error("artifact_bundle_unavailable");
    return decodeArtifactBundle(object.body);
  }

  async function hydrate(ownerUserId: string, versionId: string, bundle: ArtifactBundle, options: { vendorTextOnly?: boolean } = {}): Promise<ArtifactBundle> {
    if (!bundle.files.some(file => file.blob)) return bundle;
    const textVendor = (file: ArtifactBundle["files"][number]) => file.vendor && ["script", "style"].includes(file.vendor.resourceClass);
    if (options.vendorTextOnly && !bundle.files.some(textVendor)) return bundle;
    const references = await db.artifactVersionBlob.findMany({ where: { versionId, blob: { ownerUserId } }, include: { blob: true } });
    let total = bundle.files.reduce((sum, file) => sum + (file.text === undefined ? 0 : Buffer.byteLength(file.text)), 0);
    for (const file of bundle.files) if (file.blob) {
      const reference = references.find(reference => reference.path === file.path);
      if (!reference || reference.blob.sha256 !== file.blob || reference.blob.byteSize !== file.byteSize) throw new Error("artifact_blob_unavailable");
      total += reference.blob.byteSize;
    }
    if (total > ARTIFACT_LIMITS.maxBundleBytes + ARTIFACT_RESOURCE_LIMITS.maxBytes) throw new Error("artifact_bundle_limit_exceeded");
    // Sequential reads avoid multiplying the complete bundle's memory by fanout.
    const files = [];
    for (const file of bundle.files) {
      if (!file.blob || options.vendorTextOnly && !textVendor(file)) { files.push(file); continue; }
      const reference = references.find(reference => reference.path === file.path)!.blob;
      const object = await storage.getObject(reference.storageKey, { maxBytes: reference.byteSize });
      if (object.body.byteLength !== reference.byteSize || artifactChecksum(object.body) !== reference.sha256) throw new Error("artifact_blob_unavailable");
      files.push(hydrateArtifactBundleFile(file, object.body));
    }
    return { ...bundle, files };
  }

  async function bindBlobs(tx: Prisma.TransactionClient, ownerUserId: string, versionId: string, assets: readonly ArtifactBundleAsset[]) {
    const writes = [];
    // A consistent hash order also avoids deadlocks between multi-asset edits.
    for (const asset of [...assets].sort((a, b) => artifactChecksum(a.bytes).localeCompare(artifactChecksum(b.bytes)))) {
      const sha256 = artifactChecksum(asset.bytes);
      const blob = await tx.artifactBlob.upsert({ where: { ownerUserId_sha256: { ownerUserId, sha256 } }, update: {},
        create: { ownerUserId, sha256, byteSize: asset.bytes.byteLength, storageKey: `artifact-blobs/${ownerUserId}/${randomUUID()}` } });
      if (blob.byteSize !== asset.bytes.byteLength) throw new Error("artifact_blob_unavailable");
      await tx.artifactVersionBlob.create({ data: { versionId, blobId: blob.id, path: asset.path } });
      await tx.attachmentDeletionJob.upsert({ where: { storageKey: blob.storageKey }, update: {}, create: { storageKey: blob.storageKey } });
      writes.push({ ...blob, bytes: asset.bytes, mimeType: asset.mimeType });
    }
    return writes;
  }

  async function writeBlobs(writes: Awaited<ReturnType<typeof bindBlobs>>) {
    for (const blob of writes) {
      const existing = await storage.getObject(blob.storageKey, { maxBytes: blob.byteSize }).catch(() => null);
      if (existing) {
        if (existing.body.byteLength !== blob.byteSize || artifactChecksum(existing.body) !== blob.sha256) throw new Error("artifact_blob_unavailable");
        continue;
      }
      await storage.putObject({ body: blob.bytes, contentType: blob.mimeType, storageKey: blob.storageKey });
      const written = await storage.getObject(blob.storageKey, { maxBytes: blob.byteSize });
      if (written.body.byteLength !== blob.byteSize || artifactChecksum(written.body) !== blob.sha256) throw new Error("artifact_blob_write_failed");
    }
  }

  async function rendered(row: BundleRow & { artifactId: string; ownerUserId: string }, bundleSource: BundleRow = row) {
    const key = { versionId: row.id, rendererVersion: ARTIFACT_RENDERER_VERSION };
    const readRender = async (render: { renderedStorageKey: string; renderedByteSize: number; renderedChecksum: string; contentType: string }) => {
      if (render.renderedByteSize > ARTIFACT_MAX_RENDER_BYTES) throw new Error("artifact_render_unavailable");
      const object = await storage.getObject(render.renderedStorageKey, { maxBytes: render.renderedByteSize });
      if (object.body.byteLength !== render.renderedByteSize || artifactChecksum(object.body) !== render.renderedChecksum) throw new Error("artifact_render_unavailable");
      return { body: object.body, contentType: render.contentType };
    };
    const existing = await db.artifactRender.findUnique({ where: { versionId_rendererVersion: key } });
    if (existing) return existing.renderedByteSize >= 8 * 1024 * 1024 ? boundedArtifactWork(() => readRender(existing)) : readRender(existing);
    return boundedArtifactWork(async () => {
      const source = await hydrate(row.ownerUserId, row.id, await readBundle(bundleSource));
      const output = renderArtifactBundle(source);
      if (output.body.byteLength > ARTIFACT_MAX_RENDER_BYTES) throw new Error("artifact_render_unavailable");
      const storageKey = `artifact-renders/${row.ownerUserId}/${randomUUID()}`;
      // Reserve cleanup before external I/O. Its existing claim lease protects
      // the short upload/registration gap and expires after a crashed writer.
      const cleanupToken = randomUUID();
      await db.attachmentDeletionJob.create({ data: { storageKey, claimedAt: new Date(), claimToken: cleanupToken } });
      try {
        await storage.putObject({ body: output.body, contentType: output.contentType, storageKey });
        const digest = artifactChecksum(output.body);
        const candidate = { renderedStorageKey: storageKey, renderedByteSize: output.body.byteLength, renderedChecksum: digest, contentType: output.contentType };
        await readRender(candidate);
        const registered = await db.$transaction(async tx => {
          const cleanup = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "AttachmentDeletionJob"
            WHERE "storageKey" = ${storageKey} AND "claimToken" = ${cleanupToken} FOR UPDATE`;
          if (!cleanup.length) throw new Error("artifact_render_unavailable");
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${row.artifactId} FOR UPDATE`);
          if (!await tx.artifactVersion.findFirst({ where: { id: row.id, status: "READY", artifact: { ownerUserId: row.ownerUserId, archivedAt: null } }, select: { id: true } })) throw new Error("artifact_render_unavailable");
          const winner = await tx.artifactRender.findUnique({ where: { versionId_rendererVersion: key } });
          if (winner) return winner;
          const render = await tx.artifactRender.create({ data: { ...key, ...candidate } });
          // Every superseded object already has a deletion job; removing the
          // canonical reference makes it eligible without mutating source bytes.
          await tx.artifactRender.deleteMany({ where: { versionId: row.id, rendererVersion: { not: ARTIFACT_RENDERER_VERSION } } });
          return render;
        });
        return registered.renderedStorageKey === storageKey ? { body: output.body, contentType: output.contentType } : readRender(registered);
      } catch (error) {
        // A writer completing after its lease must leave retryable cleanup,
        // including when a pruner already claimed or removed the first job.
        await db.attachmentDeletionJob.upsert({ where: { storageKey }, create: { storageKey }, update: { claimedAt: null, claimToken: null } });
        throw error;
      }
    });
  }
  return { bindBlobs, hydrate, readBundle, rendered, writeBlobs };
}
