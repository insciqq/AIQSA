import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import type { MemoryExecutionAuthorityDependencies } from "../execution";
import type { MemoryJobHandler } from "../coordinator/types";
import { parseMemoryEmbeddingBatchJobFingerprint } from "./contract";
import { createPrismaMemoryEmbeddingBatchHandler } from "./batchHandler";
import { createPrismaMemoryItemEmbeddingHandler } from "./handler";

export function createPrismaMemoryEmbeddingHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    batch?: Parameters<typeof createPrismaMemoryEmbeddingBatchHandler>[2];
    legacy?: Parameters<typeof createPrismaMemoryItemEmbeddingHandler>[2];
  }> = {}
): MemoryJobHandler {
  const legacy = createPrismaMemoryItemEmbeddingHandler(
    authority,
    client,
    options.legacy
  );
  const batch = createPrismaMemoryEmbeddingBatchHandler(
    authority,
    client,
    options.batch
  );
  const selected = (fingerprint: string) =>
    parseMemoryEmbeddingBatchJobFingerprint(fingerprint) ? batch : legacy;
  return Object.freeze({
    kind: "EMBED_ITEMS" as const,
    execute: (job, context) =>
      selected(job.idempotencyFingerprint).execute(job, context),
    preflight: (job) => selected(job.idempotencyFingerprint).preflight(job)
  });
}
