// Object-storage guard and read-only inspection helpers for the bundled
// SeaweedFS store. Output is content-free: outcomes, codes and counts only.
//
//   (no argument)                    guard run by Compose before app writers
//   status                           marker summary and target object count
//   inspect-legacy <root> <bucket>   legacy MinIO layout and size on disk
//   inspect-space <path> [measure]   free space (and usage) below path
//   check-source                     settings of the bucket on the running MinIO
import { readStorageMarker } from "../lib/server/storageMigration/copier";
import {
  availableBytes,
  inspectLegacyLayout,
  measureLegacyUsage
} from "../lib/server/storageMigration/legacyLayout";
import {
  STORAGE_MARKER_KEY,
  storageBucketName,
  StorageMigrationError,
  storageIdentity
} from "../lib/server/storageMigration/marker";
import { databaseHasObjectReferences } from "../lib/server/storageMigration/objectReferences";
import {
  createMigrationS3Client,
  createS3MigrationBucket,
  storageFailureCode,
  type MigrationBucket
} from "../lib/server/storageMigration/s3Bucket";
import {
  isBundledStorageEndpoint,
  runStorageInit,
  STORAGE_INIT_GUIDANCE
} from "../lib/server/storageMigration/storageInit";

const LEGACY_ROOT = "/legacy";

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function targetBucket(): MigrationBucket {
  const env = process.env;
  const { bucket } = storageIdentity(env);
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new StorageMigrationError("storage_configuration_incomplete");
  }
  return createS3MigrationBucket(createMigrationS3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "us-east-1",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  }), bucket);
}

// Only the guard needs PostgreSQL; the inspection commands never load Prisma.
let database: typeof import("../lib/server/prisma").prisma | undefined;

async function guard(): Promise<number> {
  const { prisma } = await import("../lib/server/prisma");
  database = prisma;
  const result = await runStorageInit({
    databaseHasReferences: () => databaseHasObjectReferences(prisma),
    endpoint: process.env.S3_ENDPOINT,
    identity: () => storageIdentity(process.env),
    legacyLayout: () => inspectLegacyLayout(LEGACY_ROOT, storageIdentity(process.env).bucket),
    now: () => new Date(),
    target: targetBucket
  });
  print(`storage-init: ${result.outcome}`);
  return 0;
}

async function countObjects(bucket: MigrationBucket): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const page = await bucket.listPage(token, 1_000);
    count += page.objects.filter(({ key }) => key !== STORAGE_MARKER_KEY).length;
    token = page.next;
  } while (token);
  return count;
}

/** Exit 0: valid marker; 3: no marker; 4: invalid or foreign marker. */
async function status(): Promise<number> {
  const identity = storageIdentity(process.env);
  const bucket = targetBucket();
  if (!await bucket.exists()) {
    print("marker=absent");
    print("objects=0");
    return 3;
  }
  let marker;
  try {
    marker = await readStorageMarker(bucket);
  } catch (error) {
    print(`marker=${storageFailureCode(error)}`);
    return 4;
  }
  const objects = await countObjects(bucket);
  if (!marker) {
    print("marker=absent");
    print(`objects=${objects}`);
    return 3;
  }
  const foreign = marker.bucket !== identity.bucket || marker.composeProject !== identity.composeProject;
  print(`marker=${foreign ? "storage_marker_foreign" : "valid"}`);
  print(`marker_source=${marker.source}`);
  print(`marker_bucket=${marker.bucket}`);
  print(`marker_project=${marker.composeProject}`);
  print(`marker_storage_id=${marker.storageId}`);
  print(`marker_created_at=${marker.createdAt}`);
  if (marker.migration) {
    print(`migrated_objects=${marker.migration.objectCount}`);
    print(`migrated_bytes=${marker.migration.totalBytes}`);
    print(`migrated_missing_references=${marker.migration.missingReferenceCount}`);
    print(`migrated_at=${marker.migration.completedAt}`);
  }
  print(`objects=${objects}`);
  return foreign ? 4 : 0;
}

async function inspectLegacy(root: string | undefined, bucketName: string | undefined): Promise<number> {
  if (!root?.startsWith("/")) throw new StorageMigrationError("storage_inspection_arguments_invalid");
  const bucket = storageBucketName(bucketName);
  let layout;
  try {
    layout = await inspectLegacyLayout(root, bucket);
  } catch (error) {
    if (error instanceof StorageMigrationError && error.code === "storage_legacy_layout_unknown") {
      print("layout=unknown");
      return 0;
    }
    throw error;
  }
  print(`layout=${layout.kind}`);
  print(`objects=${layout.kind === "minio" && layout.hasObjects ? "yes" : "no"}`);
  const usage = await measureLegacyUsage(root);
  print(`bytes=${usage.bytes}`);
  print(`files=${usage.files}`);
  return 0;
}

async function inspectSpace(path: string | undefined, measure: boolean): Promise<number> {
  if (!path?.startsWith("/")) throw new StorageMigrationError("storage_inspection_arguments_invalid");
  print(`available=${await availableBytes(path)}`);
  if (measure) print(`used=${(await measureLegacyUsage(path)).bytes}`);
  return 0;
}

/**
 * Before a migration the bundled `minio:9000` is still the old MinIO. Refuse a
 * bucket the copier could not reproduce, while nothing has been changed yet.
 */
async function checkSource(): Promise<number> {
  const env = process.env;
  if (!isBundledStorageEndpoint(env.S3_ENDPOINT) || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new StorageMigrationError("storage_configuration_incomplete");
  }
  const source = createS3MigrationBucket(createMigrationS3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION || "us-east-1",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  }), storageBucketName(env.S3_BUCKET));
  if (!await source.exists()) {
    print("source=absent");
    return 0;
  }
  const settings = await source.settings();
  const code = settings.versioning ? "storage_migrate_source_versioned"
    : settings.encryption ? "storage_migrate_source_encrypted"
      : settings.objectLock ? "storage_migrate_source_object_lock"
        : settings.policy ? "storage_migrate_source_not_private" : "ok";
  print(`source=${code}`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) return guard();
  if (command === "status" && rest.length === 0) return status();
  if (command === "check-source" && rest.length === 0) return checkSource();
  if (command === "inspect-legacy" && rest.length === 2) return inspectLegacy(rest[0], rest[1]);
  if (command === "inspect-space" && (rest.length === 1 || (rest.length === 2 && rest[1] === "measure"))) {
    return inspectSpace(rest[0], rest.length === 2);
  }
  print("storage-init: usage: storage-init.ts [status | check-source | inspect-legacy <root> <bucket> | inspect-space <path> [measure]]");
  return 2;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = storageFailureCode(error);
    print(`storage-init: refused ${code}`);
    const guidance = STORAGE_INIT_GUIDANCE[code];
    if (guidance) process.stderr.write(`${guidance}\n`);
    process.exitCode = 1;
  })
  .finally(() => database?.$disconnect().catch(() => undefined));
