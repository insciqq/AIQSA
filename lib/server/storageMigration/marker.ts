import { randomUUID } from "node:crypto";

// A reserved object outside every application key namespace. The application
// never lists the bucket, so the marker is invisible to it.
export const STORAGE_MARKER_KEY = "_aiqsa/storage-marker.json";
export const STORAGE_MARKER_FORMAT = "aiqsa.storage-marker";
export const STORAGE_MARKER_VERSION = 1;
export const STORAGE_MARKER_MAX_BYTES = 16 * 1_024;

export type StorageMarkerMigration = Readonly<{
  completedAt: string;
  missingReferenceCount: number;
  objectCount: number;
  totalBytes: number;
}>;

export type StorageMarker = Readonly<{
  bucket: string;
  composeProject: string;
  createdAt: string;
  format: typeof STORAGE_MARKER_FORMAT;
  migration: StorageMarkerMigration | null;
  source: "fresh" | "migrated";
  storageId: string;
  version: typeof STORAGE_MARKER_VERSION;
}>;

export type StorageIdentity = Readonly<{ bucket: string; composeProject: string }>;

export class StorageMigrationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StorageMigrationError";
    this.code = code;
  }
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function storageBucketName(value: string | undefined): string {
  const bucket = value?.trim() ?? "";
  if (!BUCKET.test(bucket) || bucket.includes("..")) throw new StorageMigrationError("storage_bucket_invalid");
  return bucket;
}

export function storageIdentity(env: Record<string, string | undefined>): StorageIdentity {
  const bucket = storageBucketName(env.S3_BUCKET);
  const composeProject = env.AIQSA_STORAGE_PROJECT?.trim() ?? "";
  if (!PROJECT.test(composeProject)) throw new StorageMigrationError("storage_project_identity_invalid");
  return { bucket, composeProject };
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseMigration(value: unknown): StorageMarkerMigration | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!timestamp(record.completedAt) || !count(record.missingReferenceCount) ||
    !count(record.objectCount) || !count(record.totalBytes)) return null;
  return {
    completedAt: record.completedAt,
    missingReferenceCount: record.missingReferenceCount,
    objectCount: record.objectCount,
    totalBytes: record.totalBytes
  };
}

/** Parses a stored marker; any unknown format or version is invalid. */
export function parseStorageMarker(bytes: Uint8Array): StorageMarker {
  if (bytes.byteLength > STORAGE_MARKER_MAX_BYTES) throw new StorageMigrationError("storage_marker_invalid");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StorageMigrationError("storage_marker_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageMigrationError("storage_marker_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== STORAGE_MARKER_FORMAT || record.version !== STORAGE_MARKER_VERSION) {
    throw new StorageMigrationError("storage_marker_invalid");
  }
  const migration = record.source === "migrated" ? parseMigration(record.migration) : null;
  if (typeof record.bucket !== "string" || !BUCKET.test(record.bucket) ||
    typeof record.composeProject !== "string" || !PROJECT.test(record.composeProject) ||
    typeof record.storageId !== "string" || !UUID.test(record.storageId) ||
    !timestamp(record.createdAt) ||
    (record.source === "fresh" && record.migration !== null) ||
    (record.source === "migrated" && !migration) ||
    (record.source !== "fresh" && record.source !== "migrated")) {
    throw new StorageMigrationError("storage_marker_invalid");
  }
  return {
    bucket: record.bucket,
    composeProject: record.composeProject,
    createdAt: record.createdAt,
    format: STORAGE_MARKER_FORMAT,
    migration,
    source: record.source,
    storageId: record.storageId,
    version: STORAGE_MARKER_VERSION
  };
}

/** A readable marker must belong to this bucket and Compose project. */
export function assertStorageMarkerBinding(marker: StorageMarker, identity: StorageIdentity): void {
  if (marker.bucket !== identity.bucket || marker.composeProject !== identity.composeProject) {
    throw new StorageMigrationError("storage_marker_foreign");
  }
}

export function createStorageMarker(
  identity: StorageIdentity,
  input: Readonly<{ migration: StorageMarkerMigration | null; now: Date }>
): StorageMarker {
  return {
    bucket: identity.bucket,
    composeProject: identity.composeProject,
    createdAt: input.now.toISOString(),
    format: STORAGE_MARKER_FORMAT,
    migration: input.migration,
    source: input.migration ? "migrated" : "fresh",
    storageId: randomUUID(),
    version: STORAGE_MARKER_VERSION
  };
}

export function serializeStorageMarker(marker: StorageMarker): Buffer {
  return Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
}

/** Reads the bucket's marker; null when none exists. */
export async function readStorageMarker(
  bucket: Readonly<{ readSmall(key: string, maxBytes: number): Promise<Uint8Array | null> }>
): Promise<StorageMarker | null> {
  const bytes = await bucket.readSmall(STORAGE_MARKER_KEY, STORAGE_MARKER_MAX_BYTES);
  return bytes ? parseStorageMarker(bytes) : null;
}
