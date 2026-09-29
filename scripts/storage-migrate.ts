// One-time MinIO-to-SeaweedFS copy and host planning for
// scripts/migrate-minio-to-seaweedfs.sh. Output is content-free: phases,
// counts and stable codes, never object keys, file names or credentials.
//
//   (no argument)            explains itself and exits; never copies
//   copy-from-minio-legacy   settle uploads, copy, verify, write the marker
//   plan                     resolve the host plan from JSON on stdin
import { migrateBucket } from "../lib/server/storageMigration/copier";
import { formatHostPlan, HostPlanError, resolveHostPlan } from "../lib/server/storageMigration/hostPlan";
import { StorageMigrationError, storageIdentity } from "../lib/server/storageMigration/marker";
import {
  databaseHasObjectReferences,
  durableObjectReferencePage
} from "../lib/server/storageMigration/objectReferences";
import {
  createMigrationS3Client,
  createS3MigrationBucket,
  storageFailureCode
} from "../lib/server/storageMigration/s3Bucket";
import { isBundledStorageEndpoint } from "../lib/server/storageMigration/storageInit";

const COPY_COMMAND = "copy-from-minio-legacy";
const MIB = 1_024 * 1_024;
const PLAN_INPUT_MAX_BYTES = 16 * MIB;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function concurrency(): number {
  const raw = process.env.AIQSA_STORAGE_MIGRATION_CONCURRENCY?.trim();
  const value = raw ? Number(raw) : 4;
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new StorageMigrationError("storage_migrate_concurrency_invalid");
  }
  return value;
}

// Only the copy needs PostgreSQL; planning runs without database access.
let database: typeof import("../lib/server/prisma").prisma | undefined;

async function copy(): Promise<number> {
  const { prisma } = await import("../lib/server/prisma");
  const { releaseInProgressMultipartKnowledgeUploads } = await import("../lib/server/retention/prune");
  database = prisma;
  const env = process.env;
  if (!isBundledStorageEndpoint(env.S3_ENDPOINT)) throw new StorageMigrationError("storage_endpoint_external");
  if (!env.AIQSA_LEGACY_S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new StorageMigrationError("storage_configuration_incomplete");
  }
  const identity = storageIdentity(env);
  const client = (endpoint: string) => createMigrationS3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    endpoint,
    region: env.S3_REGION || "us-east-1",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!
  });
  try {
    const summary = await migrateBucket({
      concurrency: concurrency(),
      identity,
      multipartPartBytes: 64 * MIB,
      now: () => new Date(),
      progress: (event) => print(
        `storage-migrate: progress phase=${event.phase} objects=${event.objects} copied=${event.copied}` +
        ` verified_existing=${event.verified} bytes=${event.bytes}`
      ),
      references: {
        durablePage: (after, limit) => durableObjectReferencePage(prisma, { after, limit }),
        hasAny: () => databaseHasObjectReferences(prisma)
      },
      settleUploads: () => releaseInProgressMultipartKnowledgeUploads(prisma, { limit: 100, now: new Date() }),
      singlePutMaxBytes: 64 * MIB,
      source: createS3MigrationBucket(client(env.AIQSA_LEGACY_S3_ENDPOINT), identity.bucket),
      target: createS3MigrationBucket(client(env.S3_ENDPOINT!), identity.bucket)
    });
    print(
      `storage-migrate: completed objects=${summary.objectCount} bytes=${summary.totalBytes}` +
      ` copied=${summary.copied} verified_existing=${summary.verifiedExisting}` +
      ` settled_uploads=${summary.settledUploads} aborted_target_uploads=${summary.abortedTargetUploads}` +
      ` missing_references=${summary.missingReferenceCount}`
    );
    return 0;
  } catch (error) {
    if (error instanceof StorageMigrationError && error.code === "storage_migrate_marker_present") {
      print("storage-migrate: already_migrated");
      return 3;
    }
    throw error;
  }
}

async function plan(): Promise<number> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).byteLength;
    if (total > PLAN_INPUT_MAX_BYTES) throw new HostPlanError("storage_plan_input_invalid");
    chunks.push(chunk as Buffer);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new HostPlanError("storage_plan_input_invalid");
  }
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const list = (value: unknown) => Array.isArray(value) ? value : [];
  process.stdout.write(formatHostPlan(resolveHostPlan({
    activeServices: list(record.activeServices).filter((value): value is string => typeof value === "string"),
    config: record.config,
    legacyContainers: list(record.legacyContainers),
    legacyImageId: typeof record.legacyImageId === "string" ? record.legacyImageId : "",
    minioContainers: list(record.minioContainers)
  })));
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === COPY_COMMAND) return copy();
  if (args.length === 1 && args[0] === "plan") return plan();
  print("storage-migrate: this service runs only through scripts/migrate-minio-to-seaweedfs.sh.");
  print("storage-migrate: Nothing was changed.");
  return 2;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    if (error instanceof HostPlanError) {
      print(`error=${error.code}`);
      if (error.detail) print(`detail=${error.detail.replace(/[\u0000-\u001f\u007f]/gu, " ")}`);
    } else {
      print(`storage-migrate: failed ${storageFailureCode(error)}`);
    }
    process.exitCode = 1;
  })
  .finally(() => database?.$disconnect().catch(() => undefined));
