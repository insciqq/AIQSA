import { createSourcePurgeDeletionHandler } from
  "../lib/server/chats/permanentDeletion/sourcePurge";
import { createPrismaPermanentChatDeletionHandler } from
  "../lib/server/chats/permanentDeletion/cleanup";
import { createS3StorageAdapter } from "../lib/server/uploads/storage";
import {
  createPrismaAccountMemoryDeletionHandler
} from "../lib/server/memory/accountDeletion";
import { MemoryCoordinator } from "../lib/server/memory/coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from
  "../lib/server/memory/coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from
  "../lib/server/memory/coordinator/registry";
import {
  auditMemoryHistoryClearDeletion,
  memoryHistoryClearDeletionHandler,
  memoryHistorySourceDeletionHandler
} from "../lib/server/memory/history/purge";
import {
  defaultMemoryDeletionContributorRegistry,
  reconcileDefaultCompletedMemoryDeletionAudits
} from "../lib/server/memory/purge/defaultPurge";
import { createPrismaTemporaryChatDeletionHandler } from
  "../lib/server/memory/temporaryDeletion";
import { prisma } from "../lib/server/prisma";

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
    throw new Error("memory_restore_reconciliation_not_authorized");
  }
  if (providerCredentialNames.some((name) => Boolean(process.env[name]))) {
    throw new Error("memory_restore_provider_credentials_forbidden");
  }

  const postgresService = process.env.AIQSA_RESTORE_POSTGRES_SERVICE;
  const minioService = process.env.AIQSA_RESTORE_MINIO_SERVICE;
  if (
    !postgresService ||
    !minioService ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(postgresService) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(minioService)
  ) {
    throw new Error("memory_restore_service_identity_invalid");
  }

  let databaseUrl: URL;
  let storageUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    storageUrl = new URL(process.env.S3_ENDPOINT ?? "");
  } catch {
    throw new Error("memory_restore_endpoint_invalid");
  }
  if (
    databaseUrl.protocol !== "postgresql:" ||
    databaseUrl.hostname !== postgresService ||
    storageUrl.protocol !== "http:" ||
    storageUrl.hostname !== minioService
  ) {
    throw new Error("memory_restore_endpoint_not_isolated");
  }
}

async function reopenIncompleteCompletedDeletions(now: Date): Promise<void> {
  await reconcileDefaultCompletedMemoryDeletionAudits();
  const batchSize = 100;
  while (true) {
    const rows = await prisma.memoryDeletionOutbox.findMany({
      orderBy: [{ lastAuditAt: "asc" }, { id: "asc" }],
      select: { id: true, userId: true },
      take: batchSize,
      where: {
        OR: [{ lastAuditAt: null }, { lastAuditAt: { lt: now } }],
        operation: "BULK_CLEAR",
        state: "SUCCEEDED"
      }
    });
    for (const row of rows) {
      await auditMemoryHistoryClearDeletion(row.id, row.userId, prisma, now);
    }
    if (rows.length < batchSize) return;
  }
}

async function main(): Promise<void> {
  assertIsolatedRuntime();
  const storage = createS3StorageAdapter();
  const registry = new MemoryCoordinatorRegistry();
  const permanentChat = createPrismaPermanentChatDeletionHandler(storage, prisma);

  registry.registerDeletion(defaultMemoryDeletionContributorRegistry.handler());
  registry.registerDeletion(
    createPrismaTemporaryChatDeletionHandler(storage, prisma)
  );
  registry.registerDeletion(memoryHistoryClearDeletionHandler);
  registry.registerDeletion(createSourcePurgeDeletionHandler({
    history: memoryHistorySourceDeletionHandler,
    permanentChat
  }));
  registry.registerDeletion(createPrismaAccountMemoryDeletionHandler(prisma));

  await reopenIncompleteCompletedDeletions(new Date());
  const coordinator = new MemoryCoordinator({
    policy: { maxDeletionParallel: 1, maxJobParallel: 1 },
    registry,
    repository: createPrismaMemoryCoordinatorRepository(prisma)
  });
  await coordinator.reconcileNow();
  coordinator.stop();

  const [unresolved, accountObligations] = await Promise.all([
    prisma.memoryDeletionOutbox.count({
      where: {
        state: {
          in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT", "RUNNING"]
        }
      }
    }),
    prisma.memoryDeletionOutbox.count({
      where: { operation: "ACCOUNT_MEMORY_DELETE" }
    })
  ]);
  if (unresolved > 0 || accountObligations > 0) {
    throw new Error("memory_restore_reconciliation_pending");
  }
  console.error("AIQSA restore reconciliation passed.");
}

void main()
  .catch((error: unknown) => {
    const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "memory_restore_reconciliation_failed";
    console.error(`AIQSA restore reconciliation blocked: ${code}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
