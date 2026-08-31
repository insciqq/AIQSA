import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { createPrismaEmbeddingRuntime } from
  "../../lib/server/providerRuntime/embeddingRuntime";
import { assertBenchmarkDatabaseUrl } from "./contract";
import {
  LONGMEMEVAL_QUALIFICATION_OPERATOR_USER_ID,
  selectedQualificationEmbeddingDeployment
} from "./probeEmbeddingContract";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const batchSize = 10;

function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "embedding_batch_probe_failed";
  return /^[A-Za-z0-9_:-]{1,160}$/u.test(message)
    ? message
    : "embedding_batch_probe_failed";
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  if (process.env.AIQSA_MEMORY_BENCHMARK_ACK !== "DISPOSABLE_PAID_LONGMEMEVAL" ||
    process.env.AIQSA_MEMORY_EGRESS_CONSENT_MODE !== "ADMIN") {
    throw new Error("embedding_batch_probe_authority_required");
  }
  const port = Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT ?? "55437");
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new Error("embedding_batch_probe_database_port_invalid");
  }
  const databaseUrl = process.env.AIQSA_MEMORY_BENCHMARK_DATABASE_URL ?? "";
  assertBenchmarkDatabaseUrl(databaseUrl, port);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const identity = await prisma.$queryRaw<Array<{ database: string; role: string }>>(
      Prisma.sql`SELECT current_database() AS database, current_user AS role`
    );
    if (identity.length !== 1 ||
      identity[0]?.database !== "aiqsa_memory_benchmark" ||
      identity[0]?.role !== "aiqsa_benchmark") {
      throw new Error("embedding_batch_probe_database_identity_mismatch");
    }
    const [settings, models] = await Promise.all([
      prisma.userMemorySettings.findUnique({
        select: { embeddingProviderModelId: true },
        where: { userId: LONGMEMEVAL_QUALIFICATION_OPERATOR_USER_ID }
      }),
      prisma.providerModel.findMany({
        select: {
          activeConfig: true,
          activeVersion: true,
          connection: { select: { enabled: true, family: true } },
          enabled: true,
          id: true,
          modelClass: true,
          modelId: true
        },
        where: {
          connection: { family: "openrouter" },
          modelClass: "embedding",
          modelId: "qwen/qwen3-embedding-8b"
        }
      })
    ]);
    const model = selectedQualificationEmbeddingDeployment(
      models,
      settings?.embeddingProviderModelId ?? null
    );
    const binding = await createPrismaEmbeddingRuntime(prisma)
      .resolveForInstallation({ providerModelId: model.id });
    const expectedDimension = binding.configuration.embedding?.targetDimension;
    if (!expectedDimension) throw new Error("embedding_batch_probe_model_invalid");
    const startedAt = Date.now();
    const result = await binding.adapter.embed({
      mode: "document",
      texts: Array.from(
        { length: batchSize },
        (_, index) => `AIQSA bounded embedding batch capability probe ${index + 1}`
      )
    });
    const elapsedMs = Date.now() - startedAt;
    if (result.vectors.length !== batchSize ||
      result.vectors.some((vector) => vector.length !== expectedDimension)) {
      throw new Error("embedding_batch_probe_cardinality_mismatch");
    }
    process.stdout.write(`${JSON.stringify({
      batchSize,
      dimension: expectedDimension,
      elapsedMs,
      event: "embedding_batch_probe_complete",
      inputTokens: result.usage.inputTokens,
      requestIdPresent: result.requestId !== null,
      totalTokens: result.usage.totalTokens
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});
