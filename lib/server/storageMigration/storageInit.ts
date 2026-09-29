import { readStorageMarker } from "./copier";
import type { LegacyLayout } from "./legacyLayout";
import {
  assertStorageMarkerBinding,
  createStorageMarker,
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
  legacyLayout(): Promise<LegacyLayout>;
  now(): Date;
  target(): MigrationBucket;
}>;

/**
 * Admits application writers only onto a proven store: a marker bound to this
 * bucket and Compose project, or a genuinely fresh installation. Existing
 * references or legacy objects without a marker mean the migration is pending.
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
  const legacy = await input.legacyLayout();
  if (legacy.kind === "minio" && legacy.hasObjects) throw new StorageMigrationError("storage_migration_required");
  if (await input.databaseHasReferences()) throw new StorageMigrationError("storage_migration_required");
  if (!bucketExists) await target.createBucket();
  const marker = createStorageMarker(identity, { migration: null, now: input.now() });
  const bytes = serializeStorageMarker(marker);
  await target.put(STORAGE_MARKER_KEY, bytes, bytes.byteLength, "application/json", new AbortController().signal);
  return { marker, outcome: "fresh_marker_created" };
}

/** Operator-facing, content-free explanations for guard refusals. */
export const STORAGE_INIT_GUIDANCE: Readonly<Record<string, string>> = {
  storage_legacy_layout_unknown: "The legacy MinIO volume has an unknown layout; nothing was changed.",
  storage_marker_foreign: "The storage marker belongs to another bucket or Compose project; nothing was changed.",
  storage_marker_invalid: "The storage marker is unreadable or has an unknown format; nothing was changed.",
  storage_migration_required:
    "Existing data has not been migrated from MinIO. Follow human_docs/upgrading-from-minio.md; " +
    "the application stays stopped until the migration completes.",
  storage_target_unmarked:
    "The storage volume holds objects without a completion marker (an unfinished migration). " +
    "Rerun scripts/migrate-minio-to-seaweedfs.sh as described in human_docs/upgrading-from-minio.md."
};
