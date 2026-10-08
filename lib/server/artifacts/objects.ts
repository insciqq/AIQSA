import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../uploads/storage";
import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { ARTIFACT_MAX_RENDER_BYTES, ARTIFACT_RENDERER_VERSION, decodeArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle, type ArtifactBundle, type ArtifactBundleAsset, type ArtifactBundleFile } from "./bundle";
import { ARTIFACT_RESOURCE_LIMITS } from "./resourcePolicy";

export const artifactChecksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type BundleRow = { id: string; bundleStorageKey: string; byteSize: number; checksum: string };
type RenderedContent = Readonly<{ body: Buffer; contentType: string }>;

/** Heavy artifact work in this process (renders, exports, large reads) runs at most four at once. */
const ARTIFACT_HEAVY_WORK_LIMIT = 4;
/**
 * Work over more hydrated bytes than this is large and runs one at a time. A render peaks at
 * about ten times its input (some 220 MB above baseline for one 21 MB page), so one large job
 * beside three of at most 8 MiB stays well inside a 2 GB app container, while four 32 MiB
 * jobs would not. A cached render of 8 MiB or more is read under the general limit.
 */
export const ARTIFACT_LARGE_WORK_BYTES = 8 * 1024 * 1024;
/** Large work waits for its turn behind at most four others, and at most 10 s, then reports busy. */
const LARGE_WORK_WAITERS = 4;
const LARGE_WORK_WAIT_MS = 10_000;
/** Pages other than the entry share this render-cache budget per version; beyond it they render per request. */
export const ARTIFACT_PAGE_RENDER_CACHE_BYTES = 256 * 1024 * 1024;
let activeHeavyReads = 0;
let largeWorkActive = false;
const largeWorkQueue: Array<() => void> = [];
/** One render of each cold page at a time in this process; concurrent requests share its result. */
const renderFlights = new Map<string, Promise<RenderedContent>>();
export class ArtifactPublicBusyError extends Error { constructor() { super("artifact_public_busy"); } }

async function acquireLargeWork(): Promise<void> {
  if (!largeWorkActive) { largeWorkActive = true; return; }
  if (largeWorkQueue.length >= LARGE_WORK_WAITERS) throw new ArtifactPublicBusyError();
  await new Promise<void>((resolve, reject) => {
    const grant = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const index = largeWorkQueue.indexOf(grant);
      if (index >= 0) largeWorkQueue.splice(index, 1);
      reject(new ArtifactPublicBusyError());
    }, LARGE_WORK_WAIT_MS);
    largeWorkQueue.push(grant);
  });
}

/** The turn passes straight to the oldest waiter, so newcomers cannot overtake it. */
function releaseLargeWork(): void {
  const next = largeWorkQueue.shift();
  if (next) next();
  else largeWorkActive = false;
}

/** Runs heavy work within the process limits; `bytes` is how much hydrated content it materializes. */
export async function boundedArtifactWork<T>(work: () => Promise<T>, bytes = 0): Promise<T> {
  const large = bytes > ARTIFACT_LARGE_WORK_BYTES;
  if (large) await acquireLargeWork();
  if (activeHeavyReads >= ARTIFACT_HEAVY_WORK_LIMIT) {
    if (large) releaseLargeWork();
    throw new ArtifactPublicBusyError();
  }
  activeHeavyReads += 1;
  try { return await work(); } finally {
    activeHeavyReads -= 1;
    if (large) releaseLargeWork();
  }
}

