import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { createPrismaKnowledgeBulkActivationRepository } from
  "../../lib/server/knowledge/bulkActivation";
import type { KnowledgeBulkEmbeddingTarget } from
  "../../lib/server/knowledge/bulkEmbedding";
import { materializeKnowledgeBaseSnapshot } from
  "../../lib/server/knowledge/sourcePersistence";
import { BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT } from "./brightStackOverflowContract";
import { verifyBrightPreparedDataset } from "./brightStackOverflowPrepared";
import {
  activeImportProfile,
  assertDatabaseIdentity,
  dataRoot,
  ensureBenchmarkBase,
  ensureBenchmarkOwner,
  importIdentity
} from "./stageBrightStackOverflowImport";

const preparedRoot = resolve(dataRoot, "prepared/bright-stackoverflow-50m");
const targetEnvironmentAck = "RETAINED_BRIGHT_KB";

export function assertBrightSnapshotCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (argv.length !== 2 || argv[0] !== "--confirm-target" ||
    argv[1] !== "RETAINED" ||
    environment.AIQSA_BRIGHT_BENCHMARK_ACK !== targetEnvironmentAck) {
    throw new Error("bright_stackoverflow_snapshot_confirmation_required");
  }
}

async function main(): Promise<void> {
  assertBrightSnapshotCli(process.argv.slice(2));
  const databaseUrl = process.env.AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("bright_stackoverflow_snapshot_database_missing");
  const manifest = await verifyBrightPreparedDataset(preparedRoot);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assertDatabaseIdentity(prisma);
    const ownerUserId = await ensureBenchmarkOwner(prisma);
    const profile = await activeImportProfile(prisma, ownerUserId);
    const identity = importIdentity(manifest.manifestFingerprint, profile);
    const { baseId, generationId } = await ensureBenchmarkBase({
      importIdentity: identity,
      ownerUserId,
      prisma,
      profile
    });
    const target: KnowledgeBulkEmbeddingTarget = Object.freeze({
      embeddingProviderModelId: profile.embeddingProviderModelId,
      generationId,
      knowledgeBaseId: baseId,
      ownerUserId,
      profileRevisionId: profile.profileRevisionId,
      targetDimension: profile.targetDimension,
      vectorSpaceFingerprint: profile.vectorSpaceFingerprint
    });
    const activation = await createPrismaKnowledgeBulkActivationRepository(prisma)
      .inspect(target);
    if (activation.totalSources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      activation.readySources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      activation.pendingSources !== 0) {
      throw new Error("bright_stackoverflow_snapshot_sources_incomplete");
    }
    const startedAt = performance.now();
    const snapshot = await prisma.$transaction(
      (tx) => materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: generationId,
        knowledgeBaseId: baseId
      }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 300_000
      }
    );
    if (snapshot.sourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      snapshot.readySourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
      throw new Error("bright_stackoverflow_snapshot_settlement_mismatch");
    }
    process.stdout.write(`${JSON.stringify({
      elapsedMs: Math.round(performance.now() - startedAt),
      event: "bright_stackoverflow_snapshot_complete",
      readySourceCount: snapshot.readySourceCount,
      sourceCount: snapshot.sourceCount
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^bright_stackoverflow_snapshot_[a-z0-9_.:-]+$/u.test(message)
    ? message
    : "bright_stackoverflow_snapshot_failed";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: safeFailure(error),
      event: "bright_stackoverflow_snapshot_failed"
    })}\n`);
    process.exitCode = 1;
  });
}
