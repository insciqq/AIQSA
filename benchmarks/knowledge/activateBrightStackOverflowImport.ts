import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  createPrismaKnowledgeBulkActivationRepository,
  KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES
} from "../../lib/server/knowledge/bulkActivation";
import type { KnowledgeBulkEmbeddingTarget } from
  "../../lib/server/knowledge/bulkEmbedding";
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
const targetAck = "RETAINED";
const targetEnvironmentAck = "RETAINED_BRIGHT_KB";

type CliOptions = Readonly<{
  batchSize: number;
  inspectOnly: boolean;
  resume: boolean;
}>;

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

export function parseBrightActivationCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): CliOptions {
  let batchSize = KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES;
  let confirmed = false;
  let inspectOnly = false;
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--confirm-target") {
      if (next !== targetAck || confirmed) {
        throw new Error("bright_stackoverflow_activation_confirmation_invalid");
      }
      confirmed = true;
      index += 1;
    } else if (argument === "--batch-size") {
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed < 1 ||
        parsed > KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES) {
        throw new Error("bright_stackoverflow_activation_batch_size_invalid");
      }
      batchSize = parsed;
      index += 1;
    } else if (argument === "--inspect-only") {
      inspectOnly = true;
    } else if (argument === "--resume") {
      resume = true;
    } else {
      throw new Error("bright_stackoverflow_activation_argument_unknown");
    }
  }
  if (!confirmed || environment.AIQSA_BRIGHT_BENCHMARK_ACK !== targetEnvironmentAck ||
    inspectOnly && resume) {
    throw new Error("bright_stackoverflow_activation_confirmation_required");
  }
  return Object.freeze({ batchSize, inspectOnly, resume });
}

function assertInspection(input: Readonly<{
  pendingSources: number;
  readySources: number;
  totalSources: number;
}>): void {
  if (input.totalSources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    input.pendingSources + input.readySources !== input.totalSources) {
    throw new Error("bright_stackoverflow_activation_settlement_mismatch");
  }
}

async function main(): Promise<void> {
  const options = parseBrightActivationCli(process.argv.slice(2));
  const databaseUrl = process.env.AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("bright_stackoverflow_activation_database_missing");
  const manifest = await verifyBrightPreparedDataset(preparedRoot);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  let stopRequested = false;
  const signalHandler = () => {
    if (stopRequested) return;
    stopRequested = true;
    emit("bright_stackoverflow_activation_stop_requested");
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
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
    const repository = createPrismaKnowledgeBulkActivationRepository(prisma);
    const before = await repository.inspect(target);
    assertInspection(before);
    emit("bright_stackoverflow_activation_inspection", before);
    if (options.inspectOnly) return;
    if (!options.resume && before.readySources > 0) {
      throw new Error("bright_stackoverflow_activation_resume_required");
    }
    let activatedSources = 0;
    let batches = 0;
    const startedAt = performance.now();
    while (!stopRequested) {
      const result = await repository.activateNextBatch({
        ...target,
        limit: options.batchSize,
        now: new Date()
      });
      if (result.activatedSources === 0) break;
      activatedSources += result.activatedSources;
      batches += 1;
      if (batches <= 3 || batches % 10 === 0) {
        emit("bright_stackoverflow_activation_progress", {
          activatedSources,
          batches,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      }
    }
    const after = await repository.inspect(target);
    assertInspection(after);
    if (stopRequested) {
      emit("bright_stackoverflow_activation_paused", {
        ...after,
        activatedSources,
        batches,
        elapsedMs: Math.round(performance.now() - startedAt)
      });
      return;
    }
    if (after.readySources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      after.pendingSources !== 0) {
      throw new Error("bright_stackoverflow_activation_settlement_mismatch");
    }
    emit("bright_stackoverflow_activation_complete", {
      ...after,
      activatedSources,
      batches,
      elapsedMs: Math.round(performance.now() - startedAt),
      resumed: options.resume
    });
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    await prisma.$disconnect();
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(?:bright_stackoverflow_activation_|knowledge_bulk_activation_)[a-z0-9_.:-]+$/u
    .test(message)
    ? message
    : "bright_stackoverflow_activation_failed";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: safeFailure(error),
      event: "bright_stackoverflow_activation_failed"
    })}\n`);
    process.exitCode = 1;
  });
}
