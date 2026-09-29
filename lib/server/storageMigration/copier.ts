import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  assertStorageMarkerBinding,
  createStorageMarker,
  parseStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY,
  STORAGE_MARKER_MAX_BYTES,
  StorageMigrationError,
  type StorageIdentity,
  type StorageMarker
} from "./marker";
import type { MigrationBucket, ObjectHead } from "./s3Bucket";

export type CopyProgress = Readonly<{
  bytes: number;
  copied: number;
  objects: number;
  phase: "copy" | "references" | "settle" | "target_scan" | "verify";
  verified: number;
}>;

export type MigrationSummary = Readonly<{
  abortedTargetUploads: number;
  copied: number;
  marker: StorageMarker;
  missingReferenceCount: number;
  objectCount: number;
  settledUploads: number;
  totalBytes: number;
  verifiedExisting: number;
}>;

export type MigrationReferences = Readonly<{
  /** Any key column holds a value. */
  hasAny(): Promise<boolean>;
  /** Keyset pages of distinct keys that must exist. */
  durablePage(after: string | null, limit: number): Promise<string[]>;
}>;

export type MigrationInput = Readonly<{
  concurrency: number;
  identity: StorageIdentity;
  listPageSize?: number;
  multipartPartBytes: number;
  now(): Date;
  progress(event: CopyProgress): void;
  references: MigrationReferences;
  /** Settles in-progress direct uploads in PostgreSQL; returns the count. */
  settleUploads(): Promise<number>;
  singlePutMaxBytes: number;
  source: MigrationBucket;
  target: MigrationBucket;
}>;

const MAX_MULTIPART_PARTS = 10_000;

