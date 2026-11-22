import "./worker-bootstrap.cjs";
import { maintenanceFailureCode } from "./maintenance-observability";
import { logEvent } from "../lib/server/observability";
import {
  createMemorySourcePurgeDeletionHandler,
  legacyTemporaryChatDeletionHandler
} from "../lib/server/memory/deletionComposition";
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
import { createMemorySavedSecretScrubDeletionHandler } from
  "../lib/server/memory/savedSecretScrub";
import { prisma } from "../lib/server/prisma";
import { reconcileWorkspaceAfterRestore } from
  "../lib/server/workspace/cleanup";

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
  const forbiddenProviderCredential = providerCredentialNames.find(
    (name) => Boolean(process.env[name])
  );
  if (forbiddenProviderCredential) {
    throw new Error(
      `memory_restore_provider_credentials_forbidden_${forbiddenProviderCredential.toLowerCase()}`
    );
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
  const now = new Date();
  const registry = new MemoryCoordinatorRegistry();

  registry.registerDeletion(defaultMemoryDeletionContributorRegistry.handler());
  // Fenced and expired chats are purged by the background worker once the installation starts; their outbox
  // rows complete here as no-ops.
  registry.registerDeletion(legacyTemporaryChatDeletionHandler);
  registry.registerDeletion(memoryHistoryClearDeletionHandler);
  registry.registerDeletion(createMemorySourcePurgeDeletionHandler({
    history: memoryHistorySourceDeletionHandler,
    savedSecretScrub: createMemorySavedSecretScrubDeletionHandler(prisma)
  }));
  registry.registerDeletion(createPrismaAccountMemoryDeletionHandler(prisma));

  await reconcileWorkspaceAfterRestore(prisma, now);
  await reopenIncompleteCompletedDeletions(now);
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
  logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "completed" });
}

void main()
  .catch((error: unknown) => {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "failed", code: maintenanceFailureCode(error, "memory_restore_reconciliation_failed"), action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