export function createArtifactObjects(db: PrismaClient, storage: StorageAdapter) {
  async function readBundle(row: BundleRow): Promise<ArtifactBundle> {
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || artifactChecksum(object.body) !== row.checksum) throw new Error("artifact_bundle_unavailable");
    return decodeArtifactBundle(object.body);
  }

  /** Read and verify blob bytes; `only` limits which blob files are materialized. */
  async function hydrate(ownerUserId: string, versionId: string, bundle: ArtifactBundle, options: { only?: (file: ArtifactBundleFile) => boolean } = {}): Promise<ArtifactBundle> {
    if (!bundle.files.some(file => file.blob && (!options.only || options.only(file)))) return bundle;
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
      if (!file.blob || options.only && !options.only(file)) { files.push(file); continue; }
      const reference = references.find(reference => reference.path === file.path)!.blob;
      const object = await storage.getObject(reference.storageKey, { maxBytes: reference.byteSize });
      if (object.body.byteLength !== reference.byteSize || artifactChecksum(object.body) !== reference.sha256) throw new Error("artifact_blob_unavailable");
      files.push(hydrateArtifactBundleFile(file, object.body));
    }
    return { ...bundle, files };
  }

  async function bindBlobs(tx: Prisma.TransactionClient, ownerUserId: string, versionId: string, assets: readonly ArtifactBundleAsset[]) {
    // An unpacked site binds hundreds of files inside one interactive
    // transaction: one statement per table keeps it far from its timeout.
    // Rows are written in one consistent hash order, which also avoids
    // deadlocks between concurrent multi-asset edits.
    const hashed = assets.map(asset => ({ asset, sha256: artifactChecksum(asset.bytes) })).sort((a, b) => a.sha256.localeCompare(b.sha256));
    if (!hashed.length) return [];
    const sizes = new Map(hashed.map(({ asset, sha256 }) => [sha256, asset.bytes.byteLength]));
    await tx.artifactBlob.createMany({ skipDuplicates: true, data: [...sizes].map(([sha256, byteSize]) =>
      ({ ownerUserId, sha256, byteSize, storageKey: `artifact-blobs/${ownerUserId}/${randomUUID()}` })) });
    const blobs = new Map((await tx.artifactBlob.findMany({ where: { ownerUserId, sha256: { in: [...sizes.keys()] } } })).map(blob => [blob.sha256, blob]));
    const writes = hashed.map(({ asset, sha256 }) => {
      const blob = blobs.get(sha256);
      if (!blob || blob.byteSize !== asset.bytes.byteLength) throw new Error("artifact_blob_unavailable");
      return { ...blob, bytes: asset.bytes, mimeType: asset.mimeType, path: asset.path };
    });
    await tx.artifactVersionBlob.createMany({ data: writes.map(blob => ({ versionId, blobId: blob.id, path: blob.path })) });
    await tx.attachmentDeletionJob.createMany({ skipDuplicates: true, data: [...blobs.values()].map(blob => ({ storageKey: blob.storageKey })) });
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

  type RenderRecord = { renderedStorageKey: string; renderedByteSize: number; renderedChecksum: string; contentType: string };
  type RenderKey = { versionId: string; rendererVersion: number; page: string };
  async function readRender(render: RenderRecord): Promise<RenderedContent> {
    if (render.renderedByteSize > ARTIFACT_MAX_RENDER_BYTES) throw new Error("artifact_render_unavailable");
    const object = await storage.getObject(render.renderedStorageKey, { maxBytes: render.renderedByteSize });
    if (object.body.byteLength !== render.renderedByteSize || artifactChecksum(object.body) !== render.renderedChecksum) throw new Error("artifact_render_unavailable");
    return { body: object.body, contentType: render.contentType };
  }

  /**
   * One verified render of a version page (the entry page without `page`), cached per
   * (version, renderer version, page) for the owner's views and publications alike; callers
   * authorize the version and select the page from its manifest first. A cold render runs
   * once per page in this process, under the heavy-work limits sized by `bytes`.
   */
  async function rendered(row: BundleRow & { artifactId: string; ownerUserId: string }, options: { page?: string; bytes?: number } = {}): Promise<RenderedContent> {
    const key: RenderKey = { versionId: row.id, rendererVersion: ARTIFACT_RENDERER_VERSION, page: options.page ?? "" };
    const existing = await db.artifactRender.findUnique({ where: { versionId_rendererVersion_page: key } });
    if (existing) return existing.renderedByteSize >= ARTIFACT_LARGE_WORK_BYTES ? boundedArtifactWork(() => readRender(existing)) : readRender(existing);
    const flightKey = JSON.stringify([key.versionId, key.rendererVersion, key.page]);
    let flight = renderFlights.get(flightKey);
    if (!flight) {
      flight = boundedArtifactWork(() => renderAndCache(row, key, options.page), options.bytes).finally(() => renderFlights.delete(flightKey));
      renderFlights.set(flightKey, flight);
    }
    return flight;
  }

  async function renderAndCache(row: BundleRow & { artifactId: string; ownerUserId: string }, key: RenderKey, page: string | undefined): Promise<RenderedContent> {
    const source = await hydrate(row.ownerUserId, row.id, await readBundle(row));
    const output = renderArtifactBundle(source, false, page);
    if (output.body.byteLength > ARTIFACT_MAX_RENDER_BYTES) throw new Error("artifact_render_unavailable");
    if (page !== undefined) {
      // Each page carries every file it does not inline, so a many-page site could multiply
      // its whole bundle here; past the budget a page is served without being stored.
      const cached = await db.artifactRender.aggregate({ where: { versionId: row.id, rendererVersion: ARTIFACT_RENDERER_VERSION, page: { not: "" } },
        _sum: { renderedByteSize: true } });
      if ((cached._sum.renderedByteSize ?? 0) + output.body.byteLength > ARTIFACT_PAGE_RENDER_CACHE_BYTES) return { body: output.body, contentType: output.contentType };
    }
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
        const winner = await tx.artifactRender.findUnique({ where: { versionId_rendererVersion_page: key } });
        if (winner) return winner;
        const render = await tx.artifactRender.create({ data: { ...key, ...candidate } });
        // Every superseded object already has a deletion job; removing the canonical
        // reference of every page makes it eligible without mutating source bytes.
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
  }
  return { bindBlobs, hydrate, readBundle, rendered, writeBlobs };
}
