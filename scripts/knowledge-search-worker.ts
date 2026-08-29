import { PrismaClient } from "@prisma/client";
import {
  inspectKnowledgeSearchIntegrity,
  rebuildKnowledgeSearchProjections,
  runKnowledgeSearchProjectionPass
} from "../lib/server/knowledge/searchProjection";
import { createKnowledgeOpenSearchTransport } from "../lib/server/search/opensearch/transport";

const prisma = new PrismaClient();
const once = process.argv.includes("--once");
const drain = process.argv.includes("--drain");
const rebuild = process.argv.includes("--rebuild");
const limit = Number.parseInt(
  process.env.AIQSA_KNOWLEDGE_SEARCH_PROJECTION_BATCH ?? "1",
  10
);
const intervalMs = Number.parseInt(
  process.env.AIQSA_KNOWLEDGE_SEARCH_PROJECTION_INTERVAL_MS ?? "2000",
  10
);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 ||
  !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
  throw new Error("knowledge_search_worker_configuration_invalid");
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const search = createKnowledgeOpenSearchTransport();
  if (rebuild) {
    const result = await rebuildKnowledgeSearchProjections({ client: prisma, search });
    console.info(JSON.stringify({ event: "knowledge_search_projection_rebuild", ...result }));
    const integrity = await inspectKnowledgeSearchIntegrity({ client: prisma, search });
    console.info(JSON.stringify({ event: "knowledge_search_integrity", ...integrity }));
    if (result.failed > 0 || !integrity.healthy) {
      throw new Error("knowledge_search_rebuild_integrity_failed");
    }
    return;
  }
  do {
    const result = await runKnowledgeSearchProjectionPass({ client: prisma, limit, search });
    console.info(JSON.stringify({
      event: "knowledge_search_projection_pass",
      ...result
    }));
    if (once || drain && result.claimed === 0 || stopping) return;
    if (!drain) await wait(intervalMs);
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error
      ? error.message
      : "knowledge_search_worker_failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
