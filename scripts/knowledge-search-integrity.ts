import "./worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
import { OpenSearchTransportError } from "../lib/server/search/opensearch/coreTransport";
import { PrismaClient } from "@prisma/client";
import { inspectKnowledgeSearchIntegrity } from "../lib/server/knowledge/searchProjection";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await inspectKnowledgeSearchIntegrity({ client: prisma });
  logEvent("runtime_lifecycle", { subsystem: "knowledge_search", stage: "integrity", outcome: result.healthy ? "completed" : "failed", pending_count: result.incompleteProjectionCount });
  if (!result.healthy) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    logEvent("runtime_lifecycle", { subsystem: "knowledge_search", stage: "integrity", outcome: "failed",
      code: error instanceof OpenSearchTransportError ? error.code : "knowledge_search_integrity_failed", action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
