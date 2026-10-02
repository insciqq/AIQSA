import {
  assertStorageMarkerBinding,
  createStorageMarker,
  readStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY,
  StorageMigrationError,
  type StorageIdentity,
  type StorageMarker
} from "./marker";
import type { MigrationBucket } from "./s3Bucket";

export const BUNDLED_STORAGE_ENDPOINT = "http://minio:9000";

export function isBundledStorageEndpoint(endpoint: string | undefined): boolean {
  return endpoint?.trim().replace(/\/+$/u, "") === BUNDLED_STORAGE_ENDPOINT;
}

export type StorageInitOutcome = "external_endpoint" | "fresh_marker_created" | "marker_valid";

export type StorageInitInput = Readonly<{
  databaseHasReferences(): Promise<boolean>;
  endpoint: string | undefined;
  identity(): StorageIdentity;
  now(): Date;
  target(): MigrationBucket;
}>;

/**
 * Admits application writers only onto a proven store: a marker bound to this
 * bucket and Compose project, or a genuinely fresh installation. Existing
 * references without a marker mean the MinIO migration is pending.
 */
export async function runStorageInit(input: StorageInitInput): Promise<Readonly<{
  marker: StorageMarker | null;
  outcome: StorageInitOutcome;
}>> {
  if (!isBundledStorageEndpoint(input.endpoint)) return { marker: null, outcome: "external_endpoint" };
  const identity = input.identity();
  const target = input.target();
  const bucketExists = await target.exists();
  if (bucketExists) {
    const marker = await readStorageMarker(target);
    if (marker) {
      assertStorageMarkerBinding(marker, identity);
      return { marker, outcome: "marker_valid" };
    }
    const first = await target.listPage(undefined, 2);
    if (first.objects.some(({ key }) => key !== STORAGE_MARKER_KEY)) {
      throw new StorageMigrationError("storage_target_unmarked");
    }
  }
  if (await input.databaseHasReferences()) throw new StorageMigrationError("storage_migration_required");
  if (!bucketExists) await target.createBucket();
  const marker = createStorageMarker(identity, { migration: null, now: input.now() });
  const bytes = serializeStorageMarker(marker);
  await target.put(STORAGE_MARKER_KEY, bytes, bytes.byteLength, "application/json", new AbortController().signal);
  return { marker, outcome: "fresh_marker_created" };
}

/** The last release that contains the one-time MinIO-to-SeaweedFS migration. */
const STORAGE_MIGRATION_RELEASE = "v0.2.34";

const RESTORE_THROUGH_MIGRATION_RELEASE =
  "Nothing was changed in object storage, but this release may already have migrated the database. " +
  "Restore the PostgreSQL backup taken before this upgrade, check out " + STORAGE_MIGRATION_RELEASE +
  " and follow its UPGRADING_FROM_MINIO.md, then upgrade again.";

/** Operator-facing, content-free explanations for guard refusals. */
export const STORAGE_INIT_GUIDANCE: Readonly<Record<string, string>> = {
  storage_marker_foreign: "The storage marker belongs to another bucket or Compose project; nothing was changed.",
  storage_marker_invalid: "The storage marker is unreadable or has an unknown format; nothing was changed.",
  storage_migration_required:
    "Existing data has not been migrated from MinIO. " + RESTORE_THROUGH_MIGRATION_RELEASE,
  storage_target_unmarked:
    "The storage volume holds objects without a completion marker (an unfinished MinIO migration). " +
    RESTORE_THROUGH_MIGRATION_RELEASE
};