async function mapBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  let failure: unknown;
  const runner = async () => {
    while (failure === undefined && index < items.length) {
      const item = items[index++]!;
      try { await work(item); } catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (failure !== undefined) throw failure;
}

async function* pages(bucket: MigrationBucket, limit: number) {
  let token: string | undefined;
  do {
    const page = await bucket.listPage(token, limit);
    yield page.objects.filter(({ key }) => key !== STORAGE_MARKER_KEY);
    token = page.next;
  } while (token);
}

/** Streams a body through SHA-256 and requires exactly byteSize bytes. */
function meter(byteSize: number, hash: ReturnType<typeof createHash>): Transform {
  let observed = 0;
  return new Transform({
    flush(callback) {
      callback(observed === byteSize ? null : new StorageMigrationError("storage_migrate_size_mismatch"));
    },
    transform(chunk: Buffer, _encoding, callback) {
      observed += chunk.byteLength;
      if (observed > byteSize) {
        callback(new StorageMigrationError("storage_migrate_size_mismatch"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
}

async function digest(body: Readable, byteSize: number): Promise<string> {
  const hash = createHash("sha256");
  let observed = 0;
  for await (const chunk of body) {
    observed += (chunk as Buffer).byteLength;
    if (observed > byteSize) {
      body.destroy();
      throw new StorageMigrationError("storage_migrate_size_mismatch");
    }
    hash.update(chunk as Buffer);
  }
  if (observed !== byteSize) throw new StorageMigrationError("storage_migrate_size_mismatch");
  return hash.digest("hex");
}

/**
 * Pipes source bytes into one target request. A source or meter failure aborts
 * the request instead of leaving it waiting for bytes that never arrive.
 */
async function transferBody(
  source: Readable,
  byteSize: number,
  hash: ReturnType<typeof createHash>,
  send: (body: Readable, signal: AbortSignal) => Promise<unknown>
): Promise<void> {
  const abort = new AbortController();
  const body = meter(byteSize, hash);
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    abort.abort(error);
    source.destroy();
    body.destroy();
  };
  source.on("error", fail);
  body.on("error", fail);
  source.pipe(body);
  try {
    await send(body, abort.signal);
  } catch (error) {
    throw failure ?? error;
  } finally {
    source.destroy();
  }
  if (failure) throw failure;
}

async function sameContent(input: MigrationInput, key: string, head: ObjectHead): Promise<boolean> {
  const [source, target] = await Promise.all([input.source.read(key), input.target.read(key)]);
  try {
    if (target.byteSize !== head.byteSize || target.contentType !== head.contentType) return false;
    const [left, right] = await Promise.all([digest(source.body, head.byteSize), digest(target.body, head.byteSize)]);
    return left === right;
  } finally {
    source.body.destroy();
    target.body.destroy();
  }
}

async function copyObject(input: MigrationInput, key: string, head: ObjectHead): Promise<string> {
  const hash = createHash("sha256");
  if (head.byteSize === 0) {
    await input.target.put(key, new Uint8Array(0), 0, head.contentType, new AbortController().signal);
    return hash.digest("hex");
  }
  if (head.byteSize <= input.singlePutMaxBytes) {
    const source = await input.source.read(key);
    if (source.byteSize !== head.byteSize) {
      source.body.destroy();
      throw new StorageMigrationError("storage_migrate_source_changed");
    }
    await transferBody(source.body, head.byteSize, hash, (body, signal) =>
      input.target.put(key, body, head.byteSize, head.contentType, signal));
    return hash.digest("hex");
  }
  const partBytes = Math.max(input.multipartPartBytes, Math.ceil(head.byteSize / MAX_MULTIPART_PARTS));
  const uploadId = await input.target.createMultipart(key, head.contentType);
  try {
    const parts: Array<{ etag: string; partNumber: number }> = [];
    for (let start = 0, partNumber = 1; start < head.byteSize; start += partBytes, partNumber += 1) {
      const end = Math.min(head.byteSize, start + partBytes) - 1;
      const length = end - start + 1;
      const source = await input.source.read(key, { end, start });
      let etag = "";
      await transferBody(source.body, length, hash, async (body, signal) => {
        etag = await input.target.uploadPart(key, uploadId, partNumber, body, length, signal);
      });
      parts.push({ etag, partNumber });
    }
    await input.target.completeMultipart(key, uploadId, parts);
  } catch (error) {
    await input.target.abortMultipart(key, uploadId).catch(() => undefined);
    throw error;
  }
  return hash.digest("hex");
}

async function verifyTarget(input: MigrationInput, key: string, head: ObjectHead, sha256: string): Promise<void> {
  const target = await input.target.read(key);
  try {
    if (target.byteSize !== head.byteSize || target.contentType !== head.contentType ||
      await digest(target.body, head.byteSize) !== sha256) {
      throw new StorageMigrationError("storage_migrate_verification_failed");
    }
  } finally {
    target.body.destroy();
  }
}

export async function readStorageMarker(bucket: MigrationBucket): Promise<StorageMarker | null> {
  const bytes = await bucket.readSmall(STORAGE_MARKER_KEY, STORAGE_MARKER_MAX_BYTES);
  return bytes ? parseStorageMarker(bytes) : null;
}

/**
 * Copies the legacy bucket into the target and writes the migrated marker
 * last. Every object is proven by size, ContentType and SHA-256 in this run;
 * an object already present on the target is skipped only after that proof.
 */
export async function migrateBucket(input: MigrationInput): Promise<MigrationSummary> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32) {
    throw new RangeError("storage_migrate_concurrency_invalid");
  }
  const pageSize = input.listPageSize ?? 1_000;
  const targetExists = await input.target.exists();
  if (targetExists) {
    const marker = await readStorageMarker(input.target);
    if (marker) {
      assertStorageMarkerBinding(marker, input.identity);
      throw new StorageMigrationError("storage_migrate_marker_present");
    }
  }

  const sourceExists = await input.source.exists();
  if (sourceExists) {
    const settings = await input.source.settings();
    if (settings.versioning) throw new StorageMigrationError("storage_migrate_source_versioned");
    if (settings.encryption) throw new StorageMigrationError("storage_migrate_source_encrypted");
    if (settings.objectLock) throw new StorageMigrationError("storage_migrate_source_object_lock");
    if (settings.policy) throw new StorageMigrationError("storage_migrate_source_not_private");
  }
  const sourceEmpty = !sourceExists || (await input.source.listPage(undefined, 1)).objects.length === 0;
  if (sourceEmpty && await input.references.hasAny()) {
    throw new StorageMigrationError("storage_migrate_source_empty_with_references");
  }

  if (!targetExists) await input.target.createBucket();
  const abortedTargetUploads = await input.target.abortMultipartUploads();

  // Only this run writes the unmarked target: anything absent from the frozen
  // source means the target is not a partial copy of it.
  input.progress({ bytes: 0, copied: 0, objects: 0, phase: "target_scan", verified: 0 });
  for await (const page of pages(input.target, pageSize)) {
    await mapBounded(page, input.concurrency, async ({ key }) => {
      if (!sourceExists || !await input.source.head(key)) {
        throw new StorageMigrationError("storage_migrate_target_unexpected_objects");
      }
    });
  }

  // PostgreSQL-only settlement runs after every refusal check.
  input.progress({ bytes: 0, copied: 0, objects: 0, phase: "settle", verified: 0 });
  const settledUploads = await input.settleUploads();

  let objectCount = 0;
  let totalBytes = 0;
  let copied = 0;
  let verifiedExisting = 0;
  let lastProgress = Date.now();
  const report = (phase: CopyProgress["phase"], force = false) => {
    if (!force && Date.now() - lastProgress < 5_000) return;
    lastProgress = Date.now();
    input.progress({ bytes: totalBytes, copied, objects: objectCount, phase, verified: verifiedExisting });
  };
  if (sourceExists) {
    for await (const page of pages(input.source, pageSize)) {
      await mapBounded(page, input.concurrency, async ({ byteSize, key }) => {
        const head = await input.source.head(key);
        if (!head || head.byteSize !== byteSize) throw new StorageMigrationError("storage_migrate_source_changed");
        if (head.encrypted) throw new StorageMigrationError("storage_migrate_source_encrypted");
        const existing = await input.target.head(key);
        if (existing && existing.byteSize === head.byteSize && existing.contentType === head.contentType &&
          await sameContent(input, key, head)) {
          verifiedExisting += 1;
        } else {
          await verifyTarget(input, key, head, await copyObject(input, key, head));
          copied += 1;
        }
        objectCount += 1;
        totalBytes += head.byteSize;
        report("copy");
      });
    }
  }
  report("copy", true);

  let targetCount = 0;
  for await (const page of pages(input.target, pageSize)) targetCount += page.length;
  if (targetCount !== objectCount) throw new StorageMigrationError("storage_migrate_verification_failed");
  report("verify", true);

  let missingReferenceCount = 0;
  let after: string | null = null;
  for (;;) {
    const keys = await input.references.durablePage(after, pageSize);
    if (keys.length === 0) break;
    await mapBounded(keys, input.concurrency, async (key) => {
      if (!await input.target.head(key)) missingReferenceCount += 1;
    });
    after = keys[keys.length - 1]!;
  }
  input.progress({ bytes: totalBytes, copied, objects: objectCount, phase: "references", verified: verifiedExisting });

  const completedAt = input.now();
  const marker = createStorageMarker(input.identity, {
    migration: { completedAt: completedAt.toISOString(), missingReferenceCount, objectCount, totalBytes },
    now: completedAt
  });
  const bytes = serializeStorageMarker(marker);
  await input.target.put(STORAGE_MARKER_KEY, bytes, bytes.byteLength, "application/json", new AbortController().signal);
  return {
    abortedTargetUploads,
    copied,
    marker,
    missingReferenceCount,
    objectCount,
    settledUploads,
    totalBytes,
    verifiedExisting
  };
}
