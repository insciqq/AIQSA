import { createS3StorageAdapter } from "../lib/server/uploads/storage";
import { prisma } from "../lib/server/prisma";
import {
  createPrismaRetentionRepository,
  drainDeletionObligations
} from "../lib/server/retention/prune";

const providerCredentialNames = [
  "ANTHROPIC_API_KEY",
  "CUSTOM_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "_DEV_CUSTOM_OPENAI_API_KEY"
] as const;

function assertIsolatedRuntime(): void {
  if (
    process.env.AIQSA_RESTORE_RECONCILIATION !== "YES" ||
    process.env.AIQSA_RESTORE_NETWORK_ISOLATED !== "YES"
  ) {
    throw new Error("knowledge_restore_reconciliation_not_authorized");
  }
  if (providerCredentialNames.some((name) => Boolean(process.env[name]))) {
    throw new Error("knowledge_restore_provider_credentials_forbidden");
  }
  const postgresService = process.env.AIQSA_RESTORE_POSTGRES_SERVICE;
  const minioService = process.env.AIQSA_RESTORE_MINIO_SERVICE;
  if (
    !postgresService ||
    !minioService ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(postgresService) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(minioService)
  ) {
    throw new Error("knowledge_restore_service_identity_invalid");
  }

  let databaseUrl: URL;
  let storageUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    storageUrl = new URL(process.env.S3_ENDPOINT ?? "");
  } catch {
    throw new Error("knowledge_restore_endpoint_invalid");
  }
  if (
    databaseUrl.protocol !== "postgresql:" ||
    databaseUrl.hostname !== postgresService ||
    storageUrl.protocol !== "http:" ||
    storageUrl.hostname !== minioService
  ) {
    throw new Error("knowledge_restore_endpoint_not_isolated");
  }
}

async function main(): Promise<void> {
  assertIsolatedRuntime();
  const summary = await drainDeletionObligations({
    batchSize: 100,
    repository: createPrismaRetentionRepository(prisma),
    storage: createS3StorageAdapter()
  });
  const [unresolved, pendingObjects] = await Promise.all([
    prisma.knowledgeDeletionJob.count({
      where: { state: { in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT", "RUNNING"] } }
    }),
    prisma.knowledgeDeletionObject.count({ where: { disposition: "PENDING" } })
  ]);
  if (
    summary.exhausted ||
    summary.attachmentJobs.failed > 0 ||
    summary.knowledgeJobs.blocked > 0 ||
    summary.knowledgeJobs.failed > 0 ||
    unresolved > 0 ||
    pendingObjects > 0
  ) {
    throw new Error("knowledge_restore_reconciliation_pending");
  }
  console.error("AIQSA Knowledge restore reconciliation passed.");
}

void main()
  .catch((error: unknown) => {
    const code = error instanceof Error && /^knowledge_[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "knowledge_restore_reconciliation_failed";
    console.error(`AIQSA Knowledge restore reconciliation blocked: ${code}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
