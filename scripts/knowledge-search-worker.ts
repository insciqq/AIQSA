import "./worker-bootstrap.cjs";
import { logEvent, reportSubsystemFailure } from "../lib/server/observability";
import { OpenSearchTransportError } from "../lib/server/search/opensearch/coreTransport";
import { PrismaClient } from "@prisma/client";
import {
  inspectKnowledgeSearchIntegrity,
  rebuildKnowledgeSearchProjections,
  runKnowledgeSearchProjectionPass
} from "../lib/server/knowledge/searchProjection";
import {
  createPrismaKnowledgeSearchWorkerHeartbeat,
  runWithKnowledgeSearchWorkerHeartbeat
} from
  "../lib/server/knowledge/searchWorkerHeartbeat";
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
  const heartbeat = createPrismaKnowledgeSearchWorkerHeartbeat(prisma);
  if (rebuild) {
    const result = await rebuildKnowledgeSearchProjections({ client: prisma, search });
    logEvent("runtime_lifecycle", { subsystem: "knowledge_search", stage: "rebuild", outcome: result.failed > 0 ? "failed" : "completed", claimed_count: result.claimed, failed_count: result.failed, completed_count: result.projected });
    const integrity = await inspectKnowledgeSearchIntegrity({ client: prisma, search });
    logEvent("runtime_lifecycle", { subsystem: "knowledge_search", stage: "integrity", outcome: integrity.healthy ? "completed" : "failed", pending_count: integrity.incompleteProjectionCount });
    if (result.failed > 0 || !integrity.healthy) {
      throw new Error("knowledge_search_rebuild_integrity_failed");
    }
    await heartbeat.beat();
    return;
  }
  let heartbeatEstablished = false;
  do {
    const pass = () => runKnowledgeSearchProjectionPass({ client: prisma, limit, search });
    const result = heartbeatEstablished
      ? await runWithKnowledgeSearchWorkerHeartbeat(heartbeat, pass)
      : await pass();
    await heartbeat.beat();
    heartbeatEstablished = true;
    if (result.claimed > 0 || result.failed > 0) {
      logEvent("runtime_lifecycle", { subsystem: "knowledge_search", stage: "projection",
        outcome: result.failed > 0 ? "failed" : "completed", claimed_count: result.claimed,
        failed_count: result.failed, completed_count: result.projected });
    }
    if (once || drain && result.claimed === 0 || stopping) return;
    if (!drain) await wait(intervalMs);
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    reportSubsystemFailure({ subsystem: "knowledge_search", stage: "projection",
      code: error instanceof OpenSearchTransportError ? error.code : "knowledge_search_worker_failed", action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
